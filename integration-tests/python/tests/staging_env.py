"""
Environment for the Python integration tests.

``resolve_staging_env`` is the one place that reads the target server out of
the environment:

- ``STAIRAI_STAGING_API_KEY``    owner-level API key (required)
- ``STAIRAI_STAGING_BASE_URL``   server base URL, default https://stg-api.stair-ai.com
- ``STAIRAI_STAGING_AGENT_NAME`` agent name, default a fresh one per run

The base URL is passed to the SDK as ``endpoint`` everywhere.
"""

from __future__ import annotations

import os
import random
import time
from dataclasses import dataclass

DEFAULT_BASE_URL = "https://stg-api.stair-ai.com"


@dataclass(kw_only=True)
class StagingEnv:
    api_key: str
    base_url: str
    agent_name: str


def resolve_staging_env() -> StagingEnv:
    api_key = os.environ.get("STAIRAI_STAGING_API_KEY")
    if not api_key:
        msg = (
            "STAIRAI_STAGING_API_KEY is not set. Integration tests require an "
            "owner-level API key issued against https://stg-api.stair-ai.com. "
            "See integration-tests/README.md."
        )
        raise RuntimeError(msg)

    base_url = os.environ.get("STAIRAI_STAGING_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    default_name = f"it-py-{int(time.time() * 1000)}-{random.randrange(1_000_000)}"  # noqa: S311
    agent_name = os.environ.get("STAIRAI_STAGING_AGENT_NAME", default_name)

    return StagingEnv(agent_name=agent_name, api_key=api_key, base_url=base_url)
