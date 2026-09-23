"""Tests for the content library: put_content / get_content and raw-content auto-upload."""

from __future__ import annotations

import copy
import json
from typing import Any

import httpx
import pytest

from reasoning_ledger import (
    AuthError,
    ContentRef,
    HttpRequest,
    HttpResponse,
    HttpxTransport,
    NotFoundError,
    ServerError,
    ValidationError,
)

from .fakes import API_KEY, ENDPOINT, FakeLedgerServer, err, make_client, sha256_of

TEXT = "text/plain; charset=utf-8"
BINARY = "application/octet-stream"
JSON_TYPE = "application/json"


def thinking(**overrides: Any) -> dict[str, Any]:
    return {
        "behavior": "Thinking",
        "executor": "ai",
        "inputs": [],
        "output_payload": "Yes",
        "prompt": "Should we act?",
        "record_phase": "post_execution",
        "session_id": "s-1",
        **overrides,
    }


def tool_calling(**overrides: Any) -> dict[str, Any]:
    return {
        "behavior": "ToolCalling",
        "description": "echo tool",
        "executor": "det",
        "input_payload": {"query": "cross-sdk", "n": 1},
        "outcome": "success",
        "output_payload": {"ok": True},
        "record_phase": "post_execution",
        "session_id": "s-1",
        "tool_meta": {"name": "echo"},
        **overrides,
    }


def observing() -> dict[str, Any]:
    return {
        "behavior": "Observing",
        "executor": "det",
        "record_phase": "post_execution",
        "session_id": "s-1",
        "trigger_description": "d",
        "trigger_payload_summary": "s",
        "trigger_source": "src",
        "trigger_type": "signal_trigger",
    }


def posted(server: FakeLedgerServer) -> dict[str, Any]:
    (post,) = server.requests("POST", "/v1/records")
    return json.loads(post["body"] or "{}")


# ---------------------------------------------------------------------------
# put_content
# ---------------------------------------------------------------------------


class TestPutContent:
    def test_str_is_uploaded_as_utf8_text(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        data = "héllo wörld".encode()

        ref = client.put_content("héllo wörld")

        (upload,) = server.uploads
        assert upload["url"] == f"{ENDPOINT}/v1/content/{sha256_of(data)}"
        assert upload["headers"]["x-api-key"] == API_KEY
        assert upload["headers"]["content-type"] == TEXT
        assert upload["body"] == data
        assert ref == {"bytes": len(data), "media_type": TEXT, "sha256": sha256_of(data)}

    def test_bytes_are_uploaded_as_octet_stream(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        data = bytes(range(256))

        ref = client.put_content(data)

        assert server.upload_of(data)["headers"]["content-type"] == BINARY
        assert ref == server.ref_for(data, BINARY)

    def test_explicit_media_type(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        ref = client.put_content("# Title", media_type="text/markdown")
        assert server.uploads[0]["headers"]["content-type"] == "text/markdown"
        assert ref["media_type"] == "text/markdown"

    def test_returns_the_servers_reference_when_already_stored(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        first = client.put_content("same", media_type="text/markdown")
        again = client.put_content("same")  # 200: stored earlier with another media type
        assert again == first
        assert again["media_type"] == "text/markdown"

    def test_non_str_non_bytes_raises_before_any_request(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        not_raw: Any = {"not": "raw"}
        with pytest.raises(ValidationError):
            client.put_content(not_raw)
        assert server.calls == []

    def test_413_is_a_clear_validation_error_and_not_retried(self) -> None:
        server = FakeLedgerServer()
        server.put_response = err(413, "content exceeds the 67108864-byte limit")
        client = make_client(server, retry={"attempts": 3, "backoff_ms": [0, 0]})
        with pytest.raises(ValidationError, match="413") as exc_info:
            client.put_content(b"big")
        assert "67108864-byte limit" in str(exc_info.value)
        assert len(server.calls) == 1

    def test_hash_mismatch_400_is_a_validation_error(self) -> None:
        server = FakeLedgerServer()
        server.put_response = err(400, "body hashes to x, not y")
        client = make_client(server)
        with pytest.raises(ValidationError, match="body hashes to"):
            client.put_content("x")

    def test_401_is_an_auth_error(self) -> None:
        server = FakeLedgerServer()
        server.put_response = err(401, "Invalid API key")
        client = make_client(server)
        with pytest.raises(AuthError):
            client.put_content("x")

    def test_retried_like_other_idempotent_calls(self) -> None:
        responses = [err(503, "busy"), err(502, "busy")]
        server = FakeLedgerServer()

        class Flaky:
            def request(self, req: HttpRequest) -> HttpResponse:
                return responses.pop(0) if responses else server.request(req)

        client = make_client(Flaky(), retry={"attempts": 3, "backoff_ms": [0, 0]})
        ref = client.put_content("retry me")
        assert ref["sha256"] == sha256_of(b"retry me")

    def test_gives_up_after_the_configured_attempts(self) -> None:
        server = FakeLedgerServer()
        server.put_response = err(500, "down")
        client = make_client(server, retry={"attempts": 2, "backoff_ms": [0]})
        with pytest.raises(ServerError):
            client.put_content("x")
        assert len(server.calls) == 2


# ---------------------------------------------------------------------------
# get_content
# ---------------------------------------------------------------------------


class TestGetContent:
    def test_by_content_ref_returns_raw_bytes(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        data = b"\x00\xff\xfe binary \x80"
        ref = client.put_content(data)

        assert client.get_content(ref) == data
        get = server.requests("GET", "/v1/content/")[0]
        assert get["url"] == f"{ENDPOINT}/v1/content/{ref['sha256']}"
        assert get["headers"]["x-api-key"] == API_KEY

    def test_by_sha256(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        ref = client.put_content("by hash")
        assert client.get_content(ref["sha256"]) == b"by hash"

    def test_404_is_not_found_with_the_servers_message(self) -> None:
        client = make_client(FakeLedgerServer())
        with pytest.raises(NotFoundError, match="Content not found"):
            client.get_content("0" * 64)

    def test_410_deleted_is_not_found_with_the_servers_message(self) -> None:
        server = FakeLedgerServer()

        class Deleted:
            def request(self, req: HttpRequest) -> HttpResponse:
                server.calls.append(req)
                return err(410, "Content was deleted")

        client = make_client(Deleted(), retry={"attempts": 3, "backoff_ms": [0, 0]})
        with pytest.raises(NotFoundError, match="Content was deleted") as exc_info:
            client.get_content("1" * 64)
        assert exc_info.value.details == {"status": 410}
        assert len(server.calls) == 1  # not retried

    @pytest.mark.parametrize(
        "ref",
        ["A" * 64, "abc", "../records/x", {"media_type": TEXT}, {"sha256": "x"}],
    )
    def test_malformed_reference_raises_before_any_request(self, ref: Any) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        with pytest.raises(ValidationError):
            client.get_content(ref)
        assert server.calls == []

    def test_falls_back_to_text_body_without_body_bytes(self) -> None:
        class TextOnly:
            def request(self, req: HttpRequest) -> HttpResponse:
                return HttpResponse(body="plain text é", headers={}, status=200)

        client = make_client(TextOnly())
        assert client.get_content("2" * 64) == "plain text é".encode()


# ---------------------------------------------------------------------------
# HttpxTransport — carries binary bodies both ways
# ---------------------------------------------------------------------------


class TestHttpxTransport:
    def test_sends_bytes_and_fills_body_bytes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen: dict[str, Any] = {}

        def fake_request(**kwargs: Any) -> httpx.Response:
            seen.update(kwargs)
            return httpx.Response(200, content=b"\x00\xffraw", headers={"x-test": "1"})

        monkeypatch.setattr(httpx, "request", fake_request)
        res = HttpxTransport().request(
            {"body": b"\x01\x02", "headers": {"content-type": BINARY}, "method": "PUT", "url": "u"}
        )
        assert seen["content"] == b"\x01\x02"
        assert res.get("body_bytes") == b"\x00\xffraw"
        assert res["status"] == 200
        assert res["headers"]["x-test"] == "1"


# ---------------------------------------------------------------------------
# Raw content convenience in submit()
# ---------------------------------------------------------------------------


class TestAutoUpload:
    def test_strings_are_uploaded_as_text_before_the_record(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit(thinking())

        methods = [c["method"] for c in server.calls]
        assert methods == ["PUT", "PUT", "POST"]
        record = posted(server)
        assert record["prompt"] == server.ref_for(b"Should we act?", TEXT)
        assert record["output_payload"] == server.ref_for(b"Yes", TEXT)
        assert server.upload_of(b"Should we act?")["headers"]["content-type"] == TEXT

    def test_bytes_are_uploaded_as_octet_stream(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        data = b"\x89PNG\r\n"

        client.submit(tool_calling(output_payload=data))

        assert posted(server)["output_payload"] == server.ref_for(data, BINARY)
        assert server.upload_of(data)["headers"]["content-type"] == BINARY

    def test_json_objects_are_uploaded_as_compact_json(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit(tool_calling(input_payload={"query": "cross-sdk", "n": 1, "city": "Zürich"}))

        data = '{"query":"cross-sdk","n":1,"city":"Zürich"}'.encode()
        assert posted(server)["input_payload"] == server.ref_for(data, JSON_TYPE)
        assert server.upload_of(data)["headers"]["content-type"] == JSON_TYPE

    @pytest.mark.parametrize(
        ("value", "encoded"),
        [([1, "a"], b'[1,"a"]'), (42, b"42"), (2.5, b"2.5"), (False, b"false"), (None, b"null")],
    )
    def test_other_json_values_are_uploaded_as_json(self, value: Any, encoded: bytes) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit(tool_calling(output_payload=value))

        assert posted(server)["output_payload"] == server.ref_for(encoded, JSON_TYPE)

    def test_content_refs_are_left_alone(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        ref = client.put_content('{"already":"stored"}', media_type=JSON_TYPE)
        server.calls.clear()

        client.submit(tool_calling(input_payload=ref, output_payload=dict(ref)))

        assert server.uploads == []
        record = posted(server)
        assert record["input_payload"] == ref
        assert record["output_payload"] == ref

    @pytest.mark.parametrize(
        "lookalike",
        [
            {"bytes": 3, "media_type": TEXT, "sha256": "a" * 64, "extra": 1},
            {"bytes": 3, "media_type": TEXT, "sha256": "A" * 64},
            {"bytes": 3, "media_type": TEXT},
            {"bytes": True, "media_type": TEXT, "sha256": "a" * 64},
            {"bytes": -1, "media_type": TEXT, "sha256": "a" * 64},
            {"bytes": 3, "media_type": 7, "sha256": "a" * 64},
        ],
    )
    def test_only_exact_content_refs_count(self, lookalike: dict[str, Any]) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit(tool_calling(input_payload=lookalike))

        data = json.dumps(lookalike, separators=(",", ":"), ensure_ascii=False).encode()
        assert posted(server)["input_payload"] == server.ref_for(data, JSON_TYPE)

    def test_nested_positions_are_uploaded(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        upstream = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"

        client.submit(
            thinking(
                inputs=[{"input_record_id": upstream, "input_payload": "echo ok"}],
                model_invocation={
                    "internal_reasoning": "chain of thought",
                    "model_name": "m",
                    "provider": "p",
                },
            )
        )

        record = posted(server)
        assert record["inputs"] == [
            {"input_payload": server.ref_for(b"echo ok", TEXT), "input_record_id": upstream}
        ]
        internal = record["model_invocation"]["internal_reasoning"]
        assert internal == server.ref_for(b"chain of thought", TEXT)

    def test_reflecting_positions_are_uploaded(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit(
            {
                "behavior": "Reflecting",
                "executor": "ai",
                "inputs": [{"input_payload": {"score": 0.4}}],
                "output_payload": "lower the threshold",
                "record_phase": "post_execution",
                "session_id": "s-1",
            }
        )

        record = posted(server)
        assert record["output_payload"] == server.ref_for(b"lower the threshold", TEXT)
        assert record["inputs"][0]["input_payload"] == server.ref_for(b'{"score":0.4}', JSON_TYPE)

    def test_default_model_invocation_is_uploaded_without_mutating_config(self) -> None:
        server = FakeLedgerServer()
        default = {"internal_reasoning": "why", "model_name": "m", "provider": "p"}
        client = make_client(server, default_model_invocation=default)

        client.submit(observing())

        internal = posted(server)["model_invocation"]["internal_reasoning"]
        assert internal == server.ref_for(b"why", TEXT)
        assert default["internal_reasoning"] == "why"

    def test_caller_input_is_not_mutated(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        record = thinking(
            inputs=[{"input_payload": {"k": [1, 2]}}],
            model_invocation={"internal_reasoning": "r", "model_name": "m", "provider": "p"},
        )
        snapshot = copy.deepcopy(record)

        client.submit(record)

        assert record == snapshot

    def test_identical_content_is_uploaded_once(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit(thinking(prompt="same", output_payload="same"))

        assert len(server.uploads) == 1
        record = posted(server)
        assert record["prompt"] == record["output_payload"]

    def test_failed_upload_fails_the_submit(self) -> None:
        server = FakeLedgerServer()
        server.put_response = err(413, "too large")
        client = make_client(server)

        with pytest.raises(ValidationError, match="413"):
            client.submit(thinking())

        assert server.requests("POST") == []

    def test_invalid_record_raises_before_any_upload(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        record = thinking()
        del record["executor"]

        with pytest.raises(ValidationError):
            client.submit(record)

        assert server.calls == []

    def test_unserializable_value_raises_before_any_request(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        with pytest.raises(ValidationError, match="output_payload"):
            client.submit(tool_calling(output_payload={"when": object()}))

        assert server.calls == []

    def test_session_submit_uploads_too(self) -> None:
        server = FakeLedgerServer()
        session = make_client(server).new_session("bound")

        session.submit(thinking(session_id=None))

        record = posted(server)
        assert record["session_id"] == "bound"
        assert record["prompt"] == server.ref_for(b"Should we act?", TEXT)


# ---------------------------------------------------------------------------
# Raw content convenience in submit_batch()
# ---------------------------------------------------------------------------


class TestBatchUploads:
    def test_uploads_precede_the_batch_post_to_records_batch(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        ack = client.submit_batch([observing(), tool_calling(), thinking()])

        assert [c["method"] for c in server.calls] == ["PUT", "PUT", "PUT", "PUT", "POST"]
        (post,) = server.requests("POST")
        assert post["url"] == f"{ENDPOINT}/v1/records/batch"
        records = json.loads(post["body"] or "{}")["records"]
        assert records[1]["input_payload"] == server.ref_for(
            b'{"query":"cross-sdk","n":1}', JSON_TYPE
        )
        assert records[2]["prompt"] == server.ref_for(b"Should we act?", TEXT)
        assert len(ack["results"]) == 3

    def test_invalid_records_are_reported_and_their_content_not_uploaded(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        invalid = thinking(prompt="never uploaded")
        del invalid["record_phase"]

        ack = client.submit_batch([tool_calling(), invalid])

        assert all(u["body"] != b"never uploaded" for u in server.uploads)
        assert ack["results"][1].get("code") == "validation_failed"
        (post,) = server.requests("POST")
        assert len(json.loads(post["body"] or "{}")["records"]) == 1

    def test_failed_upload_raises_before_the_batch_is_posted(self) -> None:
        server = FakeLedgerServer()
        server.put_response = err(500, "store down")
        client = make_client(server)

        with pytest.raises(ServerError):
            client.submit_batch([observing(), thinking()])

        assert server.requests("POST") == []

    def test_unserializable_value_names_the_record(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        with pytest.raises(ValidationError, match=r"records\[1\]"):
            client.submit_batch([observing(), tool_calling(input_payload={1, 2})])

        assert server.calls == []

    def test_session_batch_uploads_too(self) -> None:
        server = FakeLedgerServer()
        session = make_client(server).new_session("bound")

        session.submit_batch([thinking(), thinking(prompt="second")])

        assert {u["body"] for u in server.uploads} == {b"Should we act?", b"Yes", b"second"}
        assert all(r["session_id"] == "bound" for r in server.records)


def test_content_ref_type_is_exported() -> None:
    assert ContentRef.__required_keys__ == frozenset({"sha256", "bytes", "media_type"})
