"""Content encryption: keys, formats, and what the client does with them."""

from __future__ import annotations

import base64
import hashlib
import os
import stat
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest
from cryptography.exceptions import InvalidTag

from reasoning_ledger import ContentEncryption, LedgerClient
from reasoning_ledger.content import is_content_ref
from reasoning_ledger.encryption import (
    ENCRYPTED_MEDIA_TYPE,
    generate_master_key,
    load_master_key,
    master_key_fragment,
    master_key_from_fragment,
    master_key_id,
    open_sealed,
    save_master_key,
    seal,
)
from reasoning_ledger.errors import ValidationError
from reasoning_ledger.validate import validate_record

from .fakes import AGENT_ID, FakeLedgerServer, make_client

TEXT = "text/plain; charset=utf-8"


def thinking(**fields: Any) -> dict[str, Any]:
    return {
        "behavior": "Thinking",
        "executor": "ai",
        "record_phase": "post_execution",
        "session_id": "sess-enc",
        "model_invocation": {"provider": "test", "model_name": "m"},
        "output_payload": "the secret answer",
        "outcome": "success",
        **fields,
    }


def paths(server: FakeLedgerServer, method: str | None = None) -> list[str]:
    return [
        urlsplit(c["url"]).path for c in server.calls if method is None or c["method"] == method
    ]


# ---------------------------------------------------------------------------
# Primitives and the master key file
# ---------------------------------------------------------------------------


def test_seal_and_open_round_trip_and_bind_the_key_id() -> None:
    key = os.urandom(32)
    blob = seal(key, b"plain", "key-1")
    assert len(blob) == 12 + 5 + 16
    assert open_sealed(key, blob, "key-1") == b"plain"
    with pytest.raises(InvalidTag):
        open_sealed(key, blob, "key-2")
    with pytest.raises(InvalidTag):
        open_sealed(os.urandom(32), blob, "key-1")
    with pytest.raises(ValueError, match="too short"):
        open_sealed(key, b"x", "key-1")


def test_master_key_file_is_private_and_round_trips(tmp_path: Path) -> None:
    key = generate_master_key()
    target = tmp_path / "keys" / "master.key"
    save_master_key(target, key)
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert load_master_key(target) == key
    with pytest.raises(FileExistsError):
        save_master_key(target, key)
    hex_file = tmp_path / "hex.key"
    hex_file.write_text(key.hex() + "\n")
    assert load_master_key(hex_file) == key
    fragment = master_key_fragment(key)
    assert "=" not in fragment and len(fragment) == 43
    assert master_key_from_fragment(fragment) == key
    assert master_key_id(key) == hashlib.sha256(key).hexdigest()[:16]
    with pytest.raises(ValueError, match="32 bytes"):
        ContentEncryption(master_key=b"short")


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------


def test_content_is_encrypted_before_upload_and_the_key_registered_first() -> None:
    server = FakeLedgerServer()
    encryption = ContentEncryption(master_key=generate_master_key(), agent_id=AGENT_ID)
    client = make_client(server, encryption=encryption)

    client.submit(thinking())

    record = server.records[0]
    ref = record["output_payload"]
    assert is_content_ref(ref)
    assert ref["media_type"] == ENCRYPTED_MEDIA_TYPE
    enc = ref["enc"]
    plaintext = b"the secret answer"
    assert enc == {
        "alg": "A256GCM",
        "key_id": enc["key_id"],
        "plaintext_bytes": len(plaintext),
        "plaintext_media_type": TEXT,
        "plaintext_sha256": hashlib.sha256(plaintext).hexdigest(),
    }
    # The ledger got ciphertext, named by its own hash, and never the plaintext.
    (upload,) = server.uploads
    body = upload["body"]
    assert isinstance(body, bytes)
    assert body != plaintext and plaintext not in body
    assert hashlib.sha256(body).hexdigest() == ref["sha256"]
    assert ref["bytes"] == len(body) == len(plaintext) + 12 + 16
    # The wrapped key went up before the content, under the session.
    key_id = enc["key_id"]
    assert paths(server)[:2] == [f"/v1/content-keys/{key_id}", f"/v1/content/{ref['sha256']}"]
    wrapped = server.content_keys[key_id]
    assert wrapped["session_id"] == "sess-enc" and wrapped["agent_id"] == AGENT_ID
    assert wrapped["master_key_id"] == encryption.master_key_id
    assert len(base64.b64decode(wrapped["wrapped_key"])) == 60
    # What the server stores validates as a 0.5 record.
    validate_record(record)
    # Reading it back through the client opens it again.
    assert client.open_content(ref) == plaintext


def test_one_data_key_per_session_registered_once() -> None:
    server = FakeLedgerServer()
    client = make_client(server, encryption=ContentEncryption(master_key=generate_master_key()))

    client.submit(thinking(output_payload="first"))
    client.submit(thinking(output_payload="second"))
    client.submit(thinking(output_payload="elsewhere", session_id="sess-other"))

    keys = [r["output_payload"]["enc"]["key_id"] for r in server.records]
    assert keys[0] == keys[1] != keys[2]
    assert paths(server, "PUT").count(f"/v1/content-keys/{keys[0]}") == 1
    assert len(server.content_keys) == 2


def test_a_batch_encrypts_every_content_position() -> None:
    server = FakeLedgerServer()
    client = make_client(server, encryption=ContentEncryption(master_key=generate_master_key()))
    ack = client.submit_batch(
        [
            thinking(prompt="why?", output_payload={"answer": 42}),
            {
                "behavior": "ToolCalling",
                "executor": "ai",
                "record_phase": "post_execution",
                "session_id": "sess-enc",
                "tool_meta": {"name": "grep"},
                "input_payload": {"pattern": "x"},
                "output_payload": "3 matches",
                "outcome": "success",
            },
        ]
    )
    assert all("record_id" in r for r in ack["results"])
    refs = [
        server.records[0]["prompt"],
        server.records[0]["output_payload"],
        server.records[1]["input_payload"],
        server.records[1]["output_payload"],
    ]
    assert all(r["media_type"] == ENCRYPTED_MEDIA_TYPE and "enc" in r for r in refs)
    assert refs[1]["enc"]["plaintext_media_type"] == "application/json"
    assert refs[1]["enc"]["plaintext_bytes"] == len(b'{"answer":42}')


def test_without_encryption_nothing_changes_and_opening_encrypted_content_is_refused() -> None:
    server = FakeLedgerServer()
    plain_client = make_client(server)
    plain_client.submit(thinking())
    ref = server.records[0]["output_payload"]
    assert "enc" not in ref and ref["media_type"] == TEXT
    assert plain_client.open_content(ref) == b"the secret answer"

    encrypted = make_client(server, encryption=ContentEncryption(master_key=generate_master_key()))
    encrypted.submit(thinking())
    secret_ref = server.records[1]["output_payload"]
    with pytest.raises(ValidationError, match="no encryption configured"):
        plain_client.open_content(secret_ref)
    stranger = make_client(server, encryption=ContentEncryption(master_key=generate_master_key()))
    with pytest.raises(ValueError, match="wrapped with master key"):
        stranger.open_content(secret_ref)


def test_a_reference_with_enc_is_still_a_reference() -> None:
    ref = {"sha256": "a" * 64, "bytes": 3, "media_type": ENCRYPTED_MEDIA_TYPE}
    assert is_content_ref(ref)
    assert is_content_ref({**ref, "enc": {"alg": "A256GCM"}})
    assert not is_content_ref({**ref, "enc": "A256GCM"})
    assert not is_content_ref({**ref, "extra": 1})
    assert isinstance(LedgerClient, type)
