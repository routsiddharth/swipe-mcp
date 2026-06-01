/* ============================================================================
   Swipe Agent — conversation UI (presentational; state lives in App)
============================================================================ */
const { useState } = React;

/* ---- Logo mark (simple geometric swipe) -------------------------------- */
function SwipeMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M17 7.5C15.6 6 13.9 5.2 12 5.2 8.2 5.2 5.2 8.2 5.2 12s3 6.8 6.8 6.8c1.9 0 3.6-.8 5-2.3"
            stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="17.5" cy="13.5" r="2.3" fill="#fff" />
    </svg>
  );
}

/* ---- Trace (MCP tool calls) -------------------------------------------- */
function TraceBlock({ msg, onToggle }) {
  const total = msg.trace.length;
  const shown = msg.shownTrace;
  const done = msg.tracePhaseDone;
  const collapsed = msg.traceCollapsed;
  return (
    <div className={"trace " + (collapsed ? "collapsed" : "open")}>
      <div className="trace-head" onClick={onToggle}>
        <span className="mcp">MCP</span>
        <span>{done ? `${total} tool call${total > 1 ? "s" : ""}` : "Working…"}</span>
        {!done && <span className="spin" style={{ marginLeft: 4 }} />}
        <span className="chev"><Ic d={ICONS.arrow} size={15} /></span>
      </div>
      <div className="trace-body">
        {msg.trace.slice(0, shown).map((s, i) => {
          const isLast = i === shown - 1;
          const running = !done && isLast;
          return (
            <div className={"step " + (running ? "running" : "done")} key={i}>
              <span className="ic">{running ? <span className="spin" /> : <Ic d={ICONS.check} size={12} sw={3} />}</span>
              <span style={{ flex: 1 }}>
                <span className="tool">{s.tool}</span>{"  "}
                <span className="lbl" dangerouslySetInnerHTML={{ __html: s.label }} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---- Card switch ------------------------------------------------------- */
function CardRenderer({ card }) {
  if (!card) return null;
  switch (card.type) {
    case "invoice": return <InvoiceCard {...card.props} />;
    case "payment": return <PaymentCard {...card.props} />;
    case "list": return <DocListCard {...card.props} />;
    case "ledger": return <LedgerCard {...card.props} />;
    case "gstin": return <GstinCard {...card.props} />;
    default: return null;
  }
}

/* ---- Confirm bar ------------------------------------------------------- */
function ConfirmBar({ msg, onConfirm, onCancel }) {
  return (
    <div className="confirm-bar">
      <span className="q"><span className="lock"><Ic d={ICONS.lock} size={14} /></span>{msg.confirm.question}</span>
      <button className="btn" onClick={onCancel}>Cancel</button>
      <button className="btn primary" onClick={onConfirm}><Ic d={ICONS.check} size={15} sw={3} /> {msg.confirm.confirmLabel}</button>
    </div>
  );
}

/* ---- Agent message ----------------------------------------------------- */
function AgentMessage({ msg, onToggleTrace, onConfirm, onCancel }) {
  return (
    <div className="row">
      <div className="avatar"><SwipeMark2 /></div>
      <div className="agent-col">
        {msg.text != null && (
          <div className="agent-text" dangerouslySetInnerHTML={{ __html: msg.text }} />
        )}
        {msg.streaming && msg.text === "" && <span className="cursor" />}
        {msg.trace && msg.trace.length > 0 && msg.shownTrace > 0 && (
          <TraceBlock msg={msg} onToggle={onToggleTrace} />
        )}
        {msg.card && <CardRenderer card={msg.card} />}
        {msg.confirm && !msg.committed && !msg.cancelled && (
          <ConfirmBar msg={msg} onConfirm={onConfirm} onCancel={onCancel} />
        )}
        {msg.committed && msg.committedNote && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span className="stamp">{msg.stampText || "Done!"}</span>
            <span style={{ fontWeight: 600, color: "var(--ink-soft)", fontSize: 14 }}
                  dangerouslySetInnerHTML={{ __html: msg.committedNote }} />
          </div>
        )}
        {msg.cancelled && (
          <div style={{ fontWeight: 600, color: "var(--ink-soft)", fontSize: 14 }}>Cancelled — nothing was written. ✋</div>
        )}
        {msg.error && (
          <div style={{ fontWeight: 600, color: "#d23f57", fontSize: 14 }}>⚠ {msg.error}</div>
        )}
      </div>
    </div>
  );
}

/* avatar mark (yellow tile w/ dark swipe) */
function SwipeMark2() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M17 7.5C15.6 6 13.9 5.2 12 5.2 8.2 5.2 5.2 8.2 5.2 12s3 6.8 6.8 6.8c1.9 0 3.6-.8 5-2.3"
            stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="17.5" cy="13.5" r="2.3" fill="var(--ink)" />
    </svg>
  );
}

function UserMessage({ text }) {
  return <div className="row user"><div className="bubble-user">{text}</div></div>;
}

/* ---- Empty state ------------------------------------------------------- */
const EXAMPLES = [
  { emoji: "🧾", q: "invoice Acme ₹50,000 for consulting, 18% GST, due in 15 days", hint: "create_document", bg: "var(--sky)" },
  { emoji: "💸", q: "record a ₹20,000 UPI payment against it", hint: "record_payment", bg: "var(--green)" },
  { emoji: "🔎", q: "show me all unpaid invoices this quarter", hint: "search_documents", bg: "var(--peach)" },
  { emoji: "📒", q: "what's Globex's outstanding balance?", hint: "get_ledger", bg: "var(--pink)" },
];
function EmptyState({ onPick }) {
  return (
    <div className="empty">
      <span className="kicker">talk to your books ↓</span>
      <h1>Just say what you need.<br /><span className="hl">Swipe does the rest.</span></h1>
      <p className="lede">Type plain English. An AI agent drives Swipe through MCP tools — resolving customers, doing the GST math, and only writing once you confirm.</p>
      <div className="examples">
        {EXAMPLES.map((e, i) => (
          <button className="example" key={i} onClick={() => onPick(e.q)}>
            <span className="badge" style={{ background: e.bg }}>{e.emoji}</span>
            <span><span className="qt">“{e.q}”</span><span className="hint">→ {e.hint}</span></span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---- Composer ---------------------------------------------------------- */
const QUICK = [
  "invoice Acme ₹50,000 for consulting, 18% GST, due in 15 days",
  "record a ₹20,000 UPI payment against it",
  "show me all unpaid invoices this quarter",
  "what's Globex's outstanding balance?",
];
function Composer({ value, setValue, onSend, busy, showQuick, onPick }) {
  const ref = React.useRef(null);
  return (
    <div className="composer-wrap">
      <div className="composer">
        {showQuick && (
          <div className="suggest-row">
            {QUICK.map((q, i) => (
              <button className="chip" key={i} onClick={() => onPick(q)} title={q}>
                <span className="emoji">{["🧾", "💸", "🔎", "📒"][i]}</span>
                {q.length > 38 ? q.slice(0, 36) + "…" : q}
              </button>
            ))}
          </div>
        )}
        <form className="input-bar" onSubmit={(e) => { e.preventDefault(); onSend(); }}>
          <div className="input-box">
            <input
              ref={ref}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={busy ? "Agent is working…" : "e.g. invoice Globex ₹1.2L for steel, 18% GST, due in 30 days"}
              disabled={busy}
              id="swipe-input"
            />
          </div>
          <button className="send" type="submit" disabled={busy || !value.trim()} aria-label="Send">
            <Ic d={ICONS.arrow} size={20} sw={2.8} />
          </button>
        </form>
      </div>
    </div>
  );
}

Object.assign(window, { SwipeMark, TraceBlock, CardRenderer, ConfirmBar, AgentMessage, UserMessage, EmptyState, Composer, QUICK, EXAMPLES });
