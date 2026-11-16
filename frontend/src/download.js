// download.js — fetch a file from the backend (with auth headers) and save it.

export async function downloadFile(url, filename, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    let msg = "";
    try { msg = (await r.json()).error; } catch { /* not JSON */ }
    throw new Error(msg || `HTTP ${r.status}`);
  }
  const blob = await r.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

// Rows → CSV text. `columns`: [[key, label], …] or [key, …]; when omitted,
// every key seen in any row (first-seen order). Every cell is quoted.
export function rowsToCsv(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  let cols = columns;
  if (!cols) {
    const seen = [];
    list.forEach(r => Object.keys(r || {}).forEach(k => { if (!seen.includes(k)) seen.push(k); }));
    cols = seen;
  }
  cols = cols.map(c => (Array.isArray(c) ? c : [c, c]));
  const cell = v => {
    if (v === null || v === undefined) return '""';
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [cols.map(([, label]) => cell(label)).join(",")];
  for (const r of list) lines.push(cols.map(([key]) => cell(r?.[key])).join(","));
  return lines.join("\n");
}

// Save text as a file in the browser.
export function saveText(text, filename, type = "text/csv;charset=utf-8") {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

// Today's date in IST as YYYY-MM-DD (the backend journals by IST day).
export function todayIst() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
