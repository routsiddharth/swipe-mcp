"""In-memory data store, seeded at startup.

Kept deliberately simple (plain dicts) so the data model is transparent in code
review. State lives for the process lifetime; POST /v2/_mock/reset reloads the
seed. Swap this layer for SQLite/Postgres later without touching the routers.
"""
from __future__ import annotations

from typing import Dict, List

# Serial-number prefixes per document type.
SERIAL_PREFIX = {
    "invoice": "INV",
    "subscription": "SUB",
    "pro_forma_invoice": "PI",
    "estimate": "EST",
    "sales_return": "SR",
    "purchase_return": "PR",
    "delivery_challan": "DC",
    "purchase": "PUR",
    "purchase_order": "PO",
}


class Store:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.company: dict = {}
        self.customers: Dict[str, dict] = {}
        self.vendors: Dict[str, dict] = {}
        self.products: Dict[str, dict] = {}
        self.documents: Dict[str, dict] = {}
        self.payments: Dict[str, dict] = {}
        self.subscriptions: Dict[str, dict] = {}
        self.warehouses: List[dict] = []
        self.gstins: Dict[str, dict] = {}
        self._serials: Dict[str, int] = {}

        # Imported lazily to avoid a circular import (seed -> service -> store).
        from . import seed

        seed.populate(self)

    def next_serial(self, document_type: str) -> str:
        prefix = SERIAL_PREFIX.get(document_type, "DOC")
        self._serials[prefix] = self._serials.get(prefix, 0) + 1
        return f"{prefix}-{self._serials[prefix]}"


# Singleton used by the routers.
db = Store()
