"""Async HTTP adapter for mock and live Swipe API contracts."""
from __future__ import annotations

from datetime import date
from typing import Any

import httpx

from .config import SwipeConfig

ERROR_MESSAGES = {
    "CUSTOMER_NOT_FOUND": "Customer not found. Search customers and use an exact customer ID.",
    "INVALID_HASH_ID": "Invoice not found. Use a valid invoice hash ID or serial number.",
    "DUPLICATE_DOC_SERIAL_NUMBER": "An invoice with this serial number already exists.",
    "INVALID_TAX_RATE": "Swipe rejected the GST rate. Use a supported GST slab.",
    "AMOUNT_RECEIVED_GREATER_THAN_TOTAL_AMOUNT": "The payment exceeds the invoice's outstanding balance.",
    "CAN_NOT_APPLY_TDS_AND_TCS_TOGETHER": "TDS and TCS cannot both be applied to one document.",
    "UNAUTHORIZED": "Swipe rejected the API token.",
    "FORBIDDEN": "Swipe denied the request or the API quota is exhausted.",
    "DAILY_LIMIT_EXCEEDED": (
        "Swipe's daily API limit for this account is reached. It resets the next "
        "day; raise it at app.getswipe.in → API Integration, or retry tomorrow."
    ),
}


class SwipeAPIError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int | None = None,
        details: Any = None,
    ):
        self.code = code or "SWIPE_API_ERROR"
        self.api_message = message
        self.status_code = status_code
        self.details = details
        friendly = ERROR_MESSAGES.get(self.code, message or "Swipe API request failed.")
        if message and friendly != message:
            friendly = f"{friendly} Swipe says: {message}"
        super().__init__(f"{self.code}: {friendly}")


class SwipeClient:
    def __init__(
        self,
        config: SwipeConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.config = config
        self._http = httpx.AsyncClient(
            base_url=config.base_url,
            timeout=config.timeout,
            transport=transport,
            headers={
                "Authorization": f"Bearer {config.authorization_token}",
                "Content-Type": "application/json",
                "User-Agent": "swipe-mcp/0.1.0",
            },
        )

    async def close(self) -> None:
        await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        enveloped: bool = True,
    ) -> Any:
        try:
            response = await self._http.request(method, path, params=params, json=json)
        except httpx.TimeoutException as exc:
            raise SwipeAPIError("TIMEOUT", "Swipe did not respond before the configured timeout.") from exc
        except httpx.HTTPError as exc:
            raise SwipeAPIError("CONNECTION_ERROR", f"Could not reach Swipe: {exc}") from exc

        try:
            body = response.json()
        except ValueError as exc:
            raise SwipeAPIError(
                "INVALID_RESPONSE",
                f"Swipe returned non-JSON content (HTTP {response.status_code}).",
                status_code=response.status_code,
            ) from exc

        failed_envelope = isinstance(body, dict) and body.get("success") is False
        if not response.is_success or failed_envelope:
            if isinstance(body, dict):
                code = str(body.get("error_code") or response.status_code)
                message = str(body.get("message") or response.reason_phrase)
                details = body.get("errors")
            else:
                code, message, details = str(response.status_code), response.reason_phrase, None
            raise SwipeAPIError(
                code, message, status_code=response.status_code, details=details
            )

        if not enveloped:
            return body
        if not isinstance(body, dict):
            raise SwipeAPIError("INVALID_RESPONSE", "Swipe returned an invalid response envelope.")
        return body.get("data")

    async def list_customers(self, *, page: int = 1, limit: int = 100) -> tuple[list[dict], int]:
        data = await self._request(
            "GET", "/v2/customer/list", params={"page": page, "num_records": limit}
        )
        records = _list_from(data, "customers")
        total = _total_from(data, records)
        return records, total

    async def all_customers(self, *, max_pages: int = 10) -> list[dict]:
        return await self._all_pages(self.list_customers, max_pages=max_pages)

    async def get_customer(self, customer_id: str) -> dict:
        data = await self._request("GET", f"/v2/customer/{customer_id}")
        if isinstance(data, list):
            return data[0] if data else {}
        return data or {}

    async def list_products(self, *, page: int = 1, limit: int = 100) -> tuple[list[dict], int]:
        data = await self._request(
            "GET", "/v2/product/list", params={"page": page, "num_records": limit}
        )
        records = _list_from(data, "items", "products")
        total = _total_from(data, records)
        return records, total

    async def list_invoices(
        self,
        *,
        start_date: str,
        end_date: str,
        status: str = "all",
        page: int = 1,
        limit: int = 100,
        customer_id: str | None = None,
    ) -> tuple[list[dict], int]:
        params: dict[str, Any] = {
            "document_type": "invoice",
            "start_date": start_date,
            "end_date": end_date,
            "payment_status": status,
            "page": page,
            "num_records": limit,
        }
        if customer_id:
            params["customer_id"] = customer_id
        data = await self._request("GET", "/v2/doc/list", params=params)
        records = _list_from(data, "transactions")
        return records, _total_from(data, records)

    async def all_invoices(
        self,
        *,
        start_date: str,
        end_date: str,
        status: str = "all",
        customer_id: str | None = None,
        max_pages: int = 20,
    ) -> list[dict]:
        async def fetch(*, page: int, limit: int) -> tuple[list[dict], int]:
            return await self.list_invoices(
                start_date=start_date,
                end_date=end_date,
                status=status,
                page=page,
                limit=limit,
                customer_id=customer_id,
            )

        return await self._all_pages(fetch, max_pages=max_pages)

    async def get_document(self, hash_id: str) -> dict:
        data = await self._request("GET", f"/v2/doc/{hash_id}")
        if isinstance(data, dict) and isinstance(data.get("invoice_details"), dict):
            return data["invoice_details"]
        return data or {}

    async def create_document(self, body: dict) -> dict:
        data = await self._request("POST", "/v2/doc", json=body)
        return data or {}

    async def cancel_document(self, hash_id: str) -> dict:
        data = await self._request("DELETE", f"/v2/doc/{hash_id}")
        return data or {}

    async def record_payment(self, body: dict) -> dict:
        data = await self._request("POST", "/v2/payment", json=body)
        return data or {}

    async def list_payments(
        self, *, start_date: str, end_date: str, page: int = 1, limit: int = 100
    ) -> tuple[list[dict], int]:
        data = await self._request(
            "GET",
            "/v2/payment/list",
            params={
                "start_date": start_date,
                "end_date": end_date,
                "status": "success",
                "page": page,
                "num_records": limit,
            },
        )
        records = _list_from(data, "payments", "transactions")
        return records, _total_from(data, records)

    async def customer_ledger(
        self, customer_id: str, *, start_date: str, end_date: str
    ) -> dict:
        data = await self._request(
            "GET",
            "/v2/customer/ledger",
            params={
                "customer_id": customer_id,
                "start_date": start_date,
                "end_date": end_date,
                "num_records": 100,
            },
        )
        return data or {}

    async def lookup_gstin(self, gstin: str) -> dict:
        data = await self._request("GET", f"/v2/utils/gstin/{gstin}")
        return data or {}

    async def mock_company(self) -> dict:
        if self.config.mode != "mock":
            raise SwipeAPIError("BAD_CONFIGURATION", "Company lookup is mock-only.")
        data = await self._request("GET", "/v2/_mock/company", enveloped=False)
        return data if isinstance(data, dict) else {}

    async def _all_pages(self, fetch, *, max_pages: int) -> list[dict]:
        records: list[dict] = []
        for page in range(1, max_pages + 1):
            batch, total = await fetch(page=page, limit=100)
            records.extend(batch)
            if not batch or len(records) >= total:
                break
        return records


def _list_from(data: Any, *keys: str) -> list[dict]:
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]
    return []


def _total_from(data: Any, records: list[dict]) -> int:
    if isinstance(data, dict):
        try:
            return int(data.get("total_records", len(records)))
        except (TypeError, ValueError):
            pass
    return len(records)


def today_ddmmyyyy() -> str:
    return date.today().strftime("%d-%m-%Y")
