// margin.js — utilized / available margin from the XTS balance response
// (GET /interactive/user/balance — read-only).
//
// Layout per the XTS Interactive API docs:
//   result.BalanceList[] → { limitHeader: "ALL|ALL|ALL",
//     limitObject: { RMSSubLimits: { cashAvailable, collateral, marginUtilized,
//                                    netMarginAvailable, MTM, … }, … } }
// Values arrive as strings. If the broker answers in a different shape the
// response is reported as unrecognized (the raw response is kept for the admin),
// never guessed.

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = x => Math.round(x * 100) / 100;

function parseBalance(result) {
  const list = Array.isArray(result?.BalanceList) ? result.BalanceList : [];
  const entry = list.find(b => String(b?.limitHeader || "").toUpperCase() === "ALL|ALL|ALL") || list[0];
  const rms = entry?.limitObject?.RMSSubLimits;
  if (!rms || (rms.netMarginAvailable === undefined && rms.marginUtilized === undefined)) {
    throw new Error("Unrecognized balance response from the broker");
  }
  const available = round2(num(rms.netMarginAvailable));
  const utilized = round2(num(rms.marginUtilized));
  const total = round2(available + utilized);
  return {
    available,
    utilized,
    total,
    usedPct: total > 0 ? round2((utilized / total) * 100) : 0,
    cash: round2(num(rms.cashAvailable)),
    collateral: round2(num(rms.collateral)),
    mtm: round2(num(rms.MTM)),
    accountId: entry?.limitObject?.AccountID || "",
  };
}

module.exports = { parseBalance };
