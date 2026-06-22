"""Run a low-value MCP service smoke test against the real Swipe account.

The script creates one ₹1 + GST invoice, records a ₹0.01 cash payment, verifies
the list/ledger paths, and cancels the invoice in a finally block.

Usage:
    SWIPE_COMPANY_STATE=TELANGANA python scripts/live_mcp_smoke.py

The API key is loaded from SWIPE_API_TOKEN, SWIPE_API_KEY, or the repo .env.
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from swipe_mcp.client import SwipeClient
from swipe_mcp.config import SwipeConfig
from swipe_mcp.models import InvoiceItem
from swipe_mcp.service import SwipeService


async def main() -> None:
    config = SwipeConfig.from_env()
    if config.mode != "live":
        config = SwipeConfig(
            mode="live",
            backend_url=config.backend_url,
            api_token=config.api_token,
            company_state=config.company_state,
            timeout=config.timeout,
        )
    config.require_company_state()

    client = SwipeClient(config)
    service = SwipeService(config, client=client)
    hash_id: str | None = None
    tag = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    try:
        found = await service.find_customer("Acme Industries")
        if not found["matches"]:
            raise RuntimeError("Live smoke requires an existing Acme Industries customer.")
        customer_id = found["matches"][0]["id"]

        created = await service.create_invoice(
            customer_id=customer_id,
            items=[
                InvoiceItem(
                    item_id="ITEM005",
                    name="Swipe MCP Live Contract Test",
                    quantity=1,
                    unit_price=1,
                    tax_rate=18,
                    item_type="Service",
                    unit="OTH",
                    hsn_code="998311",
                )
            ],
            due_days=1,
            idempotency_key=f"live-contract-{tag}",
        )
        invoice = created["invoice"]
        hash_id = invoice["hash_id"]

        payment = await service.record_payment(
            document_ref=hash_id,
            amount=0.01,
            method="cash",
            idempotency_key=f"live-payment-{tag}",
        )
        payment_replay = await service.record_payment(
            document_ref=hash_id,
            amount=0.01,
            method="cash",
            idempotency_key=f"live-payment-{tag}",
        )
        ledger = await service.customer_outstanding(customer_id=customer_id)
        print(
            json.dumps(
                {
                    "ok": True,
                    "invoice": {
                        "serial_number": invoice.get("serial_number"),
                        "total_amount": invoice.get("total_amount"),
                        "tax_amount": invoice.get("tax_amount"),
                    },
                    "payment_status": payment["invoice"]["payment_status"],
                    "idempotent_replay": payment_replay["idempotent_replay"],
                    "ledger_records": len(ledger["transactions"]),
                }
            )
        )
    finally:
        if hash_id:
            await client.cancel_document(hash_id)
        await service.close()


if __name__ == "__main__":
    asyncio.run(main())
