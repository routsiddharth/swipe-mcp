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

   Config (any of these, first wins):
     ?api=<base>&token=<tok>   query params
     localStorage swipe_api_base / swipe_api_token
     window.SWIPE_API_BASE / window.SWIPE_API_TOKEN
     defaults: http://127.0.0.1:8000  /  "demo" (any non-empty token works)
============================================================================ */
(function () {
  "use strict";

  // ---- config ------------------------------------------------------------ //
  function readConfig() {
    var qs = new URLSearchParams(location.search);
    var base =
      qs.get("api") ||
      localStorage.getItem("swipe_api_base") ||
      window.SWIPE_API_BASE ||
      "http://127.0.0.1:8000";
    var tok =
      qs.get("token") ||
      localStorage.getItem("swipe_api_token") ||
      window.SWIPE_API_TOKEN ||
      "demo";
    return { base: base.replace(/\/+$/, ""), tok: tok };
  }
  var CFG = readConfig();

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

  // ---- small helpers ----------------------------------------------------- //
  function money(v) { return Math.round((Number(v) + 1e-9) * 100) / 100; }
  function normState(s) { return String(s == null ? "" : s).trim().toUpperCase(); }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "item"; }
  function titleize(s) { return String(s).trim().replace(/\s+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

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
    var slabs = [{ rate: Number(lines[0] && lines[0].gst) || 0 }];
    return { lines: out, net: net, tax: tax, grand: grand, intra: intra, breakup: breakup, slabs: slabs };
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
  function invFromDetail(d) {
    var lines = (d.items || []).map(function (it) {
      return {
        name: it.name, qty: it.quantity, rate: it.unit_price, gst: it.tax_rate,
        unit: it.unit, hsn: it.hsn_code,
        net: it.net_amount, tax: it.tax_amount, total: it.total_amount,
      };
    });
    var tb = d.tax_breakup || { cgst: 0, sgst: 0, igst: 0 };
    var intra = (Number(tb.igst) || 0) === 0;
    var breakup = intra
      ? [{ label: "CGST", amount: tb.cgst || 0 }, { label: "SGST", amount: tb.sgst || 0 }]
      : [{ label: "IGST", amount: tb.igst || 0 }];
    return {
      lines: lines, net: d.net_amount, tax: d.tax_amount, grand: d.total_amount,
      intra: intra, breakup: breakup, slabs: [{ rate: Number(lines[0] && lines[0].gst) || 0 }],
    };
  }

  // ---- HTTP client ------------------------------------------------------- //
  function apiCall(method, path, body) {
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

  function createInvoice(draft) {
    var c = draft.customer;
    var items = draft.lines.map(function (l) {
      return {
        id: l.id || ("GEN-" + slug(l.name)),
        name: l.name,
        item_type: l.item_type || "Product",
        quantity: Number(l.qty) || 0,
        unit_price: Number(l.rate) || 0,
        tax_rate: Number(l.gst) || 0,
        cess_rate: Number(l.cess) || 0,
        hsn_code: l.hsn || null,
        unit: l.unit || null,
        discount_percent: l.discountPercent != null ? l.discountPercent : null,
      };
    });
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
      items: items,
    };
    return apiCall("POST", "/v2/doc", body).then(function (data) {
      return apiGet("/v2/doc/" + data.hash_id).then(function (detail) {
        return { hash_id: data.hash_id, serial: data.serial_number, inv: invFromDetail(detail), detail: detail };
      });
    });
  }

  function recordPayment(args) {
    return apiCall("POST", "/v2/payment", {
      doc_hash_id: args.doc.hash_id,
      amount: Number(args.amount) || 0,
      method: methodToApi(args.method),
    });
  }

  function ledger(customerId) {
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
  function fillCustomers(list) {
    CUSTOMERS.length = 0;
    (list || []).forEach(function (c) {
      var ba = c.billing_address && c.billing_address[0];
      var state = normState(ba && ba.state);
      var code = (c.gstin && c.gstin.slice(0, 2)) || STATE_CODE[state] || "";
      CUSTOMERS.push({
        id: c.customer_id, name: c.name, gstin: c.gstin || "", state: state,
        stateCode: code, company: c.company_name || "", phone: c.phone || "", email: c.email || "",
      });
    });
  }
  function fillProducts(list) {
    PRODUCTS.length = 0;
    (list || []).forEach(function (p) {
      PRODUCTS.push({
        id: p.item_id, name: p.name, rate: p.selling_price, gst: p.tax_rate,
        cess: p.cess_rate || 0, unit: p.unit, hsn: p.hsn_code, item_type: p.item_type,
      });
    });
  }

  function boot() {
    var company = fetch(CFG.base + "/v2/_mock/company")
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
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
  function resetBackend() {
    return fetch(CFG.base + "/v2/_mock/reset", { method: "POST" })
      .then(function () { return boot(); })
      .then(function () { return SEED_DOCS.slice(); });
  }

  // ---- export ------------------------------------------------------------ //
  var Engine = {
    // config / status
    apiBase: CFG.base, token: CFG.tok, online: false, lastError: null, ready: null,
    // reference data (mutated in place by boot)
    SELLER: SELLER, CUSTOMERS: CUSTOMERS, PRODUCTS: PRODUCTS, SEED_DOCS: SEED_DOCS, TODAY: new Date(),
    // formatting
    formatINR: formatINR, fmtDate: fmtDate, addDays: addDays,
    // NLU
    classify: classify, findCustomer: findCustomer, findCustomerById: findCustomerById,
    parseAmount: parseAmount, parseGst: parseGst, parseDueDays: parseDueDays,
    parseMethod: parseMethod, describeItem: describeItem, GSTIN_RE: GSTIN_RE,
    // math
    computeInvoice: computeInvoice, docTotals: docTotals, docStatus: docStatus,
    // backend operations
    createInvoice: createInvoice, recordPayment: recordPayment, listInvoices: listInvoices,
    refreshDocs: refreshDocs, ledger: ledger, lookupGstin: lookupGstin,
    reconnect: reconnect, resetBackend: resetBackend,
  };
  window.SwipeEngine = Engine;
  Engine.ready = boot(); // kick off; resolves whether or not the backend is up
})();
