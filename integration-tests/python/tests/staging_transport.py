"""
Shared helpers for running the Python SDK against the staging deployment.

Two things this module handles:

1.  A staging endpoint URL rewriter. ``LedgerClient.register_agent`` and
    ``LedgerClient.resolve_agent_id`` in the published 0.1.0 SDK are pinned to
    ``ENDPOINTS["production"]``. We wrap the default ``HttpxTransport`` with a
    transport that rewrites any stairai.com host to the staging base URL so the
    static-method surface still works in tests without republishing the SDK.

2.  ``resolve_staging_env`` — one place to read ``STAIRAI_STAGING_API_KEY`` /
    ``STAIRAI_STAGING_BASE_URL`` / ``STAIRAI_STAGING_AGENT_NAME`` out of the
    environment.
"""

from __future__ import annotations

import os
import random
import time
from dataclasses import dataclass

from reasoning_ledger import HttpRequest, HttpResponse, HttpTransport, HttpxTransport

DEFAULT_BASE_URL = "https://staging-api.stair-ai.com"
_PROD_HOSTS = (
    "https://api.stairai.com",
    "https://staging.api.stairai.com",
)


def _rewrite_url(url: str, staging_base: str) -> str:
    for host in _PROD_HOSTS:
        if url.startswith(host):
            return staging_base + url[len(host):]
    return url


class StagingTransport:
    """HttpTransport wrapper that rewrites prod-hardcoded URLs to staging."""

    def __init__(self, staging_base: str, inner: HttpTransport | None = None) -> None:
        self._staging_base = staging_base.rstrip("/")
        self._inner: HttpTransport = inner if inner is not None else HttpxTransport()

    def request(self, req: HttpRequest) -> HttpResponse:
        new_req: HttpRequest = {
            "body": req.get("body"),
            "headers": req["headers"],
            "method": req["method"],
            "url": _rewrite_url(req["url"], self._staging_base),
        }
        return self._inner.request(new_req)


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
            "owner-level API key issued against https://staging-api.stair-ai.com. "
            "See integration-tests/README.md."
        )
        raise RuntimeError(msg)

    base_url = os.environ.get("STAIRAI_STAGING_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    default_name = f"it-py-{int(time.time() * 1000)}-{random.randrange(1_000_000)}"  # noqa: S311
    agent_name = os.environ.get("STAIRAI_STAGING_AGENT_NAME", default_name)

    return StagingEnv(agent_name=agent_name, api_key=api_key, base_url=base_url)
