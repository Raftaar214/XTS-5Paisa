// auth.js
//
// Local dashboard login gate — this is NOT the XTS/5paisa broker login
// (that still happens per-client, later, via Login/Login All in the UI).
// This just decides whether a browser is allowed to open the dashboard
// at all, which matters once the app is sitting on a public VPS/AWS IP.
//
// Issues a signed, stateless bearer token (HMAC-SHA256, JWT-style) using
// Node's built-in crypto module only — no extra npm dependency needed,
// and no session store to keep in sync if the server restarts.

const crypto = require("crypto");

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Dashboard users — supports as many people as you need, each with their
// own User ID / Password, using the same numbered style as your CLI1_*,
// CLI2_* client variables:
//   APP_USER1_NAME=admin        APP_USER1_PASSWORD=changeme123
//   APP_USER2_NAME=trader2      APP_USER2_PASSWORD=changeme456
// The old single-user APP_USERNAME / APP_PASSWORD still works too (kept
// for backward compatibility) and is treated as one more user in the list.
function loadUsers() {
  const users = [];
  if (process.env.APP_USERNAME && process.env.APP_PASSWORD) {
    users.push({ username: process.env.APP_USERNAME, password: process.env.APP_PASSWORD });
  }
  for (let i = 1; i <= 20; i++) {
    const name = process.env[`APP_USER${i}_NAME`];
    const pass = process.env[`APP_USER${i}_PASSWORD`];
    if (name && pass) users.push({ username: name, password: pass });
  }
  return users;
}
const USERS = loadUsers();

if (!process.env.AUTH_SECRET) {
  console.warn("⚠️  AUTH_SECRET is not set in .env — using a random one-off secret for this run.");
  console.warn("    Every server restart will force everyone to log in again until you set AUTH_SECRET.");
}
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJSON(obj) { return b64url(Buffer.from(JSON.stringify(obj))); }
function fromB64url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function sign(data) {
  return b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
}

function createToken(username) {
  const header  = b64urlJSON({ alg: "HS256", typ: "DASH" });
  const payload = b64urlJSON({ username, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
  const sig     = sign(`${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  const expected = sign(`${header}.${payload}`);
  let a, b;
  try { a = Buffer.from(sig); b = Buffer.from(expected); } catch { return null; }
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try { data = JSON.parse(fromB64url(payload).toString("utf8")); } catch { return null; }
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

// ── very small brute-force guard (per IP) ──
const attempts = new Map(); // ip -> { count, first }
const MAX_ATTEMPTS = 8;
const WINDOW_MS     = 10 * 60 * 1000;

function isRateLimited(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) { attempts.delete(ip); return false; }
  return a.count >= MAX_ATTEMPTS;
}
function recordFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count++;
}
function clearAttempts(ip) { attempts.delete(ip); }

function extractToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// POST /api/auth/login  { username, password } -> { success, token }
function login(req, res) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Please wait a few minutes and try again." });
  }
  if (!USERS.length) {
    return res.status(500).json({ error: "Dashboard login is not configured. Set APP_USER1_NAME / APP_USER1_PASSWORD (and APP_USER2_*, etc.) in the backend .env file." });
  }

  const { username, password } = req.body || {};
  const match = USERS.find(u => u.username === username && u.password === password);
  if (match) {
    clearAttempts(ip);
    const token = createToken(match.username);
    console.log(`✅ Dashboard login: ${match.username}`);
    return res.json({ success: true, token, username: match.username, expiresInMs: TOKEN_TTL_MS });
  }

  recordFailure(ip);
  return res.status(401).json({ error: "Invalid User ID or Password" });
}

// GET /api/auth/verify — used by the frontend on load to check an existing token
function verify(req, res) {
  const data = verifyToken(extractToken(req));
  if (!data) return res.status(401).json({ valid: false });
  res.json({ valid: true, username: data.username });
}

// Express middleware — protects every other /api/* route
function requireAuth(req, res, next) {
  const data = verifyToken(extractToken(req));
  if (!data) return res.status(401).json({ error: "Unauthorized — please log in again." });
  req.user = data;
  next();
}

// Used by the "Assigned To" dropdown in User Management — usernames only,
// never passwords.
function listUsernames() {
  return USERS.map(u => u.username);
}

module.exports = { login, verify, requireAuth, listUsernames };