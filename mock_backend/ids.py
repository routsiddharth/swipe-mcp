"""ID / hash generators for server-assigned identifiers."""
from __future__ import annotations

import uuid


def new_hash_id() -> str:
    """Document hash id, e.g. 'SL1A2B3C4D5E'."""
    return "SL" + uuid.uuid4().hex[:10].upper()


def new_payment_id() -> str:
    return "PAY" + uuid.uuid4().hex[:8].upper()


def fake_irn() -> str:
    """A 64-char IRN-shaped string (real IRNs are 64 hex chars)."""
    return (uuid.uuid4().hex + uuid.uuid4().hex)[:64]
