import React, { useState } from "react";
import { LogIn, Loader, ShieldCheck } from "lucide-react";
import { API_BASE, setToken } from "./authFetch.js";

// The "login user window" — asks for User ID + Password, verifies against
// the backend, then hands control back to AuthGate to render the real
// dashboard (App.jsx, untouched).
export default function LoginPage({ onLoggedIn }) {
  const [userId, setUserId]     = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!userId || !password) { setError("Enter both User ID and Password"); return; }
    setLoading(true); setError("");
    try {
      const r = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: userId, password }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) {
        setError(d.error || "Login failed");
        setLoading(false);
        return;
      }
      setToken(d.token);
      onLoggedIn(d.username);
    } catch (err) {
      setError("Cannot reach the backend — is server.js running on port 5000?");
      setLoading(false);
    }
  };

  return (
    <div className="h-screen w-full flex items-center justify-center" style={{ background: "#161a1f" }}>
      <form onSubmit={submit} className="w-[340px] bg-[#1e2329] border border-gray-700 rounded-lg shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-1 text-emerald-400">
          <ShieldCheck size={20} />
          <span className="text-white font-bold text-lg">XTS Trading Desk</span>
        </div>
        <div className="text-gray-500 text-[11px] mb-5">Sign in to open the dashboard</div>

        <label className="block text-[11px] text-gray-400 mb-1">User ID</label>
        <input
          autoFocus
          value={userId}
          onChange={e => setUserId(e.target.value)}
          className="w-full mb-3 bg-[#161a1f] border border-gray-600 text-white text-[13px] px-3 py-2 rounded-sm focus:outline-none focus:border-blue-500"
          placeholder="Enter User ID"
        />

        <label className="block text-[11px] text-gray-400 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full mb-4 bg-[#161a1f] border border-gray-600 text-white text-[13px] px-3 py-2 rounded-sm focus:outline-none focus:border-blue-500"
          placeholder="Enter Password"
        />

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
