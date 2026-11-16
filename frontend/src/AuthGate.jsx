import React, { useEffect, useState, useCallback } from "react";
import App from "./App.jsx";
import LoginPage from "./LoginPage.jsx";
import AdminConsole from "./AdminConsole.jsx";
import { installAuthFetch, getToken, clearToken, API_BASE } from "./authFetch.js";

// Install the fetch patch at module load, before any component mounts, so
// even the very first requests App.jsx makes carry the dashboard token.
let expireHandler = null;
installAuthFetch(reason => expireHandler && expireHandler(reason));

// Wraps the dashboard (App.jsx) behind the User ID / Password gate, and
// hosts the Admin console, opened from anywhere with Ctrl+Shift+Space.
export default function AuthGate() {
  const [status, setStatus]       = useState("checking"); // checking | out | in
  const [username, setUsername]   = useState("");
  const [showAdmin, setShowAdmin] = useState(false);
  const [notice, setNotice]       = useState("");   // why the user was sent back to login

  useEffect(() => {
    expireHandler = reason => { setNotice(reason || "Your session has ended — please log in again."); setStatus("out"); };
    return () => { expireHandler = null; };
  }, []);

  // Ctrl+Shift+Space → Admin console (works on the login screen too).
  useEffect(() => {
    const onKey = e => {
      if (e.ctrlKey && e.shiftKey && (e.code === "Space" || e.key === " ")) {
        e.preventDefault();
        setShowAdmin(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      else {
        clearToken();
        if (d.code === "SESSION_REPLACED") setNotice("You were logged out — this user ID logged in on another system.");
        setStatus("out");
      }
    } catch {
      // Backend not reachable yet — the login attempt will surface a clearer error.
      setStatus("out");
    }
  }, []);

  useEffect(() => { checkToken(); }, [checkToken]);

  const handleLoggedIn = (name) => { setUsername(name || ""); setNotice(""); setStatus("in"); };
  const handleLogout   = async () => {
    // End the session on the server too, so this user ID can log in elsewhere.
    const token = getToken();
    try {
      if (token) await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch { /* offline: the session expires on its own */ }
    clearToken();
    setNotice("");
    setStatus("out");
  };
  const closeAdmin     = useCallback(() => setShowAdmin(false), []);

  let body;
  if (status === "checking") {
    body = (
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
  } else if (status === "out") {
    body = <LoginPage key={notice} onLoggedIn={handleLoggedIn} notice={notice} />;
  } else {
    body = (
      <div style={{ position: "relative", height: "100vh", width: "100%" }}>
        <App username={username} />
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

  return (
    <>
      {body}
      {showAdmin && <AdminConsole onClose={closeAdmin} />}
    </>
  );
}
