"""Pytest fixtures shared by the Python staging integration tests."""

from __future__ import annotations

import os
import time
from collections.abc import Iterator

import pytest

from reasoning_ledger import (
    AuthError,
    LedgerClient,
    LedgerClientConfig,
    RegisterAgentOpts,
)
from reasoning_ledger.types import AgentMetadata

from .staging_transport import StagingEnv, StagingTransport, resolve_staging_env

STAGING_API_KEY = os.environ.get("STAIRAI_STAGING_API_KEY")

# Skip the whole module when the staging key is missing. We set this as a
# pytest-level skip marker that test modules can import.
requires_staging = pytest.mark.skipif(
    STAGING_API_KEY is None,
    reason="STAIRAI_STAGING_API_KEY not set; staging integration tests skipped.",
)


@pytest.fixture(scope="session")
def staging_env() -> StagingEnv:
    return resolve_staging_env()


@pytest.fixture(scope="session")
def staging_transport(staging_env: StagingEnv) -> StagingTransport:
    return StagingTransport(staging_env.base_url)


@pytest.fixture(scope="session")
def agent_id(staging_env: StagingEnv, staging_transport: StagingTransport) -> str:
    """Register (or resolve) the test agent once per session."""
    reg = LedgerClient.register_agent(
        RegisterAgentOpts(
            api_key=staging_env.api_key,
            name=staging_env.agent_name,
            metadata=AgentMetadata(
                description="integration-tests/python lifecycle run",
                tags=["integration-test", "py"],
            ),
        ),
        _transport=staging_transport,
    )
    return reg["agent_id"]


@pytest.fixture(scope="session")
def client(
    staging_env: StagingEnv,
    staging_transport: StagingTransport,
    agent_id: str,
) -> LedgerClient:
    return LedgerClient(
        LedgerClientConfig(
            agent_id=agent_id,
            api_key=staging_env.api_key,
            endpoint=staging_env.base_url,
            http_transport=staging_transport,
        )
    )


@pytest.fixture(scope="session")
def session_id() -> str:
    return f"it-py-session-{int(time.time() * 1000)}"


@pytest.fixture(scope="session")
def submitted_record_ids() -> Iterator[list[str]]:
    """Mutable list that lifecycle tests append to as they submit records."""
    ids: list[str] = []
    yield ids


# Re-export AuthError for tests that need to verify error mapping.
__all__ = [
    "AuthError",
    "client",
    "agent_id",
    "session_id",
    "submitted_record_ids",
    "staging_env",
    "staging_transport",
    "requires_staging",
]
