"""Endpoint smoke tests via FastAPI's TestClient (no network, no key)."""
import pytest
from fastapi.testclient import TestClient

from mock_backend.main import app

AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture()
def client():
    c = TestClient(app)
    c.post("/v2/_mock/reset")  # fresh seed per test
    return c


def test_requires_auth(client):
    r = client.get("/v2/customer/list")
    assert r.status_code == 401
    assert r.json()["error_code"] == "UNAUTHORIZED"


def test_list_customers(client):
    r = client.get("/v2/customer/list", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["total_records"] >= 5
    assert any(c["customer_id"] == "CUST001" for c in body["data"])


def test_create_invoice_end_to_end(client):
    payload = {
        "document_type": "invoice",
        "document_date": "01-06-2026",
        "party": {
            "id": "CUST001",
            "type": "customer",
            "name": "Acme Industries",
            "billing_address": {"state": "KARNATAKA", "city": "Bengaluru"},
        },
        "items": [
            {"id": "ITEM005", "name": "Consulting (per hour)", "item_type": "Service",
             "quantity": 20, "unit_price": 2500, "tax_rate": 18}
        ],
    }
    r = client.post("/v2/doc", json=payload, headers=AUTH)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    hash_id = data["hash_id"]
    assert data["serial_number"].startswith("INV-")

    # Fetch it back; inter-state -> IGST.
    got = client.get(f"/v2/doc/{hash_id}", headers=AUTH).json()["data"]
    assert got["total_amount"] == 59000.0
    assert got["tax_breakup"]["igst"] == 9000.0
    assert got["payment_status"] == "pending"

    # Record a payment -> paid.
    pay = client.post("/v2/payment", json={"doc_hash_id": hash_id, "amount": 59000, "method": "upi"}, headers=AUTH)
    assert pay.status_code == 200
    refetched = client.get(f"/v2/doc/{hash_id}", headers=AUTH).json()["data"]
    assert refetched["payment_status"] == "paid"
    assert refetched["amount_pending"] == 0.0


def test_duplicate_serial_rejected(client):
    payload = {
        "document_type": "invoice",
        "document_date": "01-06-2026",
        "serial_number": "INV-DUP-1",
        "party": {"id": "CUST001", "type": "customer", "name": "Acme Industries"},
        "items": [{"id": "ITEM001", "name": "Steel Bolt M8", "item_type": "Product",
                   "quantity": 1, "unit_price": 12, "tax_rate": 18}],
    }
    assert client.post("/v2/doc", json=payload, headers=AUTH).status_code == 200
    dup = client.post("/v2/doc", json=payload, headers=AUTH)
    assert dup.status_code == 400
    assert dup.json()["error_code"] == "DUPLICATE_DOC_SERIAL_NUMBER"


def test_list_invoices_filters_by_status(client):
    r = client.get(
        "/v2/doc/list",
        params={"document_type": "invoice", "start_date": "01-01-2024",
                "end_date": "31-12-2024", "payment_status": "cancelled"},
        headers=AUTH,
    )
    assert r.status_code == 200
    txns = r.json()["data"]["transactions"]
    assert all(t["payment_status"] == "cancelled" for t in txns)
    assert len(txns) >= 1


def test_pdf_returns_pdf(client):
    # grab any seeded document
    doc_list = client.get(
        "/v2/doc/list",
        params={"document_type": "invoice", "start_date": "01-01-2024", "end_date": "31-12-2024"},
        headers=AUTH,
    ).json()["data"]["transactions"]
    hid = doc_list[0]["hash_id"]
    r = client.get(f"/v2/doc/pdf/{hid}", headers=AUTH)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF")


def test_gstin_lookup(client):
    r = client.get("/v2/utils/gstin/29AAACG2222B1Z2", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["data"]["state"] == "KARNATAKA"


def _new_invoice(client, **overrides):
    payload = {
        "document_type": "invoice",
        "document_date": "01-06-2026",
        "party": {"id": "CUST001", "type": "customer", "name": "Acme Industries"},
        "items": [{"id": "ITEM005", "name": "Consulting", "item_type": "Service",
                   "quantity": 20, "unit_price": 2500, "tax_rate": 18}],
    }
    payload.update(overrides)
    return client.post("/v2/doc", json=payload, headers=AUTH)


def test_intra_state_invoice_splits_cgst_sgst(client):
    # Acme is in TELANGANA, same as the company -> intra-state -> CGST + SGST.
    r = _new_invoice(client, party={"id": "CUST001", "type": "customer",
                                    "name": "Acme Industries",
                                    "billing_address": {"state": "TELANGANA"}})
    hid = r.json()["data"]["hash_id"]
    bk = client.get(f"/v2/doc/{hid}", headers=AUTH).json()["data"]["tax_breakup"]
    assert bk["cgst"] == 4500.0
    assert bk["sgst"] == 4500.0
    assert bk["igst"] == 0.0


def test_overpayment_on_create_leaves_no_orphan_payment(client):
    before = client.get(
        "/v2/payment/list",
        params={"start_date": "01-01-2024", "end_date": "31-12-2030"},
        headers=AUTH,
    ).json()["data"]["total_records"]

    r = _new_invoice(client, payments=[{"amount": 999999, "method": "upi"}])
    assert r.status_code == 400
    assert r.json()["error_code"] == "AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT"

    after = client.get(
        "/v2/payment/list",
        params={"start_date": "01-01-2024", "end_date": "31-12-2030"},
        headers=AUTH,
    ).json()["data"]["total_records"]
    assert after == before  # no orphan payment registered


def test_failed_edit_preserves_original(client):
    hid = _new_invoice(client).json()["data"]["hash_id"]
    original = client.get(f"/v2/doc/{hid}", headers=AUTH).json()["data"]

    # Edit with an invalid tax rate -> must fail AND leave the original intact.
    bad = client.put(
        f"/v2/doc/{hid}",
        json={"document_type": "invoice", "document_date": "02-06-2026",
              "party": {"id": "CUST001", "type": "customer", "name": "Acme"},
              "items": [{"id": "ITEM005", "name": "Consulting", "item_type": "Service",
                         "quantity": 1, "unit_price": 100, "tax_rate": 17}]},
        headers=AUTH,
    )
    assert bad.status_code == 400
    assert bad.json()["error_code"] == "INVALID_TAX_RATE"

    still_there = client.get(f"/v2/doc/{hid}", headers=AUTH)
    assert still_there.status_code == 200
    assert still_there.json()["data"]["total_amount"] == original["total_amount"]


def test_successful_edit_keeps_hash_and_serial(client):
    created = _new_invoice(client).json()["data"]
    hid, serial = created["hash_id"], created["serial_number"]
    r = client.put(
        f"/v2/doc/{hid}",
        json={"document_type": "invoice", "document_date": "02-06-2026",
              "party": {"id": "CUST001", "type": "customer", "name": "Acme"},
              "items": [{"id": "ITEM001", "name": "Steel Bolt M8", "item_type": "Product",
                         "quantity": 10, "unit_price": 12, "tax_rate": 18}]},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json()["data"]["hash_id"] == hid
    assert r.json()["data"]["serial_number"] == serial
    detail = client.get(f"/v2/doc/{hid}", headers=AUTH).json()["data"]
    assert detail["total_amount"] == 141.6  # 10*12 +18%


def test_seed_has_a_paid_invoice(client):
    r = client.get(
        "/v2/doc/list",
        params={"document_type": "invoice", "start_date": "01-01-2024",
                "end_date": "31-12-2024", "payment_status": "paid"},
        headers=AUTH,
    )
    assert any(t["payment_status"] == "paid" for t in r.json()["data"]["transactions"])


def test_customer_ledger(client):
    r = client.get("/v2/customer/ledger", params={"customer_id": "CUST001"}, headers=AUTH)
    assert r.status_code == 200
    assert "transactions" in r.json()["data"]


def test_inventory_stock_in_out_and_insufficient(client):
    base = client.get("/v2/product/ITEM001", headers=AUTH).json()["data"]["stock"]
    client.post("/v2/inventory/stock", json={"item_id": "ITEM001", "quantity": 100, "type": "in"}, headers=AUTH)
    after_in = client.get("/v2/product/ITEM001", headers=AUTH).json()["data"]["stock"]
    assert after_in == base + 100

    bad = client.post(
        "/v2/inventory/stock",
        json={"item_id": "ITEM001", "quantity": 10**9, "type": "out"},
        headers=AUTH,
    )
    assert bad.status_code == 400
    assert bad.json()["error_code"] == "INSUFFICIENT_STOCK"


def test_vendor_crud(client):
    add = client.post("/v2/vendor", json={"vendor_id": "VTEST", "name": "Test Vendor"}, headers=AUTH)
    assert add.status_code == 200
    assert client.get("/v2/vendor/VTEST", headers=AUTH).json()["data"]["name"] == "Test Vendor"
    assert client.delete("/v2/vendor/VTEST", headers=AUTH).status_code == 200
    assert client.get("/v2/vendor/VTEST", headers=AUTH).status_code == 404


def test_round_off_and_charges(client):
    r = _new_invoice(
        client,
        items=[{"id": "ITEM002", "name": "Aluminium Sheet", "item_type": "Product",
                "quantity": 3, "unit_price": 33.33, "tax_rate": 18}],
        charges_and_deductions=[{"id": 1, "name": "Freight", "amount": 500,
                                 "tax_rate": 18, "type": "charge"}],
        round_off=True,
    )
    detail = client.get(f"/v2/doc/{r.json()['data']['hash_id']}", headers=AUTH).json()["data"]
    assert detail["total_amount"] == round(detail["total_amount"])
