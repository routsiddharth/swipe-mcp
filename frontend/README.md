# Swipe Agent — conversational frontend

A single conversational surface for Swipe: you type plain English, an agent
composes the action (resolving the customer, doing the GST line-item math),
shows you the work, and — on confirm for writes — drives the **mock backend**'s
REST API for real. No CRUD screens, no forms; one input.

It's a thin web surface built with React + Babel loaded straight in the browser
(no build step). The heavy lifting (persistence, authoritative GST math, valid
API calls) lives in the backend.

## What's real vs. illustrative

- **Real:** every data operation hits the FastAPI mock backend over HTTP and
  persists there — create invoice (`POST /v2/doc`), record payment
  (`POST /v2/payment`), list (`GET /v2/doc/list`), ledger
  (`GET /v2/customer/ledger`), GSTIN lookup (`GET /v2/utils/gstin/{gstin}`).
  Reference data (customers, products, the seller's state) is loaded from the
  backend at startup. The **final invoice card is rendered from the backend's
  own computed totals**, fetched back via `GET /v2/doc/{hash_id}`.
- **Illustrative:** the natural-language parsing and the streamed "MCP tool
  call" trace are a lightweight **client-side stand-in for the agent / MCP
  layer** (`engine.js`). They decide *what* to do; the backend is what actually
  does it. The pre-confirm GST breakdown is an instant client preview that
  mirrors `mock_backend/gst.py`; the backend recomputes it authoritatively on
  create. There is no LLM or MCP server in the loop yet — wiring this same UI to
  a real agent + MCP server is the natural next step.

Nothing is faked: if the backend is unreachable, the app says so (a "Backend
offline" banner) rather than inventing data.

## Run it (~30 seconds)

From the repo root, start the backend (see the root `README.md`):

```bash
uvicorn mock_backend.main:app          # http://127.0.0.1:8000
```

Then serve this folder over HTTP (any static server; `file://` won't work
because the browser blocks cross-origin `fetch` from a file origin):

```bash
cd frontend
python3 -m http.server 5500            # then open http://127.0.0.1:5500/
```

Click **Auto-demo** to watch the golden path run itself, or type one of the
example prompts.

## Configuration

The API base URL and bearer token are resolved in this order (first wins):

| Source | Base URL | Token |
|--------|----------|-------|
| Query param | `?api=<url>` | `?token=<tok>` |
| localStorage | `swipe_api_base` | `swipe_api_token` |
| Global | `window.SWIPE_API_BASE` | `window.SWIPE_API_TOKEN` |
| Default | `http://127.0.0.1:8000` | `demo` |

To point the demo at a cloud-hosted backend, append `?api=https://your-host`.
In mock mode any non-empty token is accepted.

## Files

```
index.html        loads fonts, React + Babel, then engine.js and the .jsx views
engine.js         window.SwipeEngine — NLU + GST preview + the backend HTTP client
app.jsx           App orchestration: intent → plan → stream → confirm → write
chat.jsx          conversation UI (messages, tool-call trace, confirm bar, empty state)
cards.jsx         result cards (invoice, payment, doc list, ledger, GSTIN) + icons
tweaks-panel.jsx  reusable design-tweak panel (host edit-mode protocol)
styles.css        design system (neobrutalist light/dark, "calm" variant)
```

`engine.js` must load before the `.jsx` files (the HTML already orders them
correctly); the app mounts only after `SwipeEngine.ready` resolves, so the first
render has its reference data.
