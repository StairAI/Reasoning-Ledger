"""
Encrypted content end to end: the SDK encrypts on this machine, the server
keeps ciphertext and a wrapped key it cannot open, the SDK reads it back.
"""

from __future__ import annotations

import hashlib
import uuid

import pytest

from reasoning_ledger import (
    ContentEncryption,
    LedgerClient,
    LedgerClientConfig,
    ValidationError,
    generate_master_key,
)
from reasoning_ledger.errors import LedgerError

from .conftest import requires_staging
from .staging_env import StagingEnv

pytestmark = [requires_staging]


@pytest.fixture(scope="module")
def encryption(agent_id: str) -> ContentEncryption:
    return ContentEncryption(master_key=generate_master_key(), agent_id=agent_id)


@pytest.fixture(scope="module")
def encrypted_client(
    staging_env: StagingEnv, agent_id: str, encryption: ContentEncryption
) -> LedgerClient:
    return LedgerClient(
        LedgerClientConfig(
            agent_id=agent_id,
            api_key=staging_env.api_key,
            endpoint=staging_env.base_url,
            encryption=encryption,
        )
    )


def test_encrypted_round_trip(
    encrypted_client: LedgerClient, client: LedgerClient, encryption: ContentEncryption
) -> None:
    session_id = f"it-py-enc-{uuid.uuid4()}"
    secret = f"the secret of {session_id}"
    ack = encrypted_client.submit(
        {
            "behavior": "Thinking",
            "executor": "ai",
            "record_phase": "post_execution",
            "session_id": session_id,
            "model_invocation": {"provider": "test", "model_name": "it"},
            "output_payload": secret,
            "outcome": "success",
        }
    )
    stored = encrypted_client.get_record(ack["record_id"])
    ref = stored["output_payload"]
    enc = ref["enc"]
    assert ref["media_type"] == "application/octet-stream"
    assert enc["plaintext_sha256"] == hashlib.sha256(secret.encode()).hexdigest()
    assert enc["plaintext_bytes"] == len(secret.encode())

    # What the server holds is not the text.
    ciphertext = client.get_content(ref)
    assert secret.encode() not in ciphertext
    assert hashlib.sha256(ciphertext).hexdigest() == ref["sha256"]

    # The wrapped key is registered under the session, named by the master key's id.
    wrapped = client.get_content_key(enc["key_id"])
    assert wrapped["session_id"] == session_id
    assert wrapped["master_key_id"] == encryption.master_key_id
    page = client.list_content_keys(session_id=session_id)
    assert [k["key_id"] for k in page["keys"]] == [enc["key_id"]]

    # Only the master key opens it.
    assert encrypted_client.open_content(ref) == secret.encode()
    with pytest.raises(ValidationError):
        client.open_content(ref)


def test_an_unregistered_key_is_refused(client: LedgerClient, agent_id: str) -> None:
    orphan = ContentEncryption(master_key=generate_master_key())
    ciphertext, enc = orphan.encrypt("sess", b"never readable", "text/plain; charset=utf-8")
    ref = client.put_content(ciphertext)
    with pytest.raises(LedgerError, match="has not been registered"):
        client.submit(
            {
                "agent_id": agent_id,
                "behavior": "Observing",
                "executor": "det",
                "record_phase": "post_execution",
                "session_id": "it-py-enc-orphan",
                "trigger_type": "signal_trigger",
                "trigger_source": "integration-test",
                "trigger_description": "an orphaned key",
                "trigger_payload": {**ref, "enc": enc},
            }
        )
