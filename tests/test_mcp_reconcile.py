"""Reconciliation tests — pure matcher + a full mock-backend write round-trip.

No live Swipe API calls: the matcher is pure, and the integration test drives the
local in-memory mock backend over an ASGI transport.
"""
import asyncio

import httpx

from mock_backend.main import app
from mock_backend.store import db
from swipe_mcp.client import SwipeClient
from swipe_mcp.config import SwipeConfig
from swipe_mcp.models import BankCredit, InvoiceItem
from swipe_mcp.reconcile import OutstandingInvoice, match_credit, match_credits
from swipe_mcp.service import SwipeService


# ----- pure matcher -------------------------------------------------------- #

ACME = OutstandingInvoice("h-acme", "INV-3", "Acme Industries", 30000.0, "01-06-2026")
INITECH = OutstandingInvoice("h-init", "INV-7", "Initech Solutions", 11800.0, "01-06-2026")
DEMO = [ACME, INITECH]


def test_confident_match_by_payee_name():
    r = match_credit(
        30000.0,
        "NEFT CR-HDFC0000123-ACME INDUSTRIES PVT LTD-INV 06 2026",
        None,
        DEMO,
    )
    assert r["outcome"] == "confident"
    assert [m["hash_id"] for m in r["matches"]] == ["h-acme"]
    assert r["matches"][0]["apply_amount"] == 30000.0


def test_confident_match_by_serial_reference():
    # Payee text ("INITECH LLP") differs from the Swipe name ("Initech
    # Solutions"); the INV7 serial in the narration carries the match.
    r = match_credit(11800.0, "IMPS-615412345678-INITECH LLP-INV7 PAYMENT", None, DEMO)
    assert r["outcome"] == "confident"
    assert r["matches"][0]["serial_number"] == "INV-7"


def test_refund_and_salary_are_left_alone():
    refund = match_credit(1299.0, "UPI-AMAZON PAY INDIA-amazonpay@apl", None, DEMO)
    salary = match_credit(95000.0, "NEFT CR-NOVA SOFTWARE PVT LTD-SALARY MAY 2026", None, DEMO)
    assert refund["outcome"] == "none"
    assert salary["outcome"] == "none"


def test_unknown_payee_with_coincidental_amount_is_not_booked():
    # Amount equals Acme's pending, but the narration names nobody we know.
    r = match_credit(30000.0, "IMPS-999-RAVI KUMAR-HOUSE RENT", None, DEMO)
    assert r["outcome"] == "none"


def test_split_one_credit_clears_two_invoices():
    a = OutstandingInvoice("h1", "INV-1", "Acme Industries", 100.0)
    b = OutstandingInvoice("h2", "INV-2", "Acme Industries", 200.0)
    r = match_credit(300.0, "NEFT CR-ACME INDUSTRIES PVT LTD", None, [a, b])
    assert r["outcome"] == "split"
    assert {m["hash_id"] for m in r["matches"]} == {"h1", "h2"}
    assert sum(m["apply_amount"] for m in r["matches"]) == 300.0


def test_near_amount_is_review_not_silent_book():
    inv = OutstandingInvoice("h1", "INV-1", "Acme Industries", 100.0)
    r = match_credit(100.5, "NEFT CR-ACME INDUSTRIES", None, [inv], amount_tolerance=1.0)
    assert r["outcome"] == "review"


def test_overpayment_is_review():
    inv = OutstandingInvoice("h1", "INV-1", "Acme Industries", 100.0)
    r = match_credit(500.0, "NEFT CR-ACME INDUSTRIES", None, [inv])
    assert r["outcome"] == "review"


def test_clean_partial_payment_is_confident():
    inv = OutstandingInvoice("h1", "INV-1", "Acme Industries", 100.0)
    r = match_credit(40.0, "NEFT CR-ACME INDUSTRIES", None, [inv])
    assert r["outcome"] == "confident"
    assert r["matches"][0]["apply_amount"] == 40.0


def test_match_credits_batch_attaches_credit_echo():
    results = match_credits(
        [{"amount": 30000.0, "narration": "ACME INDUSTRIES PVT LTD", "date": None, "reference": None}],
        DEMO,
    )
    assert results[0]["credit"]["amount"] == 30000.0
    assert results[0]["outcome"] == "confident"


# ----- full write round-trip against the mock backend ---------------------- #

def test_reconcile_dry_run_then_record_is_idempotent():
    async def run():
        db.reset()
        # Keep seeded customers/products but start with no documents so the
        # reconciliation matches only the two invoices this test creates.
        db.documents.clear()
        db.payments.clear()
        config = SwipeConfig(backend_url="http://testserver")
        client = SwipeClient(config, transport=httpx.ASGITransport(app=app))
        service = SwipeService(config, client=client)
        try:
            acme = await service.create_invoice(
                customer_id="CUST001",
                items=[InvoiceItem(name="Widget", quantity=1, unit_price=100, tax_rate=18)],
            )
            initech = await service.create_invoice(
                customer_id="CUST003",
                items=[InvoiceItem(name="Gadget", quantity=1, unit_price=200, tax_rate=18)],
            )
            acme_total = acme["preview"]["totals"]["total_amount"]
            initech_total = initech["preview"]["totals"]["total_amount"]
            initech_serial = initech["invoice"]["serial_number"]

            credits = [
                BankCredit(amount=acme_total, narration="NEFT CR-HDFC-ACME INDUSTRIES PVT LTD-INV"),
                BankCredit(
                    amount=initech_total,
                    narration=f"IMPS-INITECH LLP-{initech_serial} PAYMENT",
                ),
                BankCredit(amount=4321.0, narration="UPI-AMAZON PAY INDIA-refund"),
            ]

            preview = await service.reconcile(credits=credits, dry_run=True)
            recorded = await service.reconcile(credits=credits, dry_run=False)
            replay = await service.reconcile(credits=credits, dry_run=False)

            acme_doc = await service.client.get_document(acme["invoice"]["hash_id"])
            initech_doc = await service.client.get_document(initech["invoice"]["hash_id"])
            return preview, recorded, replay, acme_doc, initech_doc
        finally:
            await service.close()
            db.reset()

    preview, recorded, replay, acme_doc, initech_doc = asyncio.run(run())

    # Dry run writes nothing but classifies all three credits.
    assert preview["dry_run"] is True
    assert preview["summary"]["by_outcome"]["confident"] == 2
    assert preview["summary"]["by_outcome"]["none"] == 1
    assert preview["summary"]["auto_applicable"] == 2

    # Recording settles the two real invoices and ignores the refund.
    assert recorded["summary"]["recorded_payments"] == 2
    assert acme_doc["payment_status"] == "paid"
    assert initech_doc["payment_status"] == "paid"

    # Re-running the same statement never double-pays.
    for result in replay["results"]:
        for entry in result.get("recorded", []):
            assert entry["idempotent_replay"] is True
    assert float(acme_doc["amount_pending"]) == 0.0
