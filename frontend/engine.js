/* ============================================================================
   Swipe Agent — engine (window.SwipeEngine)
   ----------------------------------------------------------------------------
   The "brain" the UI talks to. Two responsibilities:

   1. Natural-language understanding (client-side): classify intent and pull out
      the customer, amount, GST rate, due date, item and payment method from a
      plain-English sentence. This is the lightweight stand-in for the agent/MCP
      layer — it decides *what* to do.

   2. Real data operations (over HTTP): the actual create / list / pay / ledger /
      GSTIN calls go to the mock backend's REST API (FastAPI, runs locally or in
      the cloud). Nothing is faked — invoices really get created and persisted
      server-side, and the final invoice card is rendered from the backend's own
      computed totals. GST is shown client-side as an instant *preview* before
      the write; the backend re-computes it authoritatively on create.

   Connection (two modes, switchable from the in-app Connection panel):
     • mock — talks to the local FastAPI mock at <backend>            (default)
     • live — talks to the REAL Swipe Partner API at app.getswipe.in
              directly (it sends permissive CORS headers, so no proxy is
              needed), using your real Swipe API key as the bearer token.

   Config precedence (first wins):
     ?mode / ?token / ?api               query params (ad-hoc)
     window.SWIPE_MODE / SWIPE_API_TOKEN / SWIPE_API_BASE   (config.js, from env)
     localStorage swipe_mode / swipe_api_token / swipe_backend  (session)
     defaults: mode=mock  backend=http://127.0.0.1:8000  token="demo"
   An injected window.SWIPE_API_TOKEN (config.js) implies live + that key, so a
   hosted deploy always uses your key with nothing to type.
============================================================================ */
(function () {
  "use strict";

  // ---- config ------------------------------------------------------------ //
  // The real Swipe Partner API. It sends permissive CORS headers, so the
  // browser can call it directly — no proxy needed. `live` mode points here;
  // `mock` mode points at a local FastAPI mock (for the offline/key-free demo).
  var LIVE_API = "https://app.getswipe.in/api/partner";
  function deriveBase(mode, backend) {
    if (mode === "live") return LIVE_API;
    return String(backend || "").replace(/\/+$/, "");
  }
  function isLive() { return CFG.mode === "live"; }
  function readConfig() {
    var qs = new URLSearchParams(location.search);
    // Deployment config (window.SWIPE_*, set by config.js from a host env var)
    // is authoritative — it represents "always use my key". A query param can
    // still override per-request; localStorage is only a local-session fallback.
    var envTok = window.SWIPE_API_TOKEN || "";
    var mode =
      qs.get("mode") ||
      window.SWIPE_MODE ||
      (envTok ? "live" : "") ||           // an injected key implies live
      localStorage.getItem("swipe_mode") ||
      "mock";
    var backend =
      window.SWIPE_API_BASE ||
      localStorage.getItem("swipe_backend") ||
      "http://127.0.0.1:8000";
    // SECURITY: in live mode the base is ALWAYS the real Swipe host — never an
    // attacker-supplied ?api= (or a stale localStorage swipe_api_base). The
    // bearer token in live mode is the real Swipe API key; honouring an
    // override there would let a crafted link (e.g. ?api=https://evil) redirect
    // that key to an attacker's origin on boot. The ?api= escape hatch is a
    // mock-only convenience (token is the worthless "demo") for pointing the
    // demo at a self-hosted mock backend.
    var override = mode === "live" ? "" : (qs.get("api") || localStorage.getItem("swipe_api_base"));
    var tok =
      qs.get("token") ||
      envTok ||
      localStorage.getItem("swipe_api_token") ||
      (mode === "live" ? "" : "demo");
    var base = override ? override : deriveBase(mode, backend);
    // OpenRouter LLM (the agent's brain). Key/model come from config.js (env)
    // or query params; absent → the deterministic regex NLU is used instead.
    var llmKey = qs.get("llm_key") || window.OPENROUTER_API_KEY || localStorage.getItem("openrouter_key") || "";
    var llmModel = qs.get("llm_model") || window.OPENROUTER_MODEL || localStorage.getItem("openrouter_model") || "openai/gpt-4o-mini";
    // Seller's own state/GSTIN. The live API has no company endpoint, so the
    // CGST/SGST-vs-IGST split can't be derived from it — the deploy must supply
    // the seller's state (else we fall back to a default and the split is only
    // a best guess; see SELLER_ASSUMED).
    var sellerGstin = qs.get("seller_gstin") || window.SWIPE_SELLER_GSTIN || "";
    var sellerState = qs.get("seller_state") || window.SWIPE_SELLER_STATE ||
      (sellerGstin ? CODE_STATE[sellerGstin.slice(0, 2)] : "") || "";
    return {
      mode: mode, backend: backend.replace(/\/+$/, ""), base: base.replace(/\/+$/, ""), tok: tok,
      llmKey: llmKey, llmModel: llmModel,
      sellerState: normState(sellerState), sellerGstin: sellerGstin,
    };
  }

  // ---- reference data (filled from the backend at boot) ------------------ //
  var SELLER = { name: "Demo Traders Pvt Ltd", gstin: "36AABCD1234E1Z5", state: "TELANGANA", stateCode: "36" };
  var CUSTOMERS = []; // {id,name,gstin,state,stateCode,company,phone,email}
  var PRODUCTS = []; // {id,name,rate,gst,cess,unit,hsn,item_type}
  var SEED_DOCS = []; // normalized mini-docs (see normDoc)

  // Display-only fallback: the 2-digit GST state code is taken from a party's
  // GSTIN when present (authoritative); this map only fills the code for the
  // rare GSTIN-less party so the cards don't show "()". It is intentionally not
  // exhaustive (an unlisted state simply shows no code) and never feeds the
  // CGST/SGST-vs-IGST decision — that compares state *names* (see computeInvoice).
  var STATE_CODE = {
    TELANGANA: "36", KARNATAKA: "29", MAHARASHTRA: "27", DELHI: "07",
    "TAMIL NADU": "33", GUJARAT: "24", "ANDHRA PRADESH": "37", KERALA: "32",
    "UTTAR PRADESH": "09", "WEST BENGAL": "19", RAJASTHAN: "08", HARYANA: "06",
    PUNJAB: "03", BIHAR: "10", ODISHA: "21", "MADHYA PRADESH": "23",
  };
  // Reverse map (GST state code → name). The live customer list omits the
  // address but returns the GSTIN, whose first two digits encode the state —
  // so we can still resolve place-of-supply for the intra/inter-state split.
  var CODE_STATE = {};
  for (var _s in STATE_CODE) if (STATE_CODE.hasOwnProperty(_s)) CODE_STATE[STATE_CODE[_s]] = _s;
  // The live API returns states code-prefixed ("36-TELANGANA"); strip it.
  function cleanState(s) { return normState(String(s == null ? "" : s).replace(/^\d{1,2}\s*-\s*/, "")); }

  // Built after CODE_STATE/normState exist, since readConfig() resolves the
  // seller state from a configured GSTIN.
  var CFG = readConfig();
  // True when live mode is running without an explicitly-configured seller
  // state — the intra/inter-state split is then a best-effort assumption.
  var SELLER_ASSUMED = false;

  // ---- small helpers ----------------------------------------------------- //
  function money(v) { return Math.round((Number(v) + 1e-9) * 100) / 100; }
  function normState(s) { return String(s == null ? "" : s).trim().toUpperCase(); }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "item"; }
  function titleize(s) { return String(s).trim().replace(/\s+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  // ---- HTML sanitization ------------------------------------------------- //
  // Agent messages are rendered via dangerouslySetInnerHTML and interpolate
  // untrusted strings (customer names from the live API, LLM-authored text). To
  // stop those injecting active content (e.g. a customer named
  // "<img onerror=…>" exfiltrating the in-page API keys), we escape EVERYTHING,
  // then re-enable only a fixed allowlist of attribute-less tags the agent uses
  // for emphasis. No attributes survive, so no event handlers / src can sneak
  // through. This is the single choke point for all rendered HTML.
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function safeHtml(s) {
    return escapeHtml(s)
      .replace(/&lt;(b|i|u|small)&gt;/gi, "<$1>")
      .replace(/&lt;\/(b|i|u|small)&gt;/gi, "</$1>")
      .replace(/&lt;br\s*\/?&gt;/gi, "<br/>");
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function toDate(x) {
    if (x instanceof Date) return isNaN(x.getTime()) ? null : x;
    if (typeof x === "string") {
      var iso = x.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
      var dmy = x.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
      var d = new Date(x);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  function addDays(date, n) { var d = new Date(toDate(date) || new Date()); d.setDate(d.getDate() + (Number(n) || 0)); return d; }
  function ddmmyyyy(date) { var d = toDate(date) || new Date(); return pad2(d.getDate()) + "-" + pad2(d.getMonth() + 1) + "-" + d.getFullYear(); }
  function isoDate(date) { var d = toDate(date) || new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function isoFromDDMMYYYY(s) { var m = s && String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/); return m ? m[3] + "-" + m[2] + "-" + m[1] : (s || null); }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(x) {
    var d = toDate(x);
    if (!d) return "—";
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + String(d.getFullYear()).slice(2);
  }
  function formatINR(n) {
    var v = Number(n) || 0;
    var neg = v < 0;
    var abs = Math.abs(v);
    var hasFrac = Math.round(abs * 100) % 100 !== 0;
    var s = abs.toLocaleString("en-IN", { minimumFractionDigits: hasFrac ? 2 : 0, maximumFractionDigits: 2 });
    return (neg ? "-" : "") + "₹" + s;
  }

  // ---- entity resolution ------------------------------------------------- //
  function findCustomerById(id) {
    for (var i = 0; i < CUSTOMERS.length; i++) if (CUSTOMERS[i].id === id) return CUSTOMERS[i];
    return null;
  }
  function findCustomer(text) {
    var tl = " " + String(text).toLowerCase() + " ";
    for (var i = 0; i < CUSTOMERS.length; i++) {
      var c = CUSTOMERS[i];
      var toks = c.name.toLowerCase().split(/[\s,]+/).concat((c.company || "").toLowerCase().split(/[\s,]+/));
      for (var j = 0; j < toks.length; j++) {
        var t = toks[j];
        if (t.length >= 3 && tl.indexOf(" " + t) !== -1) return c;
      }
    }
    return null;
  }
  function findProduct(text) {
    if (!text) return null;
    var tl = " " + String(text).toLowerCase() + " ";
    for (var i = 0; i < PRODUCTS.length; i++) {
      var first = PRODUCTS[i].name.toLowerCase().split(/[\s(]+/)[0];
      if (first.length >= 3 && tl.indexOf(first) !== -1) return PRODUCTS[i];
    }
    return null;
  }

  // ---- field parsers ----------------------------------------------------- //
  function scaleAmount(numStr, suffix) {
    var val = parseFloat(String(numStr).replace(/,/g, ""));
    if (isNaN(val)) return null;
    var suf = (suffix || "").toLowerCase();
    if (suf === "k") val *= 1e3;
    else if (suf === "l" || suf === "lac" || suf === "lakh" || suf === "lakhs") val *= 1e5;
    else if (suf === "cr" || suf === "crore" || suf === "crores") val *= 1e7;
    return val;
  }
  var AMOUNT_SUFFIX = "(k|l|lac|lakh|lakhs|cr|crore|crores)";
  function parseAmount(text) {
    var s = String(text);
    // Prefer a currency-anchored amount (₹/Rs prefix or a k/l/cr suffix) so a
    // bare "18%" earlier in the sentence isn't mistaken for the amount.
    var anchored =
      s.match(new RegExp("(?:₹|rs\\.?|inr)\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*" + AMOUNT_SUFFIX + "?", "i")) ||
      s.match(new RegExp("(\\d[\\d,]*(?:\\.\\d+)?)\\s*" + AMOUNT_SUFFIX, "i"));
    if (anchored) return scaleAmount(anchored[1], anchored[2]);
    // Fall back to the first plain number that isn't a percentage. Consume the
    // whole number greedily, then check for a trailing "%" so "18%" is skipped.
    var re = /(\d[\d,]*(?:\.\d+)?)(\s*%)?/g, mm;
    while ((mm = re.exec(s)) !== null) {
      if (mm[0] === "") { re.lastIndex++; continue; }
      if (!mm[2]) return scaleAmount(mm[1], null);
    }
    return null;
  }
  function parseGst(text) {
    var m = String(text).match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) return parseFloat(m[1]);
    var m2 = String(text).match(/(?:gst|tax)\s*(?:of|at|@)?\s*(\d+(?:\.\d+)?)/i) ||
             String(text).match(/(\d+(?:\.\d+)?)\s*(?:percent)?\s*gst/i);
    if (m2) return parseFloat(m2[1]);
    return 18; // most common slab; the user usually states it explicitly
  }
  function parseDueDays(text) {
    var m = String(text).match(/due\s+(?:in\s+)?(\d+)\s*days?/i) ||
            String(text).match(/net[-\s]*(\d+)/i) ||
            String(text).match(/in\s+(\d+)\s*days?/i);
    return m ? parseInt(m[1], 10) : 30;
  }
  function parseMethod(text) {
    var tl = String(text).toLowerCase();
    if (/\bupi\b/.test(tl)) return "UPI";
    if (/\bcash\b/.test(tl)) return "Cash";
    if (/credit card|debit card|\bcard\b/.test(tl)) return "Card";
    if (/\bcheque\b|\bcheck\b/.test(tl)) return "Cheque";
    if (/\bemi\b/.test(tl)) return "EMI";
    if (/neft|rtgs|imps|bank\s*transfer|net\s*banking|\bbank\b|\btransfer\b/.test(tl)) return "Bank transfer";
    return "UPI";
  }
  function methodToApi(m) {
    var x = String(m || "").toLowerCase();
    if (x.indexOf("upi") !== -1) return "upi";
    if (x.indexOf("cash") !== -1) return "cash";
    if (x.indexOf("card") !== -1) return "card";
    if (x.indexOf("cheque") !== -1 || x.indexOf("check") !== -1) return "cheque";
    if (x.indexOf("emi") !== -1) return "emi";
    if (/neft|rtgs|imps|bank|net|transfer/.test(x)) return "netBanking";
    return "cash";
  }
  function describeItem(text) {
    var name = null;
    var m = String(text).match(/\bfor\s+([a-z][a-z0-9 &\/-]*?)(?:\s*,|\.|;|\s+gst\b|\s+due\b|\s+at\b|\s+\d|$)/i);
    if (m) name = m[1].trim();
    var prod = findProduct(name || text);
    if (prod) return { id: prod.id, name: titleize(name || prod.name), item_type: prod.item_type, unit: prod.unit, hsn: prod.hsn, product: prod };
    var nm = titleize(name || "Services");
    var svc = /consult|service|maintenance|support|audit|design|develop|retainer|\bfee\b|labour|labor|install/i.test(nm);
    return { id: (svc ? "SVC-" : "GEN-") + slug(nm), name: nm, item_type: svc ? "Service" : "Product", unit: "OTH", hsn: svc ? "9983" : null, product: null };
  }

  // ---- intent classification --------------------------------------------- //
  var GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d)\b/i;
  function classify(text, ctx) {
    var tl = String(text).toLowerCase();
    var gstinM = String(text).match(GSTIN_RE);
    var gstin = gstinM ? gstinM[1].toUpperCase() : null;

    if (gstin || /\bgstin\b|gst number|gst no\.?\b|look ?up.*gst|verify.*gst/.test(tl)) {
      return { intent: "gstin_lookup", gstin: gstin };
    }
    if (/\b(record|received|collected|got)\b.*\b(payment|paid|rupees|₹|upi|cash|cheque|neft|rtgs|card)\b/.test(tl) ||
        /\b(pay(ment)?|paid)\b.*\bagainst\b/.test(tl) ||
        /^\s*(record|log)\b.*\bpay/.test(tl)) {
      return { intent: "record_payment" };
    }
    if (/\b(show|list|find|display|get|what|which|how many)\b.*\b(invoice|invoices|bill|bills|document|documents)\b/.test(tl) ||
        /\b(unpaid|overdue|pending|paid)\s+(invoice|invoices|bills)\b/.test(tl)) {
      return { intent: "list_invoices" };
    }
    if (/\b(customers?|clients?|parties|buyers?)\b/.test(tl) && /\b(show|list|all|my|view|see|who|which|how many)\b/.test(tl)) {
      return { intent: "list_customers" };
    }
    if (/\b(products?|items?|catalog|catalogue|skus?|inventory|what.*sell)\b/.test(tl) && /\b(show|list|all|my|view|see|what|which|how many|sell)\b/.test(tl)) {
      return { intent: "list_products" };
    }
    // Note: deliberately does NOT match "due" (as in "due in 15 days") — that
    // belongs to invoice creation, not a balance lookup.
    if (/\bowe[sd]?\b|\boutstanding\b|\bledger\b|\bbalance\b/.test(tl)) {
      return { intent: "outstanding" };
    }
    if (/\b(invoice|bill|raise|create|generate|new invoice|charge)\b/.test(tl)) {
      return { intent: "create_invoice" };
    }
    if (ctx && ctx.draft && /\b(actually|make it|change|update|set|add|instead|also|switch|increase|decrease|raise it|drop)\b/.test(tl)) {
      return { intent: "edit_draft" };
    }
    return { intent: "unknown" };
  }

  // ---- LLM planner (OpenRouter) ------------------------------------------ //
  // The real "agent": an LLM reads the message + the live catalog and emits ONE
  // tool call (which the app then previews/executes). Falls back to classify()
  // when no key is configured, so the demo still runs key-free.
  var LLM_TOOLS = [
    {
      type: "function",
      function: {
        name: "create_invoice",
        description: "Compose an invoice for a customer. Resolve the customer to an id from the catalog. One entry per line item; unit_price is per-unit and TAX-EXCLUSIVE.",
        parameters: {
          type: "object",
          properties: {
            customer_id: { type: "string", description: "Customer id from the catalog (e.g. CUST002)." },
            customer_name: { type: "string", description: "Customer name if no id matches (a new party)." },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  item_id: { type: "string", description: "Catalog item id if it matches one." },
                  name: { type: "string" },
                  quantity: { type: "number" },
                  unit_price: { type: "number", description: "Per-unit price excluding tax." },
                  tax_rate: { type: "number", description: "GST % (e.g. 18). Default 18 if unstated." },
                  cess_rate: { type: "number" },
                  discount_percent: { type: "number" },
                  item_type: { type: "string", enum: ["Product", "Service"] },
                },
                required: ["name", "quantity", "unit_price", "tax_rate"],
              },
            },
            due_days: { type: "number", description: "Days until due (default 30)." },
          },
          required: ["items"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "record_payment",
        description: "Record a payment against an invoice. 'document_ref' can be an invoice serial (INV-12) or 'last' for the most recent.",
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number" },
            method: { type: "string", enum: ["upi", "cash", "card", "cheque", "emi", "netBanking"] },
            document_ref: { type: "string" },
          },
          required: ["amount"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_invoices",
        description: "List/search invoices by payment status.",
        parameters: {
          type: "object",
          properties: { status: { type: "string", enum: ["all", "unpaid", "paid", "overdue"] } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "customer_outstanding",
        description: "Show a customer's outstanding balance and ledger.",
        parameters: {
          type: "object",
          properties: { customer_id: { type: "string" }, customer_name: { type: "string" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "lookup_gstin",
        description: "Look up / validate a 15-character GSTIN against the GST registry.",
        parameters: { type: "object", properties: { gstin: { type: "string" } }, required: ["gstin"] },
      },
    },
    {
      type: "function",
      function: { name: "list_customers", description: "List all customers on the account.", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: { name: "list_products", description: "List all products/items in the catalog.", parameters: { type: "object", properties: {} } },
    },
    {
      type: "function",
      function: {
        name: "reply",
        description: "Answer a greeting, a general question, or explain what you can do — when no other tool fits.",
        parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    },
  ];

  function buildSystemPrompt(ctx) {
    var custs = CUSTOMERS.map(function (c) {
      return "- " + c.id + " · " + c.name + (c.gstin ? " · GSTIN " + c.gstin : "") + (c.state ? " · " + c.state : "");
    }).join("\n") || "(none yet)";
    var prods = PRODUCTS.map(function (p) {
      return "- " + p.id + " · " + p.name + " · ₹" + p.rate + " · " + p.gst + "% GST · " + p.item_type + (p.unit ? " · " + p.unit : "");
    }).join("\n") || "(none yet)";
    var lines = [
      "You are the agent inside Swipe, an Indian billing/invoicing product. You turn a user's plain-English request into exactly ONE tool call.",
      "Today is " + ddmmyyyy(new Date()) + ". Seller state: " + SELLER.state + " (used for CGST/SGST vs IGST).",
      "",
      "Resolve customers and products to ids from these catalogs. If a customer isn't listed, pass customer_name (a new party will be created). If a product isn't listed, infer item_type and use the user's stated price.",
      "",
      "CUSTOMERS:\n" + custs,
      "",
      "PRODUCTS (unit_price is tax-exclusive):\n" + prods,
      "",
      "Tool routing (decide from THIS message, not the prior turns):",
      "- Money being RECEIVED — 'record/received/got/collected a payment', 'paid ₹X', 'mark X paid' — is ALWAYS record_payment, never create_invoice.",
      "- Billing a customer — 'invoice/bill/charge/raise' — is create_invoice.",
      "- 'show/list/how many' + invoices→list_invoices, + customers→list_customers, + products/items→list_products.",
      "- owes/outstanding/balance/ledger → customer_outstanding. A 15-char GSTIN or 'look up GST' → lookup_gstin.",
      "",
      "Rules: GST defaults to 18% if unstated. Due date defaults to 30 days. Interpret amounts like '50k'=50000, '1.2L'=120000, '2cr'=20000000. For create_invoice, split distinct goods/services into separate items. Never invent invoice numbers; use 'last' or a stated serial for payments. Use 'reply' for chit-chat, help, or anything no tool covers.",
    ];
    if (ctx && ctx.draft && ctx.draft.customer) {
      var d = ctx.draft;
      var dl = d.lines.map(function (l) { return l.qty + "× " + l.name + " @₹" + l.rate + " (" + l.gst + "% GST)"; }).join("; ");
      lines.push("", "There is a PENDING UNCONFIRMED invoice draft for " + d.customer.name + ": " + dl + ". If the user is amending it (e.g. 'make it 28%', 'add 10 gloves'), re-emit create_invoice for the SAME customer with the full updated item list.");
    }
    return lines.join("\n");
  }

  function llmPlan(text, ctx) {
    var messages = [{ role: "system", content: buildSystemPrompt(ctx) }];
    (ctx && ctx.history ? ctx.history : []).forEach(function (h) {
      if (h && h.text) messages.push({ role: h.role === "user" ? "user" : "assistant", content: h.text });
    });
    messages.push({ role: "user", content: String(text) });
    return fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + CFG.llmKey,
        "X-Title": "Swipe Agent",
      },
      body: JSON.stringify({
        model: CFG.llmModel, messages: messages,
        tools: LLM_TOOLS, tool_choice: "auto", temperature: 0,
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error && data.error.message) || ("LLM error " + res.status));
        var m = data.choices && data.choices[0] && data.choices[0].message;
        var tc = m && m.tool_calls && m.tool_calls[0];
        if (tc) {
          // Arguments are model-authored JSON. On a parse failure we fall back
          // to {} — the plan builders then re-parse the raw sentence (regex), so
          // a garbled tool call degrades to best-effort rather than throwing.
          var args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (e) { args = {}; }
          if (!args || typeof args !== "object") args = {};
          return { tool: tc.function.name, args: args };
        }
        return { tool: "reply", args: { message: (m && m.content) || "" } };
      });
    });
  }

  // ---- GST preview (client mirror of mock_backend/gst.py) ---------------- //
  function computeInvoice(lines, customer) {
    var intra = normState(customer && customer.state) === normState(SELLER.state);
    var out = lines.map(function (l) {
      var rate = (Number(l.gst) || 0) + (Number(l.cess) || 0);
      var gross = (Number(l.qty) || 0) * (Number(l.rate) || 0);
      var disc = 0;
      if (l.discountPercent) disc = (gross * l.discountPercent) / 100;
      else if (l.discountAmount) disc = Number(l.discountAmount);
      disc = Math.max(0, Math.min(disc, gross));
      var net = gross - disc;
      var tax = (net * rate) / 100;
      return Object.assign({}, l, { net: money(net), tax: money(tax), total: money(net + tax) });
    });
    var net = money(out.reduce(function (s, l) { return s + l.net; }, 0));
    var tax = money(out.reduce(function (s, l) { return s + l.tax; }, 0));
    var grand = money(net + tax);
    var breakup;
    if (intra) {
      var cgst = money(tax / 2);
      breakup = [{ label: "CGST", amount: cgst }, { label: "SGST", amount: money(tax - cgst) }];
    } else {
      breakup = [{ label: "IGST", amount: tax }];
    }
    return {
      lines: out, net: net, tax: tax, grand: grand, intra: intra, breakup: breakup,
      slabs: distinctSlabs(lines), assumed: SELLER_ASSUMED,
    };
  }

  // Distinct GST rates present on a line set (so a multi-rate invoice doesn't
  // misreport itself as a single slab).
  function distinctSlabs(lines) {
    var seen = {}, out = [];
    (lines || []).forEach(function (l) {
      var r = Number(l.gst) || 0;
      if (!seen[r]) { seen[r] = true; out.push({ rate: r }); }
    });
    return out.length ? out : [{ rate: 0 }];
  }

  // ---- document helpers (operate on normalized mini-docs) ---------------- //
  function docTotals(doc) {
    var customer = findCustomerById(doc.customerId) ||
      { id: doc.customerId, name: doc.customerName || "Customer", state: "", stateCode: "", gstin: doc.gstin || "" };
    var grand = money(Number(doc.grand) || 0); // always the backend's total_amount
    var paid = money(Number(doc.paid) || 0);
    return { customer: customer, grand: grand, paid: paid, due: money(grand - paid) };
  }
  function docStatus(doc) {
    if (doc.cancelled || doc.status === "cancelled") return "cancelled";
    var t = docTotals(doc);
    if (t.due <= 0.01) return "paid";
    var due = toDate(doc.dueDate);
    if (due && due < startOfToday()) return "overdue";
    if (t.paid > 0) return "partial";
    return "pending";
  }
  function startOfToday() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }

  function normDoc(t) {
    return {
      hash_id: t.hash_id,
      serial: t.serial_number,
      customerId: t.customer && t.customer.id,
      customerName: t.customer && t.customer.name,
      gstin: t.customer && t.customer.gstin,
      date: isoFromDDMMYYYY(t.document_date),
      dueDate: isoFromDDMMYYYY(t.due_date),
      net: t.net_amount,
      tax: t.tax_amount,
      grand: t.total_amount,
      paid: t.amount_paid,
      status: t.payment_status,
      cancelled: t.payment_status === "cancelled",
      item: "",
    };
  }
  function partyState(p) {
    if (!p) return "";
    var b = p.billing_address;
    if (Array.isArray(b)) b = b[0];
    return b && b.state ? cleanState(b.state) : "";
  }
  function invFromDetail(d) {
    // Live nests the document under `invoice_details`; the mock returns it bare.
    if (d && d.invoice_details) d = Array.isArray(d.invoice_details) ? d.invoice_details[0] : d.invoice_details;
    var lines = (d.items || []).map(function (it) {
      return {
        name: it.name, qty: it.quantity, rate: it.unit_price, gst: it.tax_rate,
        unit: it.unit, hsn: it.hsn_code,
        net: it.net_amount, tax: it.tax_amount, total: it.total_amount,
      };
    });
    var tb = d.tax_breakup, intra, assumed = false;
    if (tb) {
      intra = (Number(tb.igst) || 0) === 0;
    } else {
      // Live returns no breakup — derive it from place-of-supply vs the seller's
      // state and split the authoritative total tax accordingly. When the seller
      // state isn't configured (SELLER_ASSUMED), this split is a best guess —
      // the grand total from the API is still correct.
      var ps = partyState(d.party);
      intra = !ps || ps === normState(SELLER.state);
      assumed = SELLER_ASSUMED;
      var tax = Number(d.tax_amount) || 0;
      tb = intra ? { cgst: money(tax / 2), sgst: money(tax - money(tax / 2)), igst: 0 } : { cgst: 0, sgst: 0, igst: tax };
    }
    var breakup = intra
      ? [{ label: "CGST", amount: tb.cgst || 0 }, { label: "SGST", amount: tb.sgst || 0 }]
      : [{ label: "IGST", amount: tb.igst || 0 }];
    return {
      lines: lines, net: d.net_amount, tax: d.tax_amount, grand: d.total_amount,
      intra: intra, breakup: breakup, slabs: distinctSlabs(lines), assumed: assumed,
    };
  }

  // ---- HTTP client ------------------------------------------------------- //
  // Defence-in-depth: in live mode the bearer token is the real Swipe key, so
  // it must only ever leave the browser bound for the real Swipe host. The base
  // is already pinned to LIVE_API for live mode (see readConfig), but we re-check
  // the resolved origin here and fail CLOSED if it has somehow drifted, rather
  // than ever attaching the key to an unexpected origin.
  function assertLiveBaseSafe() {
    if (CFG.mode !== "live") return;
    try {
      if (new URL(CFG.base).origin !== new URL(LIVE_API).origin) {
        throw new Error("Refusing to send the live Swipe key to an unexpected host (" + CFG.base + ").");
      }
    } catch (e) {
      throw new Error("Invalid live API base: " + CFG.base);
    }
  }
  function apiCall(method, path, body) {
    assertLiveBaseSafe();
    return fetch(CFG.base + path, {
      method: method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.tok },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || (data && data.success === false)) {
          var err = new Error((data && data.message) || ("Request failed (" + res.status + ")"));
          err.code = (data && data.error_code) || String(res.status);
          throw err;
        }
        return data ? data.data : null;
      });
    });
  }
  function apiGet(path) { return apiCall("GET", path); }

  var DOC_QUERY = "document_type=invoice&start_date=01-01-2000&end_date=31-12-2099&payment_status=all&num_records=100";

  function listInvoices() {
    return apiGet("/v2/doc/list?" + DOC_QUERY).then(function (data) {
      return ((data && data.transactions) || []).map(normDoc);
    });
  }
  function refreshDocs() {
    return listInvoices().then(function (docs) {
      SEED_DOCS.length = 0;
      docs.forEach(function (d) { SEED_DOCS.push(d); });
      return docs;
    });
  }

  // The live API requires fully-computed line amounts (we send our own preview
  // totals; it recomputes authoritatively); the mock derives them server-side
  // from the minimal inputs. Pass `computed` for live, null for mock.
  function buildItems(draft, computed) {
    return draft.lines.map(function (l, i) {
      var item = {
        id: l.id || ("GEN-" + slug(l.name)),
        name: l.name,
        item_type: l.item_type || "Product",
        quantity: Number(l.qty) || 0,
        unit_price: Number(l.rate) || 0,
        tax_rate: Number(l.gst) || 0,
        cess_rate: Number(l.cess) || 0,
        // The live API rejects nulls here, so always send a number / omit blanks.
        discount_percent: Number(l.discountPercent) || 0,
      };
      if (l.hsn) item.hsn_code = l.hsn;
      if (l.unit) item.unit = l.unit;
      if (computed) {
        var cl = computed.lines[i];
        var rate = (Number(l.gst) || 0) + (Number(l.cess) || 0);
        item.net_amount = cl.net;
        item.tax_amount = cl.tax;
        item.total_amount = cl.total;
        item.price_with_tax = money((Number(l.rate) || 0) * (1 + rate / 100));
      }
      return item;
    });
  }

  // A full AddressV2 for the live doc party (the live customer list omits the
  // address; we fetch it and fall back to placeholders + GSTIN-derived state).
  function liveAddr(a, idV2, fallbackState) {
    a = a || {};
    return {
      addr_id_v2: idV2,
      address_line1: a.address_line1 || "NA",
      address_line2: a.address_line2 || "",
      city: a.city || "NA",
      state: cleanState(a.state) || normState(fallbackState) || normState(SELLER.state),
      country: a.country || "India",
      pincode: a.pincode || "000000",
    };
  }

  function postDoc(body) {
    return apiCall("POST", "/v2/doc", body).then(function (data) {
      return apiGet("/v2/doc/" + data.hash_id).then(function (detail) {
        return { hash_id: data.hash_id, serial: data.serial_number, inv: invFromDetail(detail), detail: detail };
      });
    });
  }

  function createInvoiceLive(draft) {
    var c = draft.customer;
    var computed = computeInvoice(draft.lines, c);
    var items = buildItems(draft, computed);
    // Fetch the stored customer to recover a valid billing/shipping address.
    return apiGet("/v2/customer/" + encodeURIComponent(c.id)).then(function (cd) {
      var cust = Array.isArray(cd) ? cd[0] : cd || {};
      var bAddr = (cust.billing_address || [])[0];
      var sAddr = (cust.shipping_address || [])[0] || bAddr;
      var body = {
        document_type: "invoice",
        document_date: ddmmyyyy(new Date()),
        due_date: ddmmyyyy(draft.dueDate),
        party: {
          id: c.id, type: "customer", name: c.name,
          gstin: c.gstin || undefined, company_name: c.company || undefined,
          phone_number: c.phone || undefined, email: c.email || undefined,
          billing_address: liveAddr(bAddr, "b" + c.id, c.state),
          shipping_address: liveAddr(sAddr, "s" + c.id, c.state),
        },
        items: items,
      };
      return postDoc(body);
    });
  }

  function createInvoiceMock(draft) {
    var c = draft.customer;
    var addr = { state: c.state || null };
    var body = {
      document_type: "invoice",
      document_date: ddmmyyyy(new Date()),
      due_date: ddmmyyyy(draft.dueDate),
      party: {
        id: c.id, type: "customer", name: c.name,
        gstin: c.gstin || null, company_name: c.company || null,
        phone_number: c.phone || null, email: c.email || null,
        billing_address: addr, shipping_address: addr,
      },
      items: buildItems(draft, null),
    };
    return postDoc(body);
  }

  // Idempotency guard: writes have no server idempotency key, so we dedupe
  // client-side by a fingerprint of the draft. A double-click or a re-confirm of
  // the SAME draft reuses the in-flight / resolved create instead of POSTing
  // twice. On failure we clear it so a genuine retry works. (Residual limit: a
  // lost response *after* the server created the doc can't be deduped without a
  // server-side key — surface this by refreshing the list before re-confirming.)
  var _createInflight = {};
  function draftFingerprint(draft) {
    var c = draft.customer || {};
    var items = (draft.lines || []).map(function (l) {
      return [l.id, l.name, l.qty, l.rate, l.gst, l.cess, l.discountPercent].join(":");
    }).join("|");
    return [c.id, draft.dueDays, items].join("~");
  }
  function createInvoice(draft) {
    var fp = draftFingerprint(draft);
    if (_createInflight[fp]) return _createInflight[fp];
    var p = isLive() ? createInvoiceLive(draft) : createInvoiceMock(draft);
    _createInflight[fp] = p;
    p.catch(function () { delete _createInflight[fp]; });
    return p;
  }

  // Live payment_mode enum is Title Case ("UPI", "Net Banking", …) and differs
  // from the v2 doc-embedded method enum.
  function methodToLive(m) {
    var x = String(m || "").toLowerCase();
    if (x.indexOf("upi") !== -1) return "UPI";
    if (x.indexOf("cash") !== -1) return "Cash";
    if (x.indexOf("card") !== -1) return "Card";
    if (x.indexOf("cheque") !== -1 || x.indexOf("check") !== -1) return "Cheque";
    if (x.indexOf("emi") !== -1) return "EMI";
    if (/neft|rtgs|imps|bank|net|transfer/.test(x)) return "Net Banking";
    return "Cash";
  }

  function recordPayment(args) {
    var amount = Number(args.amount) || 0;
    if (isLive()) {
      var mode = methodToLive(args.method);
      var body = {
        amount: amount,
        customer: args.doc.customerId,
        payment_date: ddmmyyyy(new Date()),
        payment_mode: mode,
        documents: [{ hash_id: args.doc.hash_id, amount_paying: amount }],
      };
      // The live API rejects non-cash payments without bank details.
      if (mode !== "Cash") {
        body.bank_details = { account_number: "000000000000", ifsc: "HDFC0000001", bank_name: "HDFC Bank", branch: "Demo" };
      }
      return apiCall("POST", "/v2/payment", body);
    }
    return apiCall("POST", "/v2/payment", {
      doc_hash_id: args.doc.hash_id, amount: amount, method: methodToApi(args.method),
    });
  }

  function ledger(customerId) {
    if (isLive()) {
      var q = "customer_id=" + encodeURIComponent(customerId) +
        "&start_date=01-01-2000&end_date=31-12-2099&num_records=100";
      return apiGet("/v2/customer/ledger?" + q).then(function (d) {
        d = d || {};
        var entries = (d.ledger || []).filter(function (e) { return e.date; }).map(function (e) {
          var isPay = !!e.mode || /^PAY/i.test(e.serial_number || "");
          var amt = Number(e.total_amount) || 0;
          return {
            date: isoFromDDMMYYYY(e.date), label: e.serial_number || (isPay ? "Payment" : "Invoice"),
            debit: isPay ? 0 : amt, credit: isPay ? amt : 0,
            balance: -(Number(e.balance) || 0), // live balance is negative when owed
          };
        });
        return { entries: entries, outstanding: -(Number(d.closing_balance) || 0), opening: 0 };
      });
    }
    return apiGet("/v2/customer/ledger?customer_id=" + encodeURIComponent(customerId)).then(function (d) {
      var entries = (d.transactions || []).map(function (t) {
        return { date: isoFromDDMMYYYY(t.date), label: t.particulars, debit: t.debit || 0, credit: t.credit || 0, balance: t.balance };
      });
      return { entries: entries, outstanding: d.closing_balance, opening: d.opening_balance };
    });
  }

  function lookupGstin(gstin) {
    return apiGet("/v2/utils/gstin/" + encodeURIComponent(gstin)).then(function (d) {
      return {
        legal: d.legal_name || "—", trade: d.trade_name || "—",
        state: d.state || "—", stateCode: (d.gstin || "").slice(0, 2),
        gstin: d.gstin || gstin, type: d.taxpayer_type || "Regular", status: d.status || "Active",
      };
    });
  }

  // ---- boot / connection ------------------------------------------------- //
  // The mock returns `data` as a bare array; the live API wraps it
  // (`data.customers`, `data.items`). Accept either, plus a `transactions`
  // fallback, so the same client drives both.
  function asList(data, keys) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      for (var i = 0; i < keys.length; i++) if (Array.isArray(data[keys[i]])) return data[keys[i]];
    }
    return [];
  }
  function fillCustomers(data) {
    CUSTOMERS.length = 0;
    asList(data, ["customers"]).forEach(function (c) {
      // The live API lists unmapped customers with a null id (e.g. the
      // "Default Customer" placeholder) — skip those; they aren't addressable.
      if (c.customer_id == null) return;
      var ba = c.billing_address && c.billing_address[0];
      var code = (c.gstin && c.gstin.slice(0, 2)) || "";
      // Prefer the address state; else recover it from the GSTIN's state code
      // (the live list has no address but does carry the GSTIN).
      var state = cleanState(ba && ba.state) || CODE_STATE[code] || "";
      if (!code) code = STATE_CODE[state] || "";
      CUSTOMERS.push({
        id: c.customer_id, name: c.name, gstin: c.gstin || "", state: state,
        stateCode: code, company: c.company_name || "", phone: c.phone || "", email: c.email || "",
      });
    });
  }
  function fillProducts(data) {
    PRODUCTS.length = 0;
    asList(data, ["items", "products"]).forEach(function (p) {
      // Field names differ live vs mock: id/item_id, unit_price/selling_price.
      var id = p.item_id != null ? p.item_id : p.id;
      if (id == null) return; // skip the live "Sample Product" placeholder
      var rate = p.selling_price != null ? p.selling_price : p.unit_price;
      PRODUCTS.push({
        id: id, name: p.name, rate: rate, gst: p.tax_rate,
        cess: p.cess_rate || 0, unit: p.unit, hsn: p.hsn_code, item_type: p.item_type,
      });
    });
  }

  function boot() {
    // `_mock/company` is a mock-only convenience; the live API has no company
    // endpoint. In live mode the seller identity comes from config (if set),
    // else stays at the default and the intra/inter split is flagged assumed.
    var company;
    if (isLive()) {
      company = Promise.resolve(null);
      if (CFG.sellerState) {
        SELLER.state = CFG.sellerState;
        SELLER.stateCode = (CFG.sellerGstin || "").slice(0, 2) || STATE_CODE[CFG.sellerState] || SELLER.stateCode;
        if (CFG.sellerGstin) SELLER.gstin = CFG.sellerGstin;
        SELLER.name = "Your business";
        SELLER_ASSUMED = false;
      } else {
        SELLER_ASSUMED = true; // no configured seller state → split is a guess
      }
    } else {
      SELLER_ASSUMED = false;
      company = fetch(CFG.base + "/v2/_mock/company")
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return Promise.all([
      company,
      apiGet("/v2/customer/list?num_records=100"),
      apiGet("/v2/product/list?num_records=100"),
      listInvoices(),
    ]).then(function (res) {
      var co = res[0];
      if (co && co.state) {
        SELLER.name = co.name || SELLER.name;
        SELLER.gstin = co.gstin || SELLER.gstin;
        SELLER.state = normState(co.state);
        SELLER.stateCode = (co.gstin || "").slice(0, 2) || SELLER.stateCode;
      }
      fillCustomers(res[1]);
      fillProducts(res[2]);
      SEED_DOCS.length = 0;
      res[3].forEach(function (d) { SEED_DOCS.push(d); });
      Engine.online = true;
      Engine.lastError = null;
    }).catch(function (e) {
      Engine.online = false;
      Engine.lastError = (e && e.message) || "Cannot reach the Swipe API.";
    });
  }
  function reconnect() { return boot().then(function () { return Engine.online; }); }

  // Apply new connection settings (from the in-app Connection panel), persist
  // them, then re-boot against the new target. Returns whether we connected.
  function configure(opts) {
    opts = opts || {};
    if (opts.mode != null) { CFG.mode = opts.mode; localStorage.setItem("swipe_mode", opts.mode); }
    if (opts.backend != null) { CFG.backend = String(opts.backend).replace(/\/+$/, ""); localStorage.setItem("swipe_backend", CFG.backend); }
    if (opts.token != null) { CFG.tok = opts.token; localStorage.setItem("swipe_api_token", opts.token); }
    // A saved choice always recomputes the base from (mode, backend), so drop
    // any legacy full-base override that would otherwise pin it.
    localStorage.removeItem("swipe_api_base");
    CFG.base = deriveBase(CFG.mode, CFG.backend);
    Engine.apiBase = CFG.base; Engine.token = CFG.tok; Engine.mode = CFG.mode; Engine.backend = CFG.backend;
    return reconnect();
  }
  function resetBackend() {
    return fetch(CFG.base + "/v2/_mock/reset", { method: "POST" })
      .then(function () { return boot(); })
      .then(function () { return SEED_DOCS.slice(); });
  }

  // ---- export ------------------------------------------------------------ //
  var Engine = {
    // config / status
    apiBase: CFG.base, token: CFG.tok, mode: CFG.mode, backend: CFG.backend,
    online: false, lastError: null, ready: null,
    // reference data (mutated in place by boot)
    SELLER: SELLER, CUSTOMERS: CUSTOMERS, PRODUCTS: PRODUCTS, SEED_DOCS: SEED_DOCS, TODAY: new Date(),
    // formatting + sanitization
    formatINR: formatINR, fmtDate: fmtDate, addDays: addDays, safeHtml: safeHtml, escapeHtml: escapeHtml,
    // NLU + LLM planner
    classify: classify, llmPlan: llmPlan, llmEnabled: !!CFG.llmKey, llmModel: CFG.llmModel,
    findCustomer: findCustomer, findCustomerById: findCustomerById, findProduct: findProduct,
    parseAmount: parseAmount, parseGst: parseGst, parseDueDays: parseDueDays,
    parseMethod: parseMethod, describeItem: describeItem, GSTIN_RE: GSTIN_RE,
    // math
    computeInvoice: computeInvoice, docTotals: docTotals, docStatus: docStatus,
    // backend operations
    createInvoice: createInvoice, recordPayment: recordPayment, listInvoices: listInvoices,
    refreshDocs: refreshDocs, ledger: ledger, lookupGstin: lookupGstin,
    reconnect: reconnect, resetBackend: resetBackend, configure: configure,
  };
  window.SwipeEngine = Engine;
  Engine.ready = boot(); // kick off; resolves whether or not the backend is up
})();
