"""
Content encryption (schema 0.5 ``ContentRef.enc``).

Content is encrypted on this machine before it is uploaded, so the ledger
holds ciphertext it cannot open. One data key per session encrypts the
content; the data key is wrapped with the owner's master key, and the wrapped
copy is registered with the ledger (``PUT /v1/content-keys/{key_id}``) before
any record names it. The master key lives in a file on the owner's machine and
never reaches the ledger; the trace viewer gets it through the sign-in link's
fragment and decrypts in the browser.

Formats, shared with the server's viewer and the TypeScript SDK:

* AES-256-GCM everywhere. A sealed blob is nonce (12 bytes) + ciphertext +
  tag (16 bytes), with the key id as associated data: a ciphertext cannot be
  re-attributed to another key.
* The wrapped data key is such a blob under the master key, base64.
* ``master_key_id`` is the first 16 hex characters of SHA-256(master key): a
  reader can tell which master key opens a wrapped key without being told it.
* The master key file holds the 32 key bytes as one base64url line.
"""

from __future__ import annotations

import base64
import hashlib
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .types import ContentEncryptionInfo

MASTER_KEY_BYTES = 32
DATA_KEY_BYTES = 32
NONCE_BYTES = 12
CONTENT_ALG = "A256GCM"
WRAP_ALG = "A256GCM"
# What the ledger is told it holds: bytes it cannot read.
ENCRYPTED_MEDIA_TYPE = "application/octet-stream"


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def seal(key: bytes, plaintext: bytes, aad: str) -> bytes:
    """nonce + AES-256-GCM(plaintext) + tag, with `aad` as associated data."""
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad.encode("utf-8"))


def open_sealed(key: bytes, blob: bytes, aad: str) -> bytes:
    """The plaintext of a blob made by seal(); raises on a wrong key, aad or a tampered blob."""
    if len(blob) < NONCE_BYTES + 16:
        raise ValueError("sealed blob is too short")
    return AESGCM(key).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], aad.encode("utf-8"))


def master_key_id(master_key: bytes) -> str:
    """How a wrapped key names its master key: the first 16 hex characters of SHA-256(key)."""
    return hashlib.sha256(master_key).hexdigest()[:16]


def generate_master_key() -> bytes:
    return os.urandom(MASTER_KEY_BYTES)


def master_key_fragment(master_key: bytes) -> str:
    """The master key as the viewer link carries it: base64url, no padding, after `#k=`."""
    return base64.urlsafe_b64encode(master_key).decode("ascii").rstrip("=")


def master_key_from_fragment(text: str) -> bytes:
    padded = text.strip() + "=" * (-len(text.strip()) % 4)
    key = base64.urlsafe_b64decode(padded)
    if len(key) != MASTER_KEY_BYTES:
        raise ValueError(f"a master key is {MASTER_KEY_BYTES} bytes, not {len(key)}")
    return key


def load_master_key(path: str | os.PathLike[str]) -> bytes:
    """Read the master key file: one base64url line (hex is accepted too)."""
    text = Path(path).read_text(encoding="utf-8").strip()
    if len(text) == MASTER_KEY_BYTES * 2 and all(c in "0123456789abcdef" for c in text):
        return bytes.fromhex(text)
    return master_key_from_fragment(text)


def save_master_key(path: str | os.PathLike[str], master_key: bytes) -> None:
    """Write the master key as a file only this user can read. Refuses to overwrite."""
    if len(master_key) != MASTER_KEY_BYTES:
        raise ValueError(f"a master key is {MASTER_KEY_BYTES} bytes, not {len(master_key)}")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(master_key_fragment(master_key) + "\n")


# ---------------------------------------------------------------------------
# Per-session data keys
# ---------------------------------------------------------------------------


@dataclass
class DataKey:
    key_id: str
    key: bytes
    session_id: str | None
    # Set once the wrapped copy is registered with the ledger.
    registered: bool = False


@dataclass
class ContentEncryption:
    """Encrypts content positions with one data key per session, wrapped under
    a master key. Give it to LedgerClientConfig.encryption: the client then
    registers each wrapped key before it uploads content under it, and puts
    `enc` in every content reference it writes."""

    master_key: bytes
    # Named on the registered keys, so the ledger can list a session's keys.
    agent_id: str | None = None
    _keys: dict[str | None, DataKey] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if len(self.master_key) != MASTER_KEY_BYTES:
            raise ValueError(
                f"a master key is {MASTER_KEY_BYTES} bytes, not {len(self.master_key)}"
            )

    @property
    def master_key_id(self) -> str:
        return master_key_id(self.master_key)

    def data_key(self, session_id: str | None) -> DataKey:
        """The session's data key, made on first use."""
        key = self._keys.get(session_id)
        if key is None:
            key = DataKey(
                key_id=str(uuid.uuid4()), key=os.urandom(DATA_KEY_BYTES), session_id=session_id
            )
            self._keys[session_id] = key
        return key

    def unregistered(self) -> list[DataKey]:
        return [key for key in self._keys.values() if not key.registered]

    def wrapped(self, data_key: DataKey) -> dict[str, Any]:
        """The body of PUT /v1/content-keys/{key_id} for this data key."""
        body: dict[str, Any] = {
            "master_key_id": self.master_key_id,
            "wrap_alg": WRAP_ALG,
            "wrapped_key": base64.b64encode(
                seal(self.master_key, data_key.key, data_key.key_id)
            ).decode("ascii"),
        }
        if data_key.session_id is not None:
            body["session_id"] = data_key.session_id
        if self.agent_id is not None:
            body["agent_id"] = self.agent_id
        return body

    def encrypt(
        self, session_id: str | None, plaintext: bytes, media_type: str
    ) -> tuple[bytes, ContentEncryptionInfo]:
        """(ciphertext, the `enc` member of the content reference)."""
        key = self.data_key(session_id)
        ciphertext = seal(key.key, plaintext, key.key_id)
        enc = ContentEncryptionInfo(
            alg=CONTENT_ALG,
            key_id=key.key_id,
            plaintext_bytes=len(plaintext),
            plaintext_media_type=media_type,
            plaintext_sha256=hashlib.sha256(plaintext).hexdigest(),
        )
        return ciphertext, enc

    def unwrap(self, key_id: str, wrapped_key: str, wrapped_master_key_id: str) -> bytes:
        """The data key behind a wrapped copy the ledger handed back."""
        if wrapped_master_key_id != self.master_key_id:
            raise ValueError(
                f"content key {key_id} was wrapped with master key {wrapped_master_key_id}, "
                f"not {self.master_key_id}"
            )
        return open_sealed(self.master_key, base64.b64decode(wrapped_key), key_id)

    def decrypt(self, enc: dict[str, Any], ciphertext: bytes, wrapped: dict[str, Any]) -> bytes:
        """The plaintext of an encrypted object, given its reference's `enc`, its bytes and
        its wrapped key as GET /v1/content-keys/{key_id} returns it. Checks the plaintext
        digest the reference committed to."""
        key_id = str(enc["key_id"])
        data_key = self.unwrap(key_id, str(wrapped["wrapped_key"]), str(wrapped["master_key_id"]))
        plaintext = open_sealed(data_key, ciphertext, key_id)
        digest = hashlib.sha256(plaintext).hexdigest()
        if digest != enc.get("plaintext_sha256"):
            raise ValueError(
                "decrypted content does not match the digest its reference committed to"
            )
        return plaintext
