"""Pytest fixtures shared by the Python integration tests."""

from __future__ import annotations

import os

import pytest

from reasoning_ledger import AgentMetadata, LedgerClient, LedgerClientConfig, RegisterAgentOpts

from .staging_env import StagingEnv, resolve_staging_env

# Every test module applies this marker: the suites need a running server and
# an owner API key, and skip without one.
requires_staging = pytest.mark.skipif(
    not os.environ.get("STAIRAI_STAGING_API_KEY"),
    reason="STAIRAI_STAGING_API_KEY not set; integration tests skipped.",
)


@pytest.fixture(scope="session")
def staging_env() -> StagingEnv:
    return resolve_staging_env()


@pytest.fixture(scope="session")
def agent_id(staging_env: StagingEnv) -> str:
    """Register (or resolve) the test agent once per session."""
    reg = LedgerClient.register_agent(
        RegisterAgentOpts(
            api_key=staging_env.api_key,
            endpoint=staging_env.base_url,
            name=staging_env.agent_name,
            metadata=AgentMetadata(
                description="integration-tests/python lifecycle run",
                tags=["integration-test", "py"],
            ),
        )
    )
    return reg["agent_id"]


@pytest.fixture(scope="session")
def client(staging_env: StagingEnv, agent_id: str) -> LedgerClient:
    return LedgerClient(
        LedgerClientConfig(
            agent_id=agent_id,
            api_key=staging_env.api_key,
            endpoint=staging_env.base_url,
        )
    )
