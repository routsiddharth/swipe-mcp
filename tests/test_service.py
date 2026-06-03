"""Unit tests for the service seam — exercised directly, no HTTP layer.

These lock in two deepenings: (1) date-range filtering lives in one tested
function, and (2) party/product CRUD goes through service (so the store stays
substitutable). The interface being testable without FastAPI is the win.
"""
import pytest

from mock_backend import service
from mock_backend.errors import SwipeError
from mock_backend.store import Store


@pytest.fixture()
def store():
    return Store()  # fresh seed, in-memory


# --- filter_by_date_range -------------------------------------------------- #
def _rows():
    return [
        {"id": "a", "d": "01-01-2024"},
        {"id": "b", "d": "15-06-2024"},
        {"id": "c", "d": "31-12-2024"},
        {"id": "d", "d": None},          # missing date -> always kept
        {"id": "e", "d": "not-a-date"},  # unparseable -> always kept
    ]


def test_filter_by_date_range_inclusive_bounds():
    got = {r["id"] for r in service.filter_by_date_range(_rows(), "01-06-2024", "31-12-2024", "d")}
    assert got == {"b", "c", "d", "e"}


def test_filter_by_date_range_no_bounds_returns_all():
    rows = _rows()
    assert service.filter_by_date_range(rows, None, None, "d") == rows


def test_filter_by_date_range_open_ended():
    got = {r["id"] for r in service.filter_by_date_range(_rows(), None, "01-01-2024", "d")}
    assert got == {"a", "d", "e"}


# --- CRUD through service (store stays behind the seam) --------------------- #
def test_customer_crud_through_service(store):
    service.add_customer(store, {"customer_id": "CX", "name": "Contoso"})
    assert store.customers["CX"]["name"] == "Contoso"

    service.update_customer(store, {"customer_id": "CX", "name": "Contoso Ltd"})
    assert service.get_customer(store, "CX")["name"] == "Contoso Ltd"

    service.delete_customer(store, "CX")
    with pytest.raises(SwipeError) as exc:
        service.get_customer(store, "CX")
    assert exc.value.error_code == "CUSTOMER_NOT_FOUND"


def test_add_duplicate_customer_rejected(store):
    service.add_customer(store, {"customer_id": "CX", "name": "Contoso"})
    with pytest.raises(SwipeError):
        service.add_customer(store, {"customer_id": "CX", "name": "Contoso"})


def test_product_crud_and_stock_through_service(store):
    service.add_product(store, {"item_id": "PX", "name": "Widget", "selling_price": 100, "opening_stock": 5})
    assert service.get_product(store, "PX")["selling_price"] == 100

    out = service.adjust_stock(store, item_id="PX", quantity=3, type="in")
    assert out["stock"] == 8
    with pytest.raises(SwipeError) as exc:
        service.adjust_stock(store, item_id="PX", quantity=999, type="out")
    assert exc.value.error_code == "INSUFFICIENT_STOCK"


def test_document_auto_creates_unknown_party_and_item(store):
    """build_document auto-creates unknown ids — now asserted directly."""
    service.build_document(store, {
        "document_type": "invoice",
        "document_date": "01-06-2026",
        "party": {"id": "NEWCUST", "type": "customer", "name": "Brand New Co"},
        "items": [{"id": "NEWITEM", "name": "Fresh Item", "item_type": "Service",
                   "quantity": 1, "unit_price": 100, "tax_rate": 18}],
    })
    assert "NEWCUST" in store.customers
    assert "NEWITEM" in store.products
