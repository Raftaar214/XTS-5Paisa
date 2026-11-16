// monitor.js
//
// In-memory production monitoring for the Admin console: recent executions
// and an audit trail of admin actions. Both are bounded ring buffers and
// reset on restart (the dashboard's CSV export remains the durable record).

const MAX_EXECUTIONS = 300;
const MAX_AUDIT      = 300;

const startedAt  = Date.now();
const executions = [];
const audit      = [];

function push(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

// One record per leg × client result returned by the engine.
function recordExecution(username, results) {
  const at = new Date().toISOString();
  (results || []).forEach(r => push(executions, {
    at,
    by: username,
    client: r.client,
    clientName: r.clientName,
    label: r.label,
    side: r.side,
    requestedQty: r.requestedQty,
    filledQty: r.filledQty,
    avgPrice: r.avgPrice,
    status: r.status,
    orderId: r.orderId,
    error: r.error || "",
    executionTime: r.executionTime,
  }, MAX_EXECUTIONS));
}

function recordAudit(actor, action, detail = "") {
  const entry = { at: new Date().toISOString(), actor, action, detail: String(detail).slice(0, 300) };
  push(audit, entry, MAX_AUDIT);
  console.log(`[ADMIN] ${actor}: ${action}${detail ? ` — ${entry.detail}` : ""}`);
}

// Latency statistics (from trade-book rows: queueMs, ackMs, fillMs, totalMs)
const LATENCY_METRICS = ["queueMs", "ackMs", "fillMs", "totalMs"];

// Nearest-rank percentiles over the numeric values of one metric.
function latencyStats(rows, key) {
  const v = rows
    .map(r => r?.[key])
    .filter(x => x !== null && x !== undefined && x !== "" && Number.isFinite(Number(x)))
    .map(Number)
    .sort((a, b) => a - b);
  if (!v.length) return { count: 0, avg: null, p50: null, p95: null, max: null };
  const rank = p => v[Math.max(0, Math.ceil(p * v.length) - 1)];
  return {
    count: v.length,
    avg: Math.round(v.reduce((s, x) => s + x, 0) / v.length),
    p50: rank(0.5),
    p95: rank(0.95),
    max: v[v.length - 1],
  };
}

function metricsOf(rows) {
  return Object.fromEntries(LATENCY_METRICS.map(k => [k, latencyStats(rows, k)]));
}

function groupBy(rows, key) {
  const m = new Map();
  rows.forEach(r => { const k = r[key] || "—"; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function latencySummary(rows) {
  const timed = (rows || []).filter(r => r && r.totalMs !== undefined && r.totalMs !== null && r.totalMs !== "");
  return {
    overall: metricsOf(timed),
    byClient: groupBy(timed, "client").map(([client, list]) => ({ client, ...metricsOf(list) })),
    byMode: groupBy(timed, "mode").map(([mode, list]) => ({ mode, ...metricsOf(list) })),
  };
}

function getExecutions() { return executions.slice().reverse(); }
function getAudit()      { return audit.slice().reverse(); }
function getUptimeMs()   { return Date.now() - startedAt; }

module.exports = { recordExecution, recordAudit, getExecutions, getAudit, getUptimeMs, latencyStats, latencySummary };
