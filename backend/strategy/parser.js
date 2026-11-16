// strategy/parser.js — turns an uploaded "bt-strategy-config" file (exported
// from the backtester) into the spec the live runner executes.
//
// Anything the live runner cannot do faithfully is REJECTED with a clear
// message instead of being ignored — a strategy must never trade live
// differently from how it was backtested without someone noticing.
// Backtest-only settings (costs, slippage, fill model) are reported as
// warnings because they describe the simulation, not the orders.

const ist = require("./ist");

// data_source prefix → underlying + F&O segment in the instrument master
const UNDERLYINGS = {
  nifty:      { underlying: "NIFTY",      segment: "NSE_FO" },
  banknifty:  { underlying: "BANKNIFTY",  segment: "NSE_FO" },
  finnifty:   { underlying: "FINNIFTY",   segment: "NSE_FO" },
  midcpnifty: { underlying: "MIDCPNIFTY", segment: "NSE_FO" },
  sensex:     { underlying: "SENSEX",     segment: "BSE_FO" },
  bankex:     { underlying: "BANKEX",     segment: "BSE_FO" },
};

const STRIKE_RULES   = ["delta", "atm_offset", "premium"];
const MATCH_MODES    = ["nearest_ge", "nearest_le", "nearest"];
const EXPIRY_CHOICES = ["current_week", "next_week", "monthly"];

const isNil = v => v === null || v === undefined;

function resolveSource(dataSource, fallbackUnderlying, errors, where) {
  if (dataSource) {
    const key = String(dataSource).toLowerCase().split("_")[0];
    if (UNDERLYINGS[key]) return UNDERLYINGS[key];
    errors.push(`${where}: unknown data_source "${dataSource}"`);
    return null;
  }
  if (fallbackUnderlying) {
    const key = String(fallbackUnderlying).toLowerCase();
    if (UNDERLYINGS[key]) return UNDERLYINGS[key];
    errors.push(`${where}: unsupported underlying "${fallbackUnderlying}"`);
    return null;
  }
  errors.push(`${where}: no data_source or underlying`);
  return null;
}

function parseSchedule(list, errors, where) {
  if (!Array.isArray(list) || !list.length) {
    errors.push(`${where}: schedule is empty`);
    return [];
  }
  const slots = new Set();
  list.forEach((w, i) => {
    const start = ist.toMinutes(w.start);
    const end   = ist.toMinutes(w.end);
    const every = Number(w.every_min);
    if (start == null || end == null || !(every > 0) || end < start) {
      errors.push(`${where}: schedule[${i}] needs start ≤ end (HH:MM) and every_min > 0`);
      return;
    }
    if (start < ist.MARKET_OPEN || end > ist.MARKET_CLOSE) {
      errors.push(`${where}: schedule[${i}] ${w.start}–${w.end} is outside market hours (09:15–15:30 IST)`);
      return;
    }
    for (let t = start; t <= end; t += every) slots.add(ist.fromMinutes(t));
  });
  return [...slots].sort();
}

function parseStrike(st, errors, where) {
  if (!st || typeof st !== "object") { errors.push(`${where}: strike is missing`); return null; }
  const rule = st.rule;
  if (!STRIKE_RULES.includes(rule)) { errors.push(`${where}: strike rule "${rule}" is not supported (use ${STRIKE_RULES.join(", ")})`); return null; }
  const match = st.match || "nearest_ge";
  if (!MATCH_MODES.includes(match)) errors.push(`${where}: match "${match}" is not supported`);
  if (!isNil(st.pct)) errors.push(`${where}: strike pct is not supported live`);

  const out = {
    rule, match,
    minPremium: Number(st.min_premium || 0),
    tolerance: isNil(st.tolerance) ? null : Number(st.tolerance),
  };
  if (rule === "delta") {
    const d = Number(st.delta);
    if (!(d > 0 && d < 100)) errors.push(`${where}: delta must be between 0 and 100`);
    out.delta = d;
  }
  if (rule === "atm_offset") out.n = Number(st.n || 0);
  if (rule === "premium") {
    const p = Number(st.premium);
    if (!(p > 0)) errors.push(`${where}: premium rule needs a premium above 0`);
    out.premium = p;
  }
  return out;
}

function parseLegs(legs, errors, where) {
  if (!legs || typeof legs !== "object") { errors.push(`${where}: legs missing`); return []; }
  if (legs.preset && legs.preset !== "custom") errors.push(`${where}: preset "${legs.preset}" is not supported — export the strategy with a custom leg list`);
  for (const k of ["ratio", "ce_strike", "pe_strike", "mid_strike", "strike"]) {
    if (!isNil(legs[k])) errors.push(`${where}: legs.${k} is not supported live`);
  }
  if (!Array.isArray(legs.list) || !legs.list.length) { errors.push(`${where}: leg list is empty`); return []; }

  return legs.list.map((l, i) => {
    const w = `${where} leg ${i + 1}`;
    const action = String(l.action || "").toUpperCase();
    const type   = String(l.type || "").toUpperCase();
    const lots   = Number(l.lots);
    if (!["BUY", "SELL"].includes(action)) errors.push(`${w}: action must be BUY or SELL`);
    if (!["CE", "PE"].includes(type))      errors.push(`${w}: type must be CE or PE`);
    if (!Number.isInteger(lots) || lots <= 0) errors.push(`${w}: lots must be a whole number above 0`);
    return { action, type, lots, strike: parseStrike(l.strike, errors, w) };
  });
}

function requireNone(value, name, errors) {
  if (!isNil(value)) errors.push(`${name} is not supported live (set it to null to upload)`);
}

function parseStrategyFile(raw) {
  const errors = [];
  const warnings = [];

  if (!raw || typeof raw !== "object" || raw.format !== "bt-strategy-config") {
    return { ok: false, errors: ['Not a strategy file (expected "format": "bt-strategy-config")'], warnings };
  }
  if (raw.version !== 1) errors.push(`Unsupported strategy file version ${raw.version} (expected 1)`);
  const s = raw.strategy;
  if (!s || typeof s !== "object") return { ok: false, errors: ["File has no strategy section"], warnings };

  // ── features the live runner does not implement ──
  requireNone(s.orb, "orb", errors);
  requireNone(s.gift_cr, "gift_cr", errors);
  requireNone(s.gift_flow, "gift_flow", errors);
  if (s.target && s.target.mode && s.target.mode !== "none") errors.push(`target mode "${s.target.mode}" is not supported live`);
  if (s.delta_exit && s.delta_exit.mode && s.delta_exit.mode !== "none") errors.push(`delta_exit mode "${s.delta_exit.mode}" is not supported live`);
  if (s.entry_filter) {
    requireNone(s.entry_filter.atm_iv_min, "entry_filter.atm_iv_min", errors);
    requireNone(s.entry_filter.atm_iv_max, "entry_filter.atm_iv_max", errors);
  }

  // ── symbols ──
  const symbols = [];
  const main = resolveSource(s.data_source, s.underlying, errors, "strategy");
  const lotsPerEntry = Number(s.lots_per_entry || 1);
  if (!Number.isInteger(lotsPerEntry) || lotsPerEntry <= 0) errors.push("lots_per_entry must be a whole number above 0");
  if (main) {
    symbols.push({ ...main, lotsPerEntry, marginPerQty: s.margin_per_qty ?? null, capital: s.capital ?? null });
  }
  (Array.isArray(s.extra_symbols) ? s.extra_symbols : []).forEach((x, i) => {
    const src = resolveSource(x.data_source, x.underlying, errors, `extra_symbols[${i}]`);
    if (!src) return;
    if (symbols.some(y => y.underlying === src.underlying)) { errors.push(`extra_symbols[${i}]: ${src.underlying} is listed twice`); return; }
    const lpe = isNil(x.lots_per_entry) ? lotsPerEntry : Number(x.lots_per_entry);
    if (!Number.isInteger(lpe) || lpe <= 0) errors.push(`extra_symbols[${i}]: lots_per_entry must be a whole number above 0`);
    symbols.push({ ...src, lotsPerEntry: lpe, marginPerQty: x.margin_per_qty ?? null, capital: x.capital ?? null });
  });

  // ── leg groups: main legs + structures, each with its own schedule ──
  const groups = [{ id: "main", legs: parseLegs(s.legs, errors, "legs"), slots: parseSchedule(s.schedule, errors, "schedule") }];
  (Array.isArray(s.structures) ? s.structures : []).forEach((st, i) => {
    groups.push({
      id: `structure${i + 1}`,
      legs: parseLegs(st.legs, errors, `structures[${i}]`),
      slots: parseSchedule(st.schedule, errors, `structures[${i}].schedule`),
    });
  });

  // ── when to trade ──
  const dte = s.entry_days?.dte;
  const entryDte = Array.isArray(dte) ? dte.map(Number) : [];
  if (!entryDte.length || entryDte.some(d => !Number.isInteger(d) || d < 0 || d > 30)) {
    errors.push("entry_days.dte must list whole numbers of days to expiry (e.g. [0] for expiry day)");
  }
  for (const k of Object.keys(s.entry_days || {})) {
    if (k !== "dte" && !isNil(s.entry_days[k])) errors.push(`entry_days.${k} is not supported live`);
  }

  const expiryWhich = s.expiry?.which || "current_week";
  if (!EXPIRY_CHOICES.includes(expiryWhich)) errors.push(`expiry "${expiryWhich}" is not supported (use ${EXPIRY_CHOICES.join(", ")})`);

  // ── exits ──
  const stopMode = s.stop?.mode || "none";
  let stop = { mode: "none" };
  if (stopMode === "per_leg") {
    const m = Number(s.stop.multiplier);
    if (!(m > 1)) errors.push("stop.multiplier must be above 1 (e.g. 2 = exit a short leg when its premium doubles)");
    if (!isNil(s.stop.amount)) errors.push("stop.amount is not supported live");
    stop = { mode: "per_leg", multiplier: m };
  } else if (stopMode !== "none") {
    errors.push(`stop mode "${stopMode}" is not supported live`);
  }

  const dailyLossPct = isNil(s.daily_limit?.max_loss_pct) ? null : Number(s.daily_limit.max_loss_pct);
  if (dailyLossPct !== null && !(dailyLossPct > 0)) errors.push("daily_limit.max_loss_pct must be above 0");

  const exitCfg = s.exit || {};
  const hold = exitCfg.hold || "to_expiry";
  if (!["to_expiry", "intraday"].includes(hold)) errors.push(`exit.hold "${hold}" is not supported live`);
  requireNone(exitCfg.at, "exit.at", errors);
  requireNone(exitCfg.hold_days, "exit.hold_days", errors);
  let intradayAt = null;
  if (!isNil(exitCfg.intraday_at)) {
    if (ist.toMinutes(exitCfg.intraday_at) == null) errors.push("exit.intraday_at must be HH:MM");
    else intradayAt = exitCfg.intraday_at;
  }
  if (hold === "intraday" && !intradayAt) errors.push('exit.hold "intraday" needs exit.intraday_at');

  // ── backtest-only settings ──
  if (s.costs) warnings.push("costs / slippage / fill model are backtest settings and are not used live");
  if (!isNil(s.fill_buffer_min)) warnings.push("fill_buffer_min is a backtest setting and is not used live");

  const spec = {
    name: String(s.name || "Unnamed strategy").slice(0, 80),
    tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
    symbols,
    groups,
    entryDte,
    expiryWhich,
    stop,
    dailyLossPct,
    exit: { hold, intradayAt },
    riskFreePct: isNil(s.risk_free_pct) ? 6 : Number(s.risk_free_pct),
  };

  return { ok: errors.length === 0, spec: errors.length ? null : spec, errors, warnings };
}

module.exports = { parseStrategyFile, UNDERLYINGS };
