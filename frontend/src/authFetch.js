// authFetch.js
//
// Small helper that (a) knows where the backend lives, (b) stores the
// dashboard login token, and (c) transparently attaches it to every
// fetch() call the app makes to that backend — including all the ones
// already written inside App.jsx — WITHOUT editing App.jsx itself.
//
// If you change the backend port/host, update API_BASE here AND the
// matching `API` constant near the top of App.jsx / UserManagement.jsx
// so they stay in sync.

export const API_BASE = "http://localhost:5000"; // keep in sync with `API` in App.jsx
const TOKEN_KEY = "xts_dashboard_token";

export function getToken()   { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t)  { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

let installed = false;

export function installAuthFetch(onSessionExpired) {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : (input?.url || "");
    const isBackendCall = url.indexOf(API_BASE) === 0;
    const token = getToken();

    if (isBackendCall && token) {
      init = {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      };
    }

    return originalFetch(input, init).then(res => {
      if (isBackendCall && token && res.status === 401 && url.indexOf("/api/auth/login") === -1) {
        // Session expired or was invalidated (e.g. server restarted without AUTH_SECRET set) —
        // clear it and send the user back to the login screen.
        clearToken();
        if (onSessionExpired) onSessionExpired();
      }
      return res;
    });
  };
}
