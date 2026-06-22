# Swipe MCP server

`python -m swipe_mcp` starts a stdio Model Context Protocol server with eight
tools:

| Tool | Behavior |
|---|---|
| `find_customer` | Ranked local matching over live/mock customer records |
| `list_customers` | Paginated customer list |
| `list_products` | Paginated product/service list |
| `create_invoice` | Existing-customer resolution, GST preview, invoice write |
| `record_payment` | Exact hash/serial resolution and payment write |
| `list_invoices` | Date/status/customer-filtered invoices |
| `customer_outstanding` | Customer ledger and outstanding balance |
| `lookup_gstin` | GSTIN format validation and Swipe portal lookup |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SWIPE_MODE` | `mock` | `mock` or `live` |
| `SWIPE_BACKEND_URL` | `http://127.0.0.1:8000` | Used only in mock mode |
| `SWIPE_API_TOKEN` | empty | Live key; `SWIPE_API_KEY` is an alias |
| `SWIPE_COMPANY_STATE` | empty | Required for live invoice creation |
| `SWIPE_HTTP_TIMEOUT` | `20` | Request timeout in seconds |

The live API base is fixed in code. A mock URL cannot receive the live token.
The repository `.env` is loaded automatically.

## Claude Desktop

Install dependencies with the same interpreter Claude will run:

```bash
/opt/miniconda3/bin/python3 -m pip install -r \
  /Users/siddharthrout/Desktop/Projects/swipe/requirements.txt
```

Add this to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "swipe": {
      "command": "/opt/miniconda3/bin/python3",
      "args": ["-m", "swipe_mcp"],
      "env": {
        "PYTHONPATH": "/Users/siddharthrout/Desktop/Projects/swipe",
        "SWIPE_MODE": "mock",
        "SWIPE_BACKEND_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

Start the local mock before using that configuration:

```bash
cd /Users/siddharthrout/Desktop/Projects/swipe
/opt/miniconda3/bin/python3 -m uvicorn mock_backend.main:app
```

For live mode, change the MCP environment:

```json
{
  "PYTHONPATH": "/Users/siddharthrout/Desktop/Projects/swipe",
  "SWIPE_MODE": "live",
  "SWIPE_COMPANY_STATE": "TELANGANA"
}
```

The API key can remain in the repository `.env` as `SWIPE_API_KEY=...`, or be
provided to the MCP process as `SWIPE_API_TOKEN`.

## Write safety

- MCP hosts decide whether to show approval prompts. The server marks write
  tools as destructive/write operations but cannot force host UI.
- Pass a stable `idempotency_key` for every retriable create/payment call.
- Invoice idempotency uses Swipe's required `serial_number_v2` contract.
- Live non-cash payments require real `bank_details`; the server never invents
  account numbers.
- Live write failures are never redirected to the mock.

## Production smoke test

The smoke script creates a ₹1 invoice with 18% GST, records a ₹0.01 cash
payment, verifies retry deduplication and the ledger, and cancels the document:

```bash
SWIPE_COMPANY_STATE=TELANGANA python scripts/live_mcp_smoke.py
```

It expects the seeded `Acme Industries` customer. Normal unit tests never write
to the live account.
