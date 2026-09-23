"""
Cross-SDK synergy from the Python side.

The TypeScript SDK writes the shared 4-record cross-SDK fixture via the
``cross-sdk/runners/typescript_writer.ts`` runner; this test then uses the
Python SDK to read those records, and their content, back.

Skipped unless an API key is set AND ``tsx`` or ``pnpm`` is available on PATH.
Override the ``tsx`` binary with the ``TSX_BIN`` env var if it lives somewhere
non-standard.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from reasoning_ledger import LedgerClient, LedgerClientConfig

from .conftest import requires_staging
from .staging_env import resolve_staging_env

pytestmark = [requires_staging]

TSX_BIN = os.environ.get("TSX_BIN", "tsx")
RUNNER = (
    Path(__file__).resolve().parent.parent.parent / "cross-sdk" / "runners" / "typescript_writer.ts"
)
STEPS = ("observing", "toolcalling", "thinking", "acting")


@dataclass(frozen=True)
class WriterOutput:
    agent_id: str
    session_id: str
    # record_id per step: observing, toolcalling, thinking, acting.
    records: dict[str, str]


def _tsx_available() -> bool:
    if shutil.which(TSX_BIN) is None:
        # Fall back to `pnpm tsx` if the bare binary isn't on PATH.
        return shutil.which("pnpm") is not None
    return True


@pytest.fixture(scope="module")
def ts_writer_output() -> WriterOutput:
    if not _tsx_available():
        pytest.skip("neither 'tsx' nor 'pnpm' is on PATH; skipping cross-SDK test")

    if not RUNNER.exists():
        pytest.skip(f"typescript writer runner not found at {RUNNER}")

    env = os.environ.copy()
    env["AGENT_NAME"] = f"it-xsdk-ts2py-{int(time.time() * 1000)}"
    env["SESSION_ID"] = f"xsdk-ts2py-{int(time.time() * 1000)}"

    # Always use `pnpm tsx` from the ts test dir so workspace resolution for
    # reasoning-ledger-sdk works. The bare `tsx` binary won't find workspace packages.
    # Run from the typescript integration tests directory so node_modules resolution works.
    ts_test_dir = RUNNER.parent.parent.parent / "typescript"
    cmd = ["pnpm", "exec", "tsx", str(RUNNER)]

    # Set NODE_PATH so Node.js can find the reasoning-ledger-sdk package installed
    # in integration-tests/typescript/node_modules even though we're executing a file
    # from integration-tests/cross-sdk/runners/
    env["NODE_PATH"] = str(ts_test_dir / "node_modules")

    result = subprocess.run(  # noqa: S603
        cmd,
        env=env,
        cwd=str(ts_test_dir),
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        msg = (
            f"typescript_writer exited {result.returncode}\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )
        raise RuntimeError(msg)

    out = json.loads(result.stdout.strip().splitlines()[-1])
    assert out["session_id"] == env["SESSION_ID"]
    return WriterOutput(
        agent_id=str(out["agent_id"]),
        session_id=str(out["session_id"]),
        records={str(step): str(rid) for step, rid in out["records"].items()},
    )


@pytest.fixture(scope="module")
def read_client(ts_writer_output: WriterOutput) -> LedgerClient:
    env = resolve_staging_env()
    return LedgerClient(
        LedgerClientConfig(
            agent_id=ts_writer_output.agent_id,
            api_key=env.api_key,
            endpoint=env.base_url,
        )
    )


class TestTsWritesPyReads:
    def test_writer_output_shape(self, ts_writer_output: WriterOutput) -> None:
        assert set(ts_writer_output.records) == set(STEPS)

    def test_get_record_for_each_record_id(
        self, read_client: LedgerClient, ts_writer_output: WriterOutput
    ) -> None:
        expected_behavior = {
            "observing": "Observing",
            "toolcalling": "ToolCalling",
            "thinking": "Thinking",
            "acting": "Acting",
        }
        for step, rid in ts_writer_output.records.items():
            record = read_client.get_record(rid)
            assert record["record_id"] == rid
            assert record["agent_id"] == ts_writer_output.agent_id
            assert record["session_id"] == ts_writer_output.session_id
            assert record["behavior"] == expected_behavior[step]

    def test_get_session_returns_all_four_in_write_order(
        self, read_client: LedgerClient, ts_writer_output: WriterOutput
    ) -> None:
        fetched = read_client.get_session(ts_writer_output.session_id)
        assert fetched["session_id"] == ts_writer_output.session_id
        assert [r["record_id"] for r in fetched["records"]] == [
            ts_writer_output.records[step] for step in STEPS
        ]

    def test_toolcalling_upstream_edge_survives(
        self, read_client: LedgerClient, ts_writer_output: WriterOutput
    ) -> None:
        tc = read_client.get_record(ts_writer_output.records["toolcalling"])
        assert tc["upstream_record_id"] == [ts_writer_output.records["observing"]]

    def test_toolcalling_input_payload_is_the_uploaded_json(
        self, read_client: LedgerClient, ts_writer_output: WriterOutput
    ) -> None:
        tc = read_client.get_record(ts_writer_output.records["toolcalling"])
        payload = json.loads(read_client.get_content(tc["input_payload"]))
        assert payload == {"query": "cross-sdk", "n": 1}

    def test_thinking_prompt_is_the_uploaded_text(
        self, read_client: LedgerClient, ts_writer_output: WriterOutput
    ) -> None:
        th = read_client.get_record(ts_writer_output.records["thinking"])
        assert read_client.get_content(th["prompt"]).decode("utf-8") == "Should we act?"
