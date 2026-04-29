import pytest

from reasoning_ledger_sdk.utils import is_valid_record_id, new_record_id, now_epoch_ms

# ---------------------------------------------------------------------------
# new_record_id
# ---------------------------------------------------------------------------


class TestNewRecordId:
    def test_returns_string(self) -> None:
        assert isinstance(new_record_id(), str)

    def test_matches_uuid4_pattern(self) -> None:
        import re

        pattern = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            re.IGNORECASE,
        )
        assert pattern.match(new_record_id())

    def test_unique_per_call(self) -> None:
        ids = {new_record_id() for _ in range(100)}
        assert len(ids) == 100

    def test_recognised_by_is_valid_record_id(self) -> None:
        assert is_valid_record_id(new_record_id())


# ---------------------------------------------------------------------------
# now_epoch_ms
# ---------------------------------------------------------------------------


class TestNowEpochMs:
    def test_returns_int(self) -> None:
        assert isinstance(now_epoch_ms(), int)

    def test_positive(self) -> None:
        assert now_epoch_ms() > 0

    def test_monotonically_non_decreasing(self) -> None:
        a = now_epoch_ms()
        b = now_epoch_ms()
        assert b >= a

    def test_close_to_time_now(self) -> None:
        import time

        before = int(time.time() * 1000)
        result = now_epoch_ms()
        after = int(time.time() * 1000)
        assert before <= result <= after


# ---------------------------------------------------------------------------
# is_valid_record_id
# ---------------------------------------------------------------------------


VALID_UUIDS = [
    "550e8400-e29b-41d4-a716-446655440000",
    "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",
]


class TestIsValidRecordId:
    @pytest.mark.parametrize("uid", VALID_UUIDS)
    def test_valid_uuid4(self, uid: str) -> None:
        assert is_valid_record_id(uid)

    def test_fresh_ids_valid(self) -> None:
        for _ in range(20):
            assert is_valid_record_id(new_record_id())

    def test_empty_string(self) -> None:
        assert not is_valid_record_id("")

    def test_plain_string(self) -> None:
        assert not is_valid_record_id("not-a-uuid")

    def test_uuid_v1(self) -> None:
        # Version digit is 1, not 4
        assert not is_valid_record_id("550e8400-e29b-11d4-a716-446655440000")

    def test_uuid_without_hyphens(self) -> None:
        assert not is_valid_record_id("550e8400e29b41d4a716446655440000")

    def test_wrong_variant_digit(self) -> None:
        # Variant must be [89ab]; 'c' is invalid
        assert not is_valid_record_id("550e8400-e29b-41d4-c716-446655440000")
