import React, { useState, useEffect, useCallback } from "react";
import { Loader, KeyRound, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { adminFetch, setAdminToken } from "./authFetch.js";

// Admin -> Users: every dashboard login, who is logged in right now, password
// resets per user, and the admin's own password. Passwords are never shown.

const inputCls = "bg-[#161a1f] border border-gray-600 text-white text-[12px] px-2 py-1.5 rounded-sm focus:outline-none focus:border-blue-500";
const fmt = iso => (iso ? new Date(iso).toLocaleString() : "—");
const ago = iso => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

function ResetPassword({ username, minLen, onDone, onCancel }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async e => {
    e.preventDefault();
    if (pw.length < minLen) return setError(`At least ${minLen} characters`);
    if (pw !== pw2) return setError("The two passwords do not match");
    setBusy(true); setError("");
    try {
      const r = await adminFetch(`/api/admin/accounts/${encodeURIComponent(username)}/password`, { method: "PUT", body: { password: pw } });
      onDone(r.loggedOut
        ? `Password for ${username} changed — they were logged out and must use the new password.`
        : `Password for ${username} changed.`);
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2 bg-[#161a1f] border border-gray-700 rounded px-3 py-2 mt-1">
      <span className="text-[11px] text-gray-300">New password for <b className="text-white">{username}</b></span>
      <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} placeholder="New password" className={`${inputCls} w-[170px]`} autoFocus />
      <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Repeat" className={`${inputCls} w-[170px]`} />
      <button disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-[11px] font-semibold px-3 py-1.5 rounded-sm">
        {busy ? "Saving…" : "Save & log out user"}
      </button>
      <button type="button" onClick={onCancel} className="text-[11px] text-gray-400 hover:text-gray-200 px-2">Cancel</button>
      {error && <span className="text-[11px] text-red-400 w-full">{error}</span>}
    </form>
  );
}

function AdminPassword({ minLen }) {
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }

  const save = async e => {
    e.preventDefault();
    if (!cur) return setMsg({ ok: false, text: "Enter the current admin password" });
    if (pw.length < minLen) return setMsg({ ok: false, text: `New password: at least ${minLen} characters` });
    if (pw !== pw2) return setMsg({ ok: false, text: "The two new passwords do not match" });
    setBusy(true); setMsg(null);
    try {
      const r = await adminFetch("/api/admin/password", { method: "POST", body: { currentPassword: cur, newPassword: pw } });
      setAdminToken(r.token); // this console stays signed in; every other admin session is signed out
      setCur(""); setPw(""); setPw2("");
      setMsg({ ok: true, text: "Admin password changed. Other admin sessions were signed out. Use the new password from now on." });
    } catch (err) { setMsg({ ok: false, text: err.message }); }
    setBusy(false);
  };

  return (
    <div className="bg-[#1e2329] border border-gray-700 rounded">
      <div className="px-3 py-1.5 border-b border-gray-700 text-[11px] font-bold text-gray-200 flex items-center gap-1.5">
        <ShieldCheck size={12} /> Admin password
      </div>
      <form onSubmit={save} className="p-3 flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-gray-400">Current password<br />
          <input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} className={`${inputCls} w-[180px]`} />
        </label>
        <label className="text-[10px] text-gray-400">New password<br />
          <input type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} className={`${inputCls} w-[180px]`} />
        </label>
        <label className="text-[10px] text-gray-400">Repeat new password<br />
          <input type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} className={`${inputCls} w-[180px]`} />
        </label>
        <button disabled={busy} className="bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-[11px] font-semibold px-3 py-1.5 rounded-sm">
          {busy ? "Saving…" : "Change admin password"}
        </button>
        {msg && <div className={`w-full text-[11px] ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</div>}
        <div className="w-full text-[10px] text-gray-500">
          Saved on the server (hashed) and used instead of ADMIN_PASSWORD in backend/.env. Forgot it? Delete the "admin" entry in backend/data/passwords.json and restart — the .env password works again.
        </div>
      </form>
    </div>
  );
}

export default function AdminUsers() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);   // username with the reset form open
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try { setData(await adminFetch("/api/admin/accounts")); setError(""); }
    catch (err) { setError(err.message); }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const endSession = async username => {
    if (!window.confirm(`Log ${username} out now?`)) return;
    setBusy(username);
    try { await adminFetch(`/api/admin/sessions/${encodeURIComponent(username)}`, { method: "DELETE" }); setNotice(`${username} was logged out.`); await load(); }
    catch (err) { setError(err.message); }
    setBusy("");
  };

  if (!data && !error) return <div className="text-xs text-gray-400 flex items-center gap-2"><Loader size={14} className="animate-spin" /> Loading users…</div>;
  const users = data?.users || [];
  const minLen = data?.minPasswordLength || 8;
  const online = users.filter(u => u.session).length;

  return (
    <div className="space-y-3 max-w-[1100px]">
      {error && <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">{error}</div>}
      {notice && <div className="text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-sm px-2 py-1.5">{notice}</div>}

      <div className="bg-[#1e2329] border border-gray-700 rounded">
        <div className="px-3 py-1.5 border-b border-gray-700 flex items-center justify-between">
          <span className="text-[11px] font-bold text-gray-200">Dashboard users <span className="font-normal text-gray-500">— {online} of {users.length} logged in · one active login per user</span></span>
          <button onClick={load} className="text-gray-400 hover:text-white" title="Refresh"><RefreshCw size={12} /></button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px] min-w-[760px]">
            <thead>
              <tr className="text-gray-500 uppercase text-[9px]">
                {["User", "Status", "From (IP)", "Logged in since", "Last active", "Password", ""].map(h => <th key={h} className="px-3 py-1.5">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-3 text-gray-500">No dashboard users. Add APP_USER1_NAME / APP_USER1_PASSWORD (APP_USER2_*, …) to backend/.env and restart.</td></tr>
              )}
              {users.map(u => (
                <React.Fragment key={u.username}>
                  <tr className="border-t border-gray-800 align-middle">
                    <td className="px-3 py-1.5 text-white font-semibold">{u.username}</td>
                    <td className="px-3 py-1.5">
                      {u.session
                        ? <span className="inline-flex items-center gap-1.5 text-emerald-400 font-semibold"><span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-emerald-400" />Logged in</span>
                        : <span className="inline-flex items-center gap-1.5 text-gray-500"><span aria-hidden="true" className="w-1.5 h-1.5 rounded-full border border-gray-500" />Logged out</span>}
                    </td>
                    <td className="px-3 py-1.5 text-gray-300 font-mono">{u.session?.ip || "—"}</td>
                    <td className="px-3 py-1.5 text-gray-300">{fmt(u.session?.since)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{u.session ? ago(u.session.lastSeenAt) : "—"}</td>
                    <td className="px-3 py-1.5 text-gray-400">
                      {u.passwordSetBy === ".env" ? "from .env" : <>reset {fmt(u.passwordChangedAt)}</>}
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => { setNotice(""); setOpen(o => (o === u.username ? null : u.username)); }}
                        className="inline-flex items-center gap-1 text-[10px] text-sky-300 hover:text-sky-200 border border-sky-700/50 rounded-sm px-2 py-0.5 mr-1">
                        <KeyRound size={10} /> Reset password
                      </button>
                      <button disabled={!u.session || busy === u.username} onClick={() => endSession(u.username)}
                        className="inline-flex items-center gap-1 text-[10px] text-red-300 hover:text-red-200 border border-red-700/50 rounded-sm px-2 py-0.5 disabled:opacity-30">
                        <LogOut size={10} /> Log out
                      </button>
                    </td>
                  </tr>
                  {open === u.username && (
                    <tr><td colSpan={7} className="px-3 pb-2">
                      <ResetPassword username={u.username} minLen={minLen}
                        onCancel={() => setOpen(null)}
                        onDone={text => { setOpen(null); setNotice(text); load(); }} />
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-1.5 border-t border-gray-800 text-[10px] text-gray-500">
          A reset password is saved on the server (hashed) and replaces that user's password from backend/.env. Users themselves are added in backend/.env (APP_USER{"{n}"}_NAME / _PASSWORD).
        </div>
      </div>

      <AdminPassword minLen={minLen} />
    </div>
  );
}
