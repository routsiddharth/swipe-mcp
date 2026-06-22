# PLAN — ship `swipe_mcp/`

Status: **implemented and verified on June 21, 2026**. This document records the
corrected plan and the contracts the implementation must continue to preserve.

## Goal

Build a typed Python MCP server that:

- runs key-free against the repository's mock backend;
- switches to the real Swipe Partner API with environment configuration;
- preserves the live API's request/response differences;
- computes and returns a trustworthy GST preview for invoice writes;
- prevents duplicate writes when the caller supplies an idempotency key; and
- returns structured, recoverable errors without leaking credentials.

The existing browser agent remains a separate demo surface. The MCP server is
the reusable platform integration.

## Scope

Eight tools:

| Tool | Operation |
|---|---|
| `find_customer` | Resolve a query against the customer list client-side |
| `list_customers` | List a bounded page of customers |
| `list_products` | List a bounded page of products |
| `create_invoice` | Resolve an existing customer, compute GST, and create an invoice |
| `record_payment` | Resolve an invoice by hash/serial and record a payment; require bank details for live non-cash methods |
| `list_invoices` | List invoices with required API date filters |
| `customer_outstanding` | Resolve a customer and return its ledger/outstanding balance |
| `lookup_gstin` | Validate and look up a GSTIN |

Vendors, inventory, document editing/cancellation, e-way bills, subscriptions,
and scheduling are out of scope for v1.

## Package

```
swipe_mcp/
  __init__.py
  __main__.py       # python -m swipe_mcp
  client.py         # async HTTP client, pagination, envelope/error handling
  config.py         # validated mock/live environment configuration
  mapping.py        # customer/address normalization and invoice/GST mapping
  models.py         # typed MCP input models
  service.py        # tool business logic, resolution, idempotency
  server.py         # FastMCP instance and eight tool adapters
  README.md
```

Existing files that must also change:

- `requirements.txt` — add stable MCP v1 (`mcp>=1.28,<2`); v2 is alpha and has a
  scheduled incompatible stable release.
- root `README.md` — add MCP-first quick start and accurate security/approval
  notes.
- `DEPLOYMENT.md` — document local mock, hosted mock override, and live mode.
- tests — mapping, client contract, service/idempotency, and stdio discovery.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SWIPE_MODE` | `mock` | `mock` or `live` |
| `SWIPE_BACKEND_URL` | `http://127.0.0.1:8000` | Mock API only |
| `SWIPE_API_TOKEN` | empty | Required in live mode |
| `SWIPE_COMPANY_STATE` | empty | Required for live invoice GST split |
| `SWIPE_HTTP_TIMEOUT` | `20` | HTTP timeout in seconds |

Live mode always uses `https://app.getswipe.in/api/partner`; a configured mock
URL can never receive the live token. Mock mode sends a non-secret `demo` bearer
token for compatibility with auth-enabled mock deployments.

For compatibility with the repository's existing `.env`, `SWIPE_API_KEY` is
accepted as an alias for `SWIPE_API_TOKEN`.

The local mock is the deterministic default. The deployed Fly URL is an
explicit `SWIPE_BACKEND_URL` override, not a hard dependency.

## API compatibility requirements

The mock and live APIs differ and must be adapted explicitly:

- mock customer/product lists return `data` arrays; live returns
  `data.customers` / `data.items`;
- live list endpoints do not support the mock's `search` query, so fuzzy search
  happens client-side;
- `/v2/doc/list` requires `start_date` and `end_date`;
- production `GET /v2/doc/{hash}` wraps the document in
  `data.invoice_details`;
- production rejects deprecated `serial_number` on create, so live idempotency
  must use `serial_number_v2`;
- production currently omits cancelled documents from `payment_status=all`, so
  idempotency recovery searches the cancelled filter explicitly;
- mock payments accept `doc_hash_id`, `amount`, `method`; live payments require
  `customer`, `payment_date`, `payment_mode`, and `documents[]`;
- live non-cash payments require bank details;
- live customer detail is fetched before invoice creation so valid billing and
  shipping addresses can be sent;
- all Swipe success/error envelopes are unwrapped consistently, including HTTP
  200 responses with `success=false`.

## GST and invoice mapping

`create_invoice` accepts one or more typed items:

- `name`, `quantity`, `unit_price`;
- `tax_rate` (default 18), `cess_rate`, `discount_percent`;
- optional `item_type`, `item_id`, `unit`, `hsn_code`, `description`.

Every line is computed with `mock_backend.gst.compute_line_item`. The tool also
uses `compute_document_totals` and `split_gst` to return the local preview.
Computed line amounts are sent in both modes so the request contract is the same
and the live API receives its required fields.

Customer names must resolve to exactly one existing customer. Ambiguous or
missing matches return a recoverable error instead of creating an unintended
party. In live mode `SWIPE_COMPANY_STATE` is required for invoice creation;
mock mode obtains the company state from `/v2/_mock/company`.

## Write safety and idempotency

MCP servers cannot force a confirmation dialog. Write tools are marked with
write/destructive annotations where supported, clearly describe their side
effects, and return readable previews/results. The host/user remains responsible
for approval policy.

Both write tools accept an optional `idempotency_key`:

- invoice keys derive a deterministic serial number and recover an existing
  invoice after retries or process restarts;
- payment keys are embedded in internal notes and checked through the payment
  list before posting;
- an in-memory result cache also deduplicates concurrent retries;
- without a key, each call is intentionally a new write.

No silent live-to-mock write fallback is allowed.

## Errors

The client maps known Swipe error codes to actionable messages while preserving:

- the original `error_code`;
- HTTP status;
- non-sensitive validation details.

Timeouts, invalid JSON, connection failures, ambiguous entity matches, invalid
dates/rates, overpayments, and unsafe live configuration are explicit tool
errors. Tokens are never logged or returned.

## Verification

1. ✅ Unit tests cover GST/body mapping and normalization.
2. ✅ Mocked HTTP tests cover both mock and live envelopes/body shapes.
3. ✅ Service tests cover customer/invoice resolution and idempotent create/pay.
4. ✅ Existing repository tests remain green.
5. ✅ A stdio MCP client starts `python -m swipe_mcp`, discovers exactly eight
   tools, and calls a read tool against a local mock.
6. ✅ Documentation includes Claude Desktop configuration using an absolute
   repository path and interpreter path.
7. ✅ Live production validation covers MCP stdio reads, customer/product/doc
   shapes, GSTIN lookup, invoice create/get/list, payment, ledger, cancellation,
   and idempotent retries across fresh server processes.

## Honest limits

- The server enables interactive and agent-driven workflows; it is not a
  scheduler.
- Approval prompts vary by MCP host.
- Payment idempotency depends on Swipe returning internal notes in payment-list
  results; the in-memory cache still protects retries within one server process.
- Live calls require a real Swipe key and consume its quota; automated tests do
  not mutate a live account.
