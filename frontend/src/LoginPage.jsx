import React, { useState } from "react";
import { LogIn, Loader, ShieldCheck, AlertTriangle } from "lucide-react";
import { API_BASE, setToken } from "./authFetch.js";

// Login window. One active login per user: if the user ID is already logged
// in on another system, the server says so; the user can log that session
// out, and then logs in again fresh.
export default function LoginPage({ onLoggedIn, notice = "" }) {
  const [userId, setUserId]     = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [info, setInfo]         = useState(notice);
  const [conflict, setConflict] = useState(null); // { since, ip, lastSeenAt }
  const [loading, setLoading]   = useState(false);

  const post = async body => {
    const r = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => ({})) };
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!userId || !password) { setError("Enter both User ID and Password"); return; }
    setLoading(true); setError(""); setInfo(""); setConflict(null);
    try {
      const r = await post({ username: userId, password });
      if (r.status === 409 && r.data.code === "ALREADY_LOGGED_IN") {
        setConflict(r.data.activeSession || {});
      } else if (!r.ok || !r.data.success || !r.data.token) {
        setError(r.data.error || "Login failed");
      } else {
        setToken(r.data.token);
        onLoggedIn(r.data.username);
        return;
      }
    } catch {
      setError("Cannot reach the backend — is the server running?");
    }
    setLoading(false);
  };

  const logoutOther = async () => {
    setLoading(true); setError("");
    try {
      const r = await post({ username: userId, password, force: true });
      if (!r.ok) { setError(r.data.error || "Could not log the other session out"); }
      else {
        setConflict(null);
        setPassword("");
        setInfo("The other session was logged out. Log in again to continue.");
      }
    } catch {
      setError("Cannot reach the backend — is the server running?");
    }
    setLoading(false);
  };

  const when = iso => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <div className="h-screen w-full flex items-center justify-center" style={{ background: "#161a1f" }}>
      <form onSubmit={submit} className="w-[360px] bg-[#1e2329] border border-gray-700 rounded-lg shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-1 text-emerald-400">
          <ShieldCheck size={20} />
          <span className="text-white font-bold text-lg">XTS Trading Desk</span>
        </div>
        <div className="text-gray-500 text-[11px] mb-5">Sign in to open the dashboard</div>

        <label className="block text-[11px] text-gray-400 mb-1">User ID</label>
        <input
          autoFocus
          value={userId}
          onChange={e => { setUserId(e.target.value); setConflict(null); }}
          className="w-full mb-3 bg-[#161a1f] border border-gray-600 text-white text-[13px] px-3 py-2 rounded-sm focus:outline-none focus:border-blue-500"
          placeholder="Enter User ID"
          autoComplete="username"
        />

        <label className="block text-[11px] text-gray-400 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full mb-4 bg-[#161a1f] border border-gray-600 text-white text-[13px] px-3 py-2 rounded-sm focus:outline-none focus:border-blue-500"
          placeholder="Enter Password"
          autoComplete="current-password"
        />

        {info && (
          <div className="mb-3 text-[11px] text-sky-300 bg-sky-500/10 border border-sky-500/30 rounded-sm px-2 py-1.5">{info}</div>
        )}

        {conflict && (
          <div className="mb-3 text-[11px] text-amber-200 bg-amber-500/10 border border-amber-500/40 rounded-sm px-2 py-2">
            <div className="flex items-center gap-1.5 font-semibold text-amber-300 mb-1">
              <AlertTriangle size={13} /> {userId} is already logged in on another system
            </div>
            <div className="text-amber-200/80">Since {when(conflict.since)}{conflict.ip ? ` · from ${conflict.ip}` : ""}{conflict.lastSeenAt ? ` · last active ${when(conflict.lastSeenAt)}` : ""}</div>
            <div className="text-amber-200/80 mt-1">Only one login per user is allowed. Logging that session out closes the dashboard there.</div>
            <button type="button" onClick={logoutOther} disabled={loading}
              className="mt-2 w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold text-[12px] py-1.5 rounded-sm">
              Log out the other session
            </button>
          </div>
        )}

        {error && (
          <div className="mb-3 text-[11px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1.5">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-sm transition-colors"
        >
          {loading ? <Loader size={14} className="animate-spin" /> : <LogIn size={14} />}
          {loading ? "Verifying…" : "Login"}
        </button>
      </form>
    </div>
  );
}
