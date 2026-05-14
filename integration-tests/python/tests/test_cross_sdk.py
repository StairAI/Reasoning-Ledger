"""
Cross-SDK synergy from the Python side.

The TypeScript SDK writes a deterministic 4-record decision cycle via the
``cross-sdk/runners/typescript_writer.ts`` runner; this test then uses the
Python SDK to read those records back and verify integrity.

Skipped unless staging credentials AND a working ``tsx`` CLI are available on
PATH. Override with the ``TSX_BIN`` env var if it lives somewhere non-standard.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from reasoning_ledger import LedgerClient, LedgerClientConfig

from .conftest import requires_staging
from .staging_transport import StagingTransport, resolve_staging_env

pytestmark = [requires_staging]

TSX_BIN = os.environ.get("TSX_BIN", "tsx")
RUNNER = (
    Path(__file__).resolve().parent.parent.parent / "cross-sdk" / "runners" / "typescript_writer.ts"
)


def _tsx_available() -> bool:
    if shutil.which(TSX_BIN) is None:
        # Fall back to `pnpm tsx` if the bare binary isn't on PATH.
        return shutil.which("pnpm") is not None
    return True


@pytest.fixture(scope="module")
def ts_writer_output() -> dict[str, object]:
    if not _tsx_available():
        pytest.skip("neither 'tsx' nor 'pnpm' is on PATH; skipping cross-SDK test")

    if not RUNNER.exists():
        pytest.skip(f"typescript writer runner not found at {RUNNER}")

    env = os.environ.copy()
    env["AGENT_NAME"] = f"it-xsdk-ts2py-{int(time.time() * 1000)}"
    env["SESSION_ID"] = f"xsdk-ts2py-{int(time.time() * 1000)}"

    # Prefer bare `tsx`, fall back to `pnpm tsx <runner>` from the ts test dir
    # so workspace resolution for reasoning-ledger-sdk works.
    if shutil.which(TSX_BIN) is not None:
        cmd = [TSX_BIN, str(RUNNER)]
    else:
        cmd = ["pnpm", "--dir", str(RUNNER.parent.parent.parent / "typescript"), "exec", "tsx", str(RUNNER)]

    result = subprocess.run(  # noqa: S603
        cmd,
        env=env,
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

    last_line = result.stdout.strip().splitlines()[-1]
    return json.loads(last_line)


@pytest.fixture(scope="module")
def read_client(ts_writer_output: dict[str, object]) -> LedgerClient:
    env = resolve_staging_env()
    transport = StagingTransport(env.base_url)
    return LedgerClient(
        LedgerClientConfig(
            agent_id=str(ts_writer_output["agent_id"]),
            api_key=env.api_key,
            endpoint=env.base_url,
            http_transport=transport,
        )
    )


class TestTsWritesPyReads:
    def test_writer_output_shape(self, ts_writer_output: dict[str, object]) -> None:
        assert "agent_id" in ts_writer_output
        assert "session_id" in ts_writer_output
        records = ts_writer_output["records"]
        assert isinstance(records, dict)
        assert set(records.keys()) == {"observing", "toolcalling", "thinking", "acting"}

    def test_get_record_for_each_record_id(
        self,
        read_client: LedgerClient,
        ts_writer_output: dict[str, object],
    ) -> None:
        records = ts_writer_output["records"]
        assert isinstance(records, dict)
        expected_behavior = {
            "observing": "Observing",
            "toolcalling": "ToolCalling",
            "thinking": "Thinking",
            "acting": "Acting",
        }
        for kind, rid in records.items():
            record = read_client.get_record(str(rid))
            assert record["record_id"] == rid
            assert record["session_id"] == ts_writer_output["session_id"]
            assert record["agent_id"] == ts_writer_output["agent_id"]
            assert record["behavior"] == expected_behavior[kind]

    def test_get_session_returns_all_four_in_order(
        self,
        read_client: LedgerClient,
        ts_writer_output: dict[str, object],
    ) -> None:
        records = ts_writer_output["records"]
        assert isinstance(records, dict)
        fetched = read_client.get_session(str(ts_writer_output["session_id"]))
        assert fetched["session_id"] == ts_writer_output["session_id"]
        assert len(fetched["records"]) == 4

        order = [r["record_id"] for r in fetched["records"]]
        assert order == [
            records["observing"],
            records["toolcalling"],
            records["thinking"],
            records["acting"],
        ]

    def test_toolcalling_upstream_edge_survives(
        self,
        read_client: LedgerClient,
        ts_writer_output: dict[str, object],
    ) -> None:
        records = ts_writer_output["records"]
        assert isinstance(records, dict)
        tc = read_client.get_record(str(records["toolcalling"]))
        assert tc["upstream_record_id"] == [records["observing"]]

        payload = json.loads(str(tc["input_payload"]))
        assert payload == {"from": "typescript"}
