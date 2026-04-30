# reasoning-ledger-sdk

Python SDK for the [Reasoning Ledger](https://github.com/StairAI/Reasoning-Ledger) — a tamper-evident audit trail for AI agent reasoning.

## Install

```bash
pip install reasoning-ledger-sdk
```

Requires Python 3.12+.

## Quick start

```python
from reasoning_ledger_sdk import LedgerClient, LedgerClientConfig

config = LedgerClientConfig(
    api_key="sl_<your-api-key>",
    agent_id="<your-agent-uuid>",
)
client = LedgerClient(config)

# Open a session and submit a reasoning record
session = client.new_session()

session.submit({
    "behavior": "Thinking",
    "prompt": "Should I buy or sell?",
    "inputs": [],
    "output_payload": "Based on the data, I recommend holding.",
})

session.submit({
    "behavior": "Acting",
    "action_type": "trade",
    "target_system": "broker-api",
    "action_summary": "Hold current position",
    "parameters": {"symbol": "AAPL", "action": "hold"},
    "dry_run": False,
    "execution_status": "confirmed",
})
```

## Full documentation

See the [Reasoning Ledger repository](https://github.com/StairAI/Reasoning-Ledger) for the full API reference and design specification.

## License

MIT
