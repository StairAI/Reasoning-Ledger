"""
Cross-SDK writer runner (Python side).

Writes the shared 4-record cross-SDK fixture to the specified session using
the workspace ``reasoning-ledger`` SDK, then prints a JSON object on stdout so
a test in another language can invoke this runner and verify the records via
its own SDK.

Input (env vars):
    STAIRAI_STAGING_API_KEY   required
    STAIRAI_STAGING_BASE_URL  default https://stg-api.stair-ai.com
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

from reasoning_ledger import (
    AgentMetadata,
    LedgerClient,
    LedgerClientConfig,
    RegisterAgentOpts,
    new_record_id,
)

DEFAULT_BASE_URL = "https://stg-api.stair-ai.com"


def main() -> int:
    api_key = os.environ["STAIRAI_STAGING_API_KEY"]
    base_url = os.environ.get("STAIRAI_STAGING_BASE_URL", DEFAULT_BASE_URL)
    agent_name = os.environ["AGENT_NAME"]
    session_id = os.environ["SESSION_ID"]

    reg = LedgerClient.register_agent(
        RegisterAgentOpts(
            api_key=api_key,
            endpoint=base_url,
            name=agent_name,
            metadata=AgentMetadata(
                description="cross-sdk python writer",
                tags=["integration-test", "cross-sdk", "py-writer"],
            ),
        )
    )
    agent_id = reg["agent_id"]

    client = LedgerClient(
        LedgerClientConfig(
            agent_id=agent_id,
            api_key=api_key,
            endpoint=base_url,
        )
    )
    session = client.new_session(session_id)

    # Record IDs chosen up front so the reading side can assert exact matches.
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
            "trigger_source": "cross-sdk",
            "trigger_type": "signal_trigger",
            "trigger_description": "cross-sdk writer",
            "trigger_payload_summary": "cross-sdk",
            "executor": "det",
            "record_phase": "post_execution",
        }
    )
    session.submit(
        {
            "behavior": "ToolCalling",
            "record_id": ids["toolcalling"],
            "upstream_record_id": [ids["observing"]],
            "tool_meta": {"name": "echo"},
            "description": "echo tool",
            # Objects are uploaded by the SDK as application/json content.
            "input_payload": {"query": "cross-sdk", "n": 1},
            "output_payload": {"ok": True},
            "outcome": "success",
            "executor": "det",
            "record_phase": "post_execution",
        }
    )
    session.submit(
        {
            "behavior": "Thinking",
            "record_id": ids["thinking"],
            "upstream_record_id": [ids["toolcalling"]],
            # Strings are uploaded by the SDK as text/plain content.
            "prompt": "Should we act?",
            "inputs": [{"input_record_id": ids["toolcalling"], "input_payload": "echo ok"}],
            "output_payload": "Yes",
            "executor": "ai",
            "record_phase": "post_execution",
        }
    )
    session.submit(
        {
            "behavior": "Acting",
            "record_id": ids["acting"],
            "upstream_record_id": [ids["thinking"]],
            "action_type": "publish",
            "target_system": "noop",
            "action_summary": "cross-sdk act",
            "parameters": {},
            "dry_run": True,
            "execution_status": "simulated",
            "executor": "det",
            "record_phase": "post_execution",
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
