/* ============================================================================
   Swipe Agent — result cards (read-only renderings of agent tool output)
============================================================================ */
const { formatINR: INR, fmtDate, docTotals, docStatus } = window.SwipeEngine;

/* ---- tiny icon set ----------------------------------------------------- */
function Ic({ d, size = 16, sw = 2.4, fill = "none" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
         strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}
const ICONS = {
  check: "M4 12.5l5 5L20 6",
  lock: ["M6 11V8a6 6 0 0 1 12 0v3", "M5 11h14v10H5z"],
  file: ["M6 2h8l4 4v16H6z", "M14 2v4h4"],
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  arrow: "M5 12h14M13 6l6 6-6 6",
  rupee: ["M6 4h12", "M6 8h12", "M16 4c0 5-4 6-8 6l8 10"],
  bank: ["M3 10l9-6 9 6", "M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18"],
  pdf: ["M6 2h8l4 4v16H6z", "M14 2v4h4", "M9 13h1.5a1.5 1.5 0 0 1 0 3H9zM9 13v6"],
};
function StatusBadge({ status }) {
  const map = { paid: "Paid", partial: "Partially paid", pending: "Pending", overdue: "Overdue", draft: "Draft" };
  return <span className={"status-badge status-" + status}>{map[status] || status}</span>;
}

/* ---- Invoice / GST breakdown ------------------------------------------ */
function InvoiceCard({ inv, customer, meta, status, serial }) {
  const isDraft = status === "draft";
  return (
    <div className="card">
      <div className="card-top">
        <span className="tag">{serial || "PREVIEW"}</span>
        <div style={{ flex: 1 }}>
          <h3>{isDraft ? "Invoice preview" : "Tax Invoice"}</h3>
          <div className="sub">{isDraft ? "Review before it's created" : "Created via MCP · create_document"}</div>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="card-body">
        <div className="party-grid">
          <div className="field">
            <div className="k">Billed to</div>
            <div className="v">{customer.name}<br /><small>GSTIN {customer.gstin}</small></div>
          </div>
          <div className="field" style={{ textAlign: "right" }}>
            <div className="k">Place of supply</div>
            <div className="v">{customer.state} ({customer.stateCode})<br /><small>Due {fmtDate(meta.dueDate)}</small></div>
          </div>
        </div>

        <table className="items">
          <thead>
            <tr><th>Item</th><th>Qty</th><th>Rate</th><th>Taxable</th><th>GST</th><th>Total</th></tr>
          </thead>
          <tbody>
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.name}<div className="hsn">HSN {l.hsn || "—"}</div></td>
                <td>{l.qty} {l.unit || ""}</td>
                <td>{INR(l.rate)}</td>
                <td>{INR(l.net)}</td>
                <td>{l.gst}%<br /><span className="hsn">{INR(l.tax)}</span></td>
                <td>{INR(l.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="totals">
          <div className="totline"><span className="lab">Taxable value</span><span className="val">{INR(inv.net)}</span></div>
          {inv.breakup.map((b, i) => (
            <div className="totline" key={i}>
              <span className="lab">{b.label}<span className="gstchip">{inv.intra ? (inv.slabs[0].rate / 2) : inv.slabs[0].rate}%</span></span>
              <span className="val">{INR(b.amount)}</span>
            </div>
          ))}
          <div className="grand">
            <span className="lab">Grand total</span>
            <span className="val">{INR(inv.grand)}</span>
          </div>
          <div className="split-note">
            <span className="bolt"><Ic d={ICONS.bolt} size={14} fill="currentColor" sw={0} /></span>
            {inv.intra
              ? <span>Intra-state supply — tax split <b>CGST + SGST</b> (both parties in {customer.state}).</span>
              : <span>Inter-state supply — single <b>IGST</b> ({window.SwipeEngine.SELLER.state} → {customer.state}).</span>}
          </div>
        </div>

        {!isDraft && (
          <div className="linkbtn"><Ic d={ICONS.pdf} size={16} /> Open PDF</div>
        )}
      </div>
    </div>
  );
}

/* ---- Payment recorded -------------------------------------------------- */
function PaymentCard({ amount, method, doc, preview }) {
  const t = docTotals(doc);                       // current (pre-commit if preview)
  const projDue = +(t.grand - t.paid - (preview ? amount : 0)).toFixed(2);
  const projPaid = +(t.paid + (preview ? amount : 0)).toFixed(2);
  const status = preview
    ? (projDue <= 0 ? "paid" : projPaid > 0 ? "partial" : "pending")
    : docStatus(doc);
  const mlow = (method || "").toLowerCase();
  const methodIcon = mlow.includes("cash") ? ICONS.rupee : (mlow.includes("bank") || mlow.includes("neft") || mlow.includes("rtgs") || mlow.includes("transfer")) ? ICONS.bank : ICONS.bolt;
  return (
    <div className="card">
      <div className="card-top">
        <span className="tag">PAYMENT</span>
        <div style={{ flex: 1 }}>
          <h3>{INR(amount)} {preview ? "to record" : "received"}</h3>
          <div className="sub">via {method} · against {doc.serial} ({t.customer.name})</div>
        </div>
        <StatusBadge status={status} />
      </div>
      <div className="card-body">
        <div className="party-grid" style={{ marginBottom: 0 }}>
          <div className="field"><div className="k">Method</div><div className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}><Ic d={methodIcon} size={16} fill={methodIcon === ICONS.bolt ? "currentColor" : "none"} sw={methodIcon === ICONS.bolt ? 0 : 2.4} /> {method}</div></div>
          <div className="field" style={{ textAlign: "right" }}><div className="k">Date</div><div className="v">{fmtDate(window.SwipeEngine.TODAY)}</div></div>
        </div>
        <div className="totals" style={{ marginTop: 16 }}>
          <div className="totline"><span className="lab">Invoice total</span><span className="val">{INR(t.grand)}</span></div>
          <div className="totline"><span className="lab">{preview ? "Paid so far" : "Paid to date"}</span><span className="val">{INR(t.paid)}</span></div>
          {preview && <div className="totline"><span className="lab">This payment</span><span className="val" style={{ color: "#1faa5b" }}>+ {INR(amount)}</span></div>}
          <div className="grand" style={{ background: projDue <= 0 ? "var(--green)" : "var(--accent)", color: projDue <= 0 ? "var(--ink)" : "var(--accent-ink)" }}>
            <span className="lab">{projDue <= 0 ? "Fully settled" : (preview ? "New balance" : "Balance due")}</span>
            <span className="val">{INR(Math.max(0, projDue))}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Document list ----------------------------------------------------- */
function DocListCard({ title, sub, docs }) {
  const total = docs.reduce((s, d) => s + docTotals(d).due, 0);
  return (
    <div className="card">
      <div className="card-top">
        <span className="tag">{docs.length} DOCS</span>
        <div style={{ flex: 1 }}><h3>{title}</h3><div className="sub">{sub}</div></div>
      </div>
      <div className="doclist">
        {docs.map((d) => {
          const t = docTotals(d);
          return (
            <div className="docrow" key={d.serial}>
              <span className="serial">{d.serial}</span>
              <span className="who">{t.customer.name}<small>{fmtDate(d.date)} · due {fmtDate(d.dueDate)}</small></span>
              <span className="amt">{INR(t.grand)}<small>{t.due > 0 ? INR(t.due) + " due" : "settled"}</small></span>
              <StatusBadge status={docStatus(d)} />
            </div>
          );
        })}
      </div>
      <div className="list-foot"><span>Total outstanding</span><span>{INR(total)}</span></div>
    </div>
  );
}

/* ---- Ledger / outstanding --------------------------------------------- */
function LedgerCard({ customer, entries, outstanding }) {
  return (
    <div className="card">
      <div className="card-top">
        <span className="tag">LEDGER</span>
        <div style={{ flex: 1 }}><h3>{customer.name}</h3><div className="sub">{customer.state} · GSTIN {customer.gstin}</div></div>
      </div>
      <div className="outstanding-big">
        <span className="lab">Outstanding balance</span>
        <span className="num">{INR(outstanding)}</span>
      </div>
      <div className="ledger">
        <div className="ledger-row" style={{ fontWeight: 700, color: "var(--ink-soft)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
          <span className="dt">Date</span><span>Particulars</span><span style={{ textAlign: "right" }}>Debit</span><span className="bal" style={{ textAlign: "right" }}>Balance</span>
        </div>
        {entries.map((e, i) => (
          <div className="ledger-row" key={i}>
            <span className="dt">{fmtDate(e.date)}</span>
            <span>{e.label}</span>
            {e.debit ? <span className="deb">{INR(e.debit)}</span> : <span className="cre">-{INR(e.credit)}</span>}
            <span className="bal">{INR(e.balance)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---- GSTIN lookup ------------------------------------------------------ */
function GstinCard({ data }) {
  return (
    <div className="card">
      <div className="card-top">
        <span className="tag">GSTIN</span>
        <div style={{ flex: 1 }}><h3>Registry lookup</h3><div className="sub">via MCP · lookup_gstin</div></div>
        <span className="status-badge status-paid">Active</span>
      </div>
      <div className="gstin-hero">
        <div className="glyph">{data.stateCode}</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18, fontFamily: "var(--font-display)" }}>{data.legal}</div>
          <div style={{ color: "var(--ink-soft)", fontSize: 13, fontWeight: 600 }}>Trade name: {data.trade}</div>
          <div className="hsn" style={{ fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 4 }}>{data.gstin}</div>
        </div>
      </div>
      <div className="card-body" style={{ paddingTop: 0 }}>
        <div className="party-grid" style={{ marginBottom: 0 }}>
          <div className="field"><div className="k">State</div><div className="v">{data.state}</div></div>
          <div className="field" style={{ textAlign: "right" }}><div className="k">Type</div><div className="v">{data.type}</div></div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Ic, ICONS, StatusBadge, InvoiceCard, PaymentCard, DocListCard, LedgerCard, GstinCard });
