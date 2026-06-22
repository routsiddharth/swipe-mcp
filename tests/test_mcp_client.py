import asyncio
import json

import httpx

from swipe_mcp.client import SwipeClient
from swipe_mcp.config import SwipeConfig


def test_live_response_shapes_and_required_payment_status():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/v2/customer/list"):
            data = {"customers": [{"customer_id": "C1", "name": "Acme"}], "total_records": 1}
        elif request.url.path.endswith("/v2/product/list"):
            data = {"items": [{"id": "I1", "name": "Service"}], "total_records": 1}
        elif request.url.path.endswith("/v2/doc/H1"):
            data = {"invoice_details": {"hash_id": "H1", "serial_number": "INV-1"}}
        elif request.url.path.endswith("/v2/payment/list"):
            data = {"transactions": [], "total_records": 0}
        else:
            raise AssertionError(f"unexpected request: {request.url}")
        return httpx.Response(
            200,
            content=json.dumps(
                {"success": True, "message": "", "error_code": "", "errors": {}, "data": data}
            ),
            headers={"content-type": "application/json"},
        )

    async def run():
        config = SwipeConfig(mode="live", api_token="secret")
        client = SwipeClient(config, transport=httpx.MockTransport(handler))
        try:
            customers, _ = await client.list_customers()
            products, _ = await client.list_products()
            document = await client.get_document("H1")
            await client.list_payments(start_date="01-01-2026", end_date="31-12-2026")
            return customers, products, document
        finally:
            await client.close()

    customers, products, document = asyncio.run(run())
    assert customers[0]["customer_id"] == "C1"
    assert products[0]["id"] == "I1"
    assert document == {"hash_id": "H1", "serial_number": "INV-1"}
    payment_request = next(r for r in requests if r.url.path.endswith("/v2/payment/list"))
    assert payment_request.url.params["status"] == "success"


def test_http_200_error_envelope_is_an_error():
    from swipe_mcp.client import SwipeAPIError

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "success": False,
                "error_code": "FORBIDDEN",
                "message": "API Limit Reached",
                "errors": {},
            },
        )

    async def run():
        client = SwipeClient(
            SwipeConfig(mode="live", api_token="secret"),
            transport=httpx.MockTransport(handler),
        )
        try:
            await client.list_customers()
        finally:
            await client.close()

    try:
        asyncio.run(run())
    except SwipeAPIError as exc:
        assert exc.code == "FORBIDDEN"
        assert "API Limit Reached" in str(exc)
    else:
        raise AssertionError("expected SwipeAPIError")
