import React, { useEffect, useState, useCallback } from "react";
import App from "./App.jsx";
import LoginPage from "./LoginPage.jsx";
import { installAuthFetch, getToken, clearToken, API_BASE } from "./authFetch.js";

// Wraps the real dashboard (App.jsx) behind a simple User ID / Password
// gate. Kept OUTSIDE App.jsx on purpose — the dashboard's own code never
// has to change to support login/logout.
export default function AuthGate() {
  const [status, setStatus]     = useState("checking"); // checking | out | in
  const [username, setUsername] = useState("");

  // Install the fetch patch once, before anything else renders, so every
  // request App.jsx makes (unmodified) is authenticated transparently.
  useEffect(() => {
    installAuthFetch(() => setStatus("out"));
  }, []);

  const checkToken = useCallback(async () => {
    const token = getToken();
    if (!token) { setStatus("out"); return; }
    try {
      const r = await fetch(`${API_BASE}/api/auth/verify`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (d.valid) { setUsername(d.username || ""); setStatus("in"); }
      else { clearToken(); setStatus("out"); }
    } catch {
      // Backend not reachable yet — show the login screen; the login
      // attempt itself will surface a clearer "cannot reach backend" error.
      setStatus("out");
    }
  }, []);

  useEffect(() => { checkToken(); }, [checkToken]);

  const handleLoggedIn = (name) => { setUsername(name || ""); setStatus("in"); };
  const handleLogout   = () => { clearToken(); setStatus("out"); };

  if (status === "checking") {
    return (
      <div
        style={{
          height: "100vh", width: "100%", display: "flex",
          alignItems: "center", justifyContent: "center",
          background: "#161a1f", color: "#9ca3af",
          fontFamily: "sans-serif", fontSize: 13,
        }}
      >
        Checking session…
      </div>
    );
  }

  if (status === "out") {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div style={{ position: "relative", height: "100vh", width: "100%" }}>
      <App />
      <button
        onClick={handleLogout}
        title={username ? `Logged in as ${username} — click to log out` : "Log out"}
        style={{
          position: "fixed", top: 8, right: 10, zIndex: 9999,
          background: "#1e2329", color: "#f87171",
          border: "1px solid #374151", borderRadius: 4,
          fontSize: 10, fontWeight: 600, padding: "4px 8px",
          cursor: "pointer", letterSpacing: "0.02em",
        }}
      >
        ⎋ LOGOUT{username ? ` (${username})` : ""}
      </button>
    </div>
  );
}
