// authFetch.js
//
// (a) stores the dashboard login token and the separate admin token,
// (b) transparently attaches the dashboard token to every fetch() the app
//     makes to the backend, and
// (c) sends the user back to the login screen when that session expires.
//
// A request that already carries its own Authorization header (the Admin
// console's requests) is left untouched, and admin 401s never log the
// dashboard user out.

import { API_BASE } from "./config.js";

export { API_BASE };

const TOKEN_KEY       = "xts_dashboard_token";
const ADMIN_TOKEN_KEY = "xts_admin_token";

export function getToken()   { return localStorage.getItem(TOKEN_KEY); }
export function setToken(t)  { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

// Admin token lives only for this browser tab (sessionStorage).
export function getAdminToken()   { try { return sessionStorage.getItem(ADMIN_TOKEN_KEY); } catch { return null; } }
export function setAdminToken(t)  { try { sessionStorage.setItem(ADMIN_TOKEN_KEY, t); } catch {} }
export function clearAdminToken() { try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch {} }

// fetch() for /api/admin/* with the admin token. Resolves to parsed JSON;
// throws Error(message) on failure, with .status set.
export async function adminFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAdminToken() || ""}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401) clearAdminToken();
    throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
  }
  return data;
}

function hasAuthHeader(headers) {
  if (!headers) return false;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.has("Authorization");
  return Object.keys(headers).some(k => k.toLowerCase() === "authorization");
}

let installed = false;

export function installAuthFetch(onSessionExpired) {
  if (installed) return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : (input?.url || "");
    const isBackendCall = url.indexOf(API_BASE) === 0;
    const isAdminCall   = isBackendCall && url.indexOf(`${API_BASE}/api/admin`) === 0;
    const token = getToken();

    if (isBackendCall && !isAdminCall && token && !hasAuthHeader(init.headers)) {
      init = {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      };
    }

    return originalFetch(input, init).then(res => {
      if (isBackendCall && !isAdminCall && token && res.status === 401 && url.indexOf("/api/auth/login") === -1) {
        // Session expired, ended, or replaced by a login elsewhere — back to
        // the login screen with the server's reason.
        clearToken();
        if (onSessionExpired) {
          res.clone().json().then(d => onSessionExpired(d?.error || "")).catch(() => onSessionExpired(""));
        }
      }
      return res;
    });
  };
}
