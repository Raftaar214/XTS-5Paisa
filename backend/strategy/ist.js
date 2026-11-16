// strategy/ist.js — Indian Standard Time helpers.
//
// The server may run anywhere (AWS / Oracle default to UTC), so every
// schedule decision goes through these helpers instead of the machine's
// local time zone. IST is UTC+05:30 with no daylight saving.

const IST_OFFSET_MS = 330 * 60 * 1000;

const pad = n => String(n).padStart(2, "0");

// { date: "YYYY-MM-DD", hhmm: "HH:MM", minutes, seconds, weekday (0=Sun) }
function parts(ms = Date.now()) {
  const d = new Date(ms + IST_OFFSET_MS);
  const hh = d.getUTCHours(), mm = d.getUTCMinutes();
  return {
    date: d.toISOString().slice(0, 10),
    hhmm: `${pad(hh)}:${pad(mm)}`,
    minutes: hh * 60 + mm,
    seconds: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

// IST calendar date of an expiry given as epoch ms, ISO string or YYYY-MM-DD.
function dateOf(expiry) {
  if (expiry == null || expiry === "") return null;
  if (typeof expiry === "number") return parts(expiry).date;
  const s = String(expiry);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d+$/.test(s)) return parts(Number(s)).date;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? parts(ms).date : null;
}

// "HH:MM" -> minutes after midnight
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function fromMinutes(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }

// Epoch ms of HH:MM IST on an IST date.
function timeOn(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + toMinutes(hhmm) * 60000 - IST_OFFSET_MS;
}

function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function isWeekend(date) {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 || wd === 6;
}

// Exchange holidays: a list of "YYYY-MM-DD" set by the admin
// (Admin -> Execution & Limits). Expiry dates themselves come from the
// instrument master, which already reflects holiday shifts.
const holidaySet = holidays => (holidays instanceof Set ? holidays : new Set(holidays || []));

function isTradingDay(date, holidays) {
  return !isWeekend(date) && !holidaySet(holidays).has(date);
}

// Trading days from `from` to `to` (weekends and holidays skipped).
// 0 = same day, 1 = the next trading day, … Negative when `to` is past.
function tradingDaysBetween(from, to, holidays) {
  if (to === from) return 0;
  if (to < from) return -1;
  const h = holidaySet(holidays);
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    if (!isWeekend(d) && !h.has(d)) n++;
  }
  return n;
}

const MARKET_OPEN  = 9 * 60 + 15;
const MARKET_CLOSE = 15 * 60 + 30;

module.exports = {
  IST_OFFSET_MS, parts, dateOf, toMinutes, fromMinutes, timeOn, addDays,
  isWeekend, isTradingDay, tradingDaysBetween, MARKET_OPEN, MARKET_CLOSE,
};
