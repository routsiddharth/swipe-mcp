import asyncio

import httpx

from mock_backend.main import app
from mock_backend.store import db
from swipe_mcp.client import SwipeClient
from swipe_mcp.config import SwipeConfig
from swipe_mcp.models import InvoiceItem
from swipe_mcp.service import SwipeService


def test_mock_round_trip_and_idempotency_through_mcp_service():
    async def run():
        db.reset()
        config = SwipeConfig(backend_url="http://testserver")
        client = SwipeClient(config, transport=httpx.ASGITransport(app=app))
        service = SwipeService(config, client=client)
        try:
            created = await service.create_invoice(
                customer_id="CUST001",
                items=[
                    InvoiceItem(
                        name="MCP Test Service",
                        quantity=1,
                        unit_price=100,
                        tax_rate=18,
                        item_type="Service",
                    )
                ],
                idempotency_key="invoice-test-key",
            )
            replay = await service.create_invoice(
                customer_id="CUST001",
                items=[
                    InvoiceItem(
                        name="MCP Test Service",
                        quantity=1,
                        unit_price=100,
                        tax_rate=18,
                        item_type="Service",
                    )
                ],
                idempotency_key="invoice-test-key",
            )
            hash_id = created["invoice"]["hash_id"]
            payment = await service.record_payment(
                document_ref=hash_id,
                amount=1,
                method="cash",
                idempotency_key="payment-test-key",
            )
            payment_replay = await service.record_payment(
                document_ref=hash_id,
                amount=1,
                method="cash",
                idempotency_key="payment-test-key",
            )
            invoices = await service.list_invoices(customer_id="CUST001")
            return created, replay, payment, payment_replay, invoices
        finally:
            await service.close()
            db.reset()

    created, replay, payment, payment_replay, invoices = asyncio.run(run())
    assert created["created"] is True
    assert created["preview"]["totals"]["total_amount"] == 118
    assert replay["idempotent_replay"] is True
    assert payment["recorded"] is True
    assert payment_replay["idempotent_replay"] is True
    assert any(x["hash_id"] == created["invoice"]["hash_id"] for x in invoices["invoices"])


def test_gstin_checksum_character_may_be_alphanumeric():
    class StubClient:
        async def lookup_gstin(self, gstin):
            return {
                "legal_name": "Google India Private Limited",
                "status": "Active",
                "billing": {"state": "29-KARNATAKA"},
            }

        async def close(self):
            pass

    async def run():
        service = SwipeService(SwipeConfig(), client=StubClient())
        return await service.lookup_gstin("29AACCG0527D1Z0")

    result = asyncio.run(run())
    assert result["gstin"] == "29AACCG0527D1Z0"
    assert result["state"] == "KARNATAKA"
