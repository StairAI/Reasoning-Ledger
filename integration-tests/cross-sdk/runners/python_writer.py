"""
Cross-SDK writer runner (Python side).

Writes a deterministic 4-record decision cycle to the specified session using
the published ``reasoning-ledger`` PyPI SDK, then prints a JSON object on
stdout so a test in another language can invoke this runner and verify the
records via its own SDK.

Input (env vars):
    STAIRAI_STAGING_API_KEY   required
    STAIRAI_STAGING_BASE_URL  default https://staging-api.stair-ai.com
    AGENT_NAME                required (already registered or will be created)
    SESSION_ID                required

Output (stdout, exactly one line, JSON):
    {
      "agent_id":   "<uuid>",
      "session_id": "<session id>",
      "records": {
        "observing":   "<record_id>",
        "toolcalling": "<record_id>",
        "thinking":    "<record_id>",
        "acting":      "<record_id>"
      }
    }

Errors go to stderr and the process exits non-zero.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Allow running as `python python_writer.py` from this directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "python" / "tests"))

from staging_transport import StagingTransport  # noqa: E402

from reasoning_ledger import (  # noqa: E402
    LedgerClient,
    LedgerClientConfig,
    RegisterAgentOpts,
    new_record_id,
)
from reasoning_ledger.types import AgentMetadata  # noqa: E402


def main() -> int:
    api_key = os.environ["STAIRAI_STAGING_API_KEY"]
    base_url = os.environ.get("STAIRAI_STAGING_BASE_URL", "https://staging-api.stair-ai.com")
    agent_name = os.environ["AGENT_NAME"]
    session_id = os.environ["SESSION_ID"]

    transport = StagingTransport(base_url)

    reg = LedgerClient.register_agent(
        RegisterAgentOpts(
            api_key=api_key,
            name=agent_name,
            metadata=AgentMetadata(
                description="cross-sdk python writer",
                tags=["integration-test", "cross-sdk", "py-writer"],
            ),
        ),
        _transport=transport,
    )
    agent_id = reg["agent_id"]

    client = LedgerClient(
        LedgerClientConfig(
            agent_id=agent_id,
            api_key=api_key,
            endpoint=base_url,
            http_transport=transport,
        )
    )
    session = client.new_session(session_id)

    # Deterministic record IDs so the reading side can assert exact match.
    ids = {
        "observing": new_record_id(),
        "toolcalling": new_record_id(),
        "thinking": new_record_id(),
        "acting": new_record_id(),
    }

    session.submit(
        {
            "behavior": "Observing",
            "record_id": ids["observing"],
            "trigger_description": "py-writer: deterministic probe",
            "trigger_payload_summary": "probe=py",
            "trigger_source": "cross-sdk",
            "trigger_type": "signal_trigger",
        }
    )
    session.submit(
        {
            "behavior": "ToolCalling",
            "record_id": ids["toolcalling"],
            "tool_meta": {"tool_id": "probe-tool", "category": "external_api"},
            "description": "py-writer tool call",
            "input_payload": json.dumps({"from": "python"}),
            "output_payload": json.dumps({"ok": True}),
            "success": True,
            "upstream_record_id": [ids["observing"]],
        }
    )
    session.submit(
        {
            "behavior": "Thinking",
            "record_id": ids["thinking"],
            "prompt": "py-writer thinking",
            "inputs": [],
            "output_payload": json.dumps({"decision": "hold"}),
        }
    )
    session.submit(
        {
            "behavior": "Acting",
            "record_id": ids["acting"],
            "action_type": "noop",
            "target_system": "cross-sdk",
            "action_summary": "py-writer acting",
            "parameters": {"source": "python"},
            "dry_run": True,
            "execution_status": "confirmed",
        }
    )

    print(
        json.dumps(
            {
                "agent_id": agent_id,
                "session_id": session_id,
                "records": ids,
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
