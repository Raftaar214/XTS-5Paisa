// auth.js
//
// Local login gates — these are NOT the XTS/5paisa broker login (that still
// happens per-client via Login / Login All).
//
//   Dashboard users  : APP_USER{n}_NAME / APP_USER{n}_PASSWORD (+ legacy
//                      APP_USERNAME / APP_PASSWORD). Trade their own clients.
//   Admin            : ADMIN_USERNAME / ADMIN_PASSWORD. Opens the Admin
//                      console (Ctrl+Shift+Space): client roster & API keys,
//                      kill switch, engine settings, risk limits, monitoring.
//
// Passwords set from the Admin console (user reset, admin change) are stored
// scrypt-hashed in data/passwords.json and take priority over .env.
//
// Issues signed, stateless bearer tokens (HMAC-SHA256, JWT-style) using
// Node's built-in crypto only. Each token carries a scope ("user" or
// "admin"); a dashboard token never opens admin routes and vice versa.

const crypto = require("crypto");
const path = require("path");
const { writeJsonAtomic, readJson } = require("./fsutil");

// ── One active session per dashboard user ──────────────────────
// data/sessions.json: { username: { sid, ip, since, userAgent } }. A token is
// valid only while its sid is the user's current session, so a second login
// can't silently share an account; logging out (or being replaced) ends it.
const SESSIONS_FILE = path.join(process.env.XTS_DATA_DIR || path.join(__dirname, "data"), "sessions.json");
let sessions = readJson(SESSIONS_FILE, {}) || {};
const lastSeen = new Map();          // username → ms (in memory only)
const revokeListeners = new Set();   // notified with { username, sid, reason }
const endedReasons = new Map();      // sid → why it ended ("replaced", "logout", "admin")

function saveSessions() {
  try { writeJsonAtomic(SESSIONS_FILE, sessions); }
  catch (err) { console.error("⚠️  Could not save sessions:", err.message); }
}
function activeSession(username) {
  const sess = sessions[username];
  if (!sess) return null;
  if (Date.now() - new Date(sess.since).getTime() > USER_TTL_MS_FOR_SESSIONS) { delete sessions[username]; saveSessions(); return null; }
  return sess;
}
function endSession(username, reason) {
  const sess = sessions[username];
  if (!sess) return false;
  delete sessions[username];
  lastSeen.delete(username);
  endedReasons.set(sess.sid, reason);
  if (endedReasons.size > 1000) endedReasons.delete(endedReasons.keys().next().value);
  saveSessions();
  revokeListeners.forEach(fn => { try { fn({ username, sid: sess.sid, reason }); } catch (_) {} });
  return true;
}
function onSessionEnded(fn) { revokeListeners.add(fn); return () => revokeListeners.delete(fn); }

// ── Passwords changed in the Admin console ─────────────────────
// data/passwords.json: { users: { name: { salt, hash, changedAt } }, admin: { … } }
const PASSWORDS_FILE = path.join(process.env.XTS_DATA_DIR || path.join(__dirname, "data"), "passwords.json");
let overrides = readJson(PASSWORDS_FILE, {}) || {};
if (!overrides.users) overrides.users = {};
const MIN_PASSWORD = 8;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}
function hashMatches(rec, password) {
  const got = Buffer.from(hashPassword(password, rec.salt).hash, "hex");
  const want = Buffer.from(String(rec.hash), "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function savePasswords() { writeJsonAtomic(PASSWORDS_FILE, overrides); }
function passwordProblem(p) {
  if (typeof p !== "string" || p.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (p.length > 200) return "Password is too long";
  if (p.trim() !== p) return "Password cannot start or end with a space";
  return null;
}

const USER_TTL_MS  = 12 * 60 * 60 * 1000; // 12 hours
const USER_TTL_MS_FOR_SESSIONS = USER_TTL_MS;
const ADMIN_TTL_MS =  2 * 60 * 60 * 1000; //  2 hours

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

const ADMIN = process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD
  ? { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }
  : null;

if (!process.env.AUTH_SECRET) {
  console.warn("⚠️  AUTH_SECRET is not set in .env — using a random one-off secret for this run.");
  console.warn("    Every server restart will force everyone to log in again until you set AUTH_SECRET.");
}
if (!ADMIN) {
  console.warn("⚠️  ADMIN_USERNAME / ADMIN_PASSWORD are not set in .env — the Admin console is disabled.");
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

// Constant-time string comparison. Hashing first makes both sides the same
// length, so neither the content nor the length of a secret leaks via timing.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createToken(username, scope, sid) {
  const ttl     = scope === "admin" ? ADMIN_TTL_MS : USER_TTL_MS;
  const header  = b64urlJSON({ alg: "HS256", typ: "DASH" });
  const payload = b64urlJSON({ username, scope, sid, iat: Date.now(), exp: Date.now() + ttl });
  const sig     = sign(`${header}.${payload}`);
  return { token: `${header}.${payload}.${sig}`, ttl };
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let data;
  try { data = JSON.parse(fromB64url(payload).toString("utf8")); } catch { return null; }
  if (!data.exp || Date.now() > data.exp) return null;
  if (!data.scope) data.scope = "user"; // tokens issued before scopes existed
  return data;
}

// Why a user token is not accepted: null = fine.
function userTokenProblem(token) {
  const data = verifyToken(token);
  if (!data || data.scope !== "user") return { code: "UNAUTHORIZED" };
  const sess = activeSession(data.username);
  if (!sess || sess.sid !== data.sid) {
    const why = endedReasons.get(data.sid);
    if (!sess && why === "password") return { code: "PASSWORD_RESET", data };
    const replaced = sess || why === "replaced";
    return { code: replaced ? "SESSION_REPLACED" : "SESSION_ENDED", data };
  }
  return null;
}

function verifyUserToken(token) {
  if (userTokenProblem(token)) return null;
  const data = verifyToken(token);
  lastSeen.set(data.username, Date.now());
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

function clientIp(req) { return req.ip || req.connection?.remoteAddress || "unknown"; }

function extractToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// POST /api/auth/login  { username, password } -> { success, token }
// Password check for one dashboard user: the console-set password if any, else .env.
function userPasswordOk(user, password) {
  const rec = overrides.users[user.username];
  return rec ? hashMatches(rec, password) : safeEqual(user.password, password);
}
function adminPasswordOk(password) {
  return overrides.admin ? hashMatches(overrides.admin, password) : safeEqual(ADMIN.password, password);
}
const DUMMY = hashPassword("not-a-real-password");

function login(req, res) {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Please wait a few minutes and try again." });
  }
  if (!USERS.length) {
    return res.status(500).json({ error: "Dashboard login is not configured. Set APP_USER1_NAME / APP_USER1_PASSWORD (and APP_USER2_*, etc.) in the backend .env file." });
  }

  const { username, password, force } = req.body || {};
  // Compare every username (no early exit), then check one password — a
  // dummy hash when the name is unknown — so timing doesn't reveal names.
  let user = null;
  for (const u of USERS) if (safeEqual(u.username, username) && !user) user = u;
  const passOk = user ? userPasswordOk(user, password) : (hashMatches(DUMMY, password), false);
  const match = passOk ? user : null;
  if (match) {
    clearAttempts(ip);
    const current = activeSession(match.username);
    if (current) {
      if (!force) {
        return res.status(409).json({
          code: "ALREADY_LOGGED_IN",
          error: `${match.username} is already logged in on another system. Log that session out to continue.`,
          activeSession: {
            ip: current.ip, since: current.since, userAgent: current.userAgent,
            lastSeenAt: lastSeen.has(match.username) ? new Date(lastSeen.get(match.username)).toISOString() : null,
          },
        });
      }
      endSession(match.username, "replaced");
      console.log(`🔒 Dashboard session of ${match.username} ended — a new login from ${ip} took over`);
      return res.json({ success: true, loggedOutOther: true, message: "The other session was logged out. Log in again to continue." });
    }
    const sid = crypto.randomBytes(12).toString("hex");
    sessions[match.username] = { sid, ip, since: new Date().toISOString(), userAgent: String(req.headers["user-agent"] || "").slice(0, 160) };
    saveSessions();
    const { token, ttl } = createToken(match.username, "user", sid);
    console.log(`✅ Dashboard login: ${match.username} from ${ip}`);
    return res.json({ success: true, token, username: match.username, expiresInMs: ttl });
  }

  recordFailure(ip);
  return res.status(401).json({ error: "Invalid User ID or Password" });
}

// POST /api/admin/login  { username, password } -> { success, token }
function adminLogin(req, res) {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many failed attempts. Please wait a few minutes and try again." });
  }
  if (!ADMIN) {
    return res.status(503).json({ error: "Admin console is disabled. Set ADMIN_USERNAME and ADMIN_PASSWORD in backend/.env and restart the backend." });
  }
  const { username, password } = req.body || {};
  const nameOk = safeEqual(ADMIN.username, username);
  const ok = adminPasswordOk(password) && nameOk;
  if (ok) {
    clearAttempts(ip);
    const { token, ttl } = createToken(ADMIN.username, "admin");
    console.log(`🛡️  Admin login: ${ADMIN.username} from ${ip}`);
    return res.json({ success: true, token, username: ADMIN.username, expiresInMs: ttl });
  }
  recordFailure(ip);
  console.warn(`⚠️  Failed admin login from ${ip}`);
  return res.status(401).json({ error: "Invalid admin credentials" });
}

// GET /api/auth/verify — used by the frontend on load to check an existing token
function verify(req, res) {
  const token = extractToken(req);
  const problem = userTokenProblem(token);
  if (problem) return res.status(401).json({ valid: false, code: problem.code });
  res.json({ valid: true, username: verifyUserToken(token).username });
}

// POST /api/auth/logout — ends this user's session (if it is this token's).
function logout(req, res) {
  const data = verifyToken(extractToken(req));
  if (data?.scope === "user" && sessions[data.username]?.sid === data.sid) {
    endSession(data.username, "logout");
    console.log(`👋 Dashboard logout: ${data.username}`);
  }
  res.json({ success: true });
}

function listSessions() {
  return Object.entries(sessions)
    .filter(([u]) => activeSession(u))
    .map(([username, x]) => ({
      username, ip: x.ip, since: x.since, userAgent: x.userAgent,
      lastSeenAt: lastSeen.has(username) ? new Date(lastSeen.get(username)).toISOString() : null,
    }));
}

// GET /api/admin/verify
function adminVerify(req, res) {
  const data = adminTokenData(extractToken(req));
  if (!data) return res.status(401).json({ valid: false });
  res.json({ valid: true, username: data.username });
}

// An admin token is valid only if issued after the last admin password change.
function adminTokenData(token) {
  const data = verifyToken(token);
  if (!data || data.scope !== "admin") return null;
  const changed = overrides.admin?.changedAt ? new Date(overrides.admin.changedAt).getTime() : 0;
  if (changed && !(data.iat >= changed)) return null;
  return data;
}

// Express middleware — dashboard routes
const SESSION_MESSAGES = {
  SESSION_REPLACED: "You were logged out — this user ID logged in on another system.",
  SESSION_ENDED: "Your session has ended — please log in again.",
  PASSWORD_RESET: "Your password was reset by the admin — log in with the new password.",
  UNAUTHORIZED: "Unauthorized — please log in again.",
};
function requireAuth(req, res, next) {
  const token = extractToken(req);
  const problem = userTokenProblem(token);
  if (problem) return res.status(401).json({ code: problem.code, error: SESSION_MESSAGES[problem.code] });
  req.user = verifyUserToken(token);
  next();
}

// Express middleware — admin routes
function requireAdmin(req, res, next) {
  const data = adminTokenData(extractToken(req));
  if (!data) return res.status(401).json({ error: "Admin session required — press Ctrl+Shift+Space and log in." });
  req.admin = data;
  next();
}

// Dashboard usernames for the "Assigned To" dropdown — never passwords.
function listUsernames() {
  return USERS.map(u => u.username);
}

// Admin "Users" tab: every dashboard user with login state — never passwords.
function listAccounts() {
  const live = new Map(listSessions().map(s => [s.username, s]));
  return USERS.map(u => ({
    username: u.username,
    passwordSetBy: overrides.users[u.username] ? "admin console" : ".env",
    passwordChangedAt: overrides.users[u.username]?.changedAt || null,
    session: live.get(u.username) || null,
  }));
}

// Admin resets a user's password: saved hashed, that user is logged out.
function resetUserPassword(username, password) {
  const user = USERS.find(u => u.username === username);
  if (!user) return { status: 404, error: "No such dashboard user" };
  const bad = passwordProblem(password);
  if (bad) return { status: 400, error: bad };
  overrides.users[username] = { ...hashPassword(password), changedAt: new Date().toISOString() };
  savePasswords();
  const loggedOut = endSession(username, "password");
  return { status: 200, loggedOut };
}

// Admin changes its own password (current one required). Every admin token
// issued before now stops working, so other admin sessions are signed out.
function changeAdminPassword(currentPassword, newPassword) {
  if (!ADMIN) return { status: 503, error: "Admin console is disabled" };
  if (!adminPasswordOk(currentPassword)) return { status: 400, error: "Current admin password is wrong" };
  const bad = passwordProblem(newPassword);
  if (bad) return { status: 400, error: bad };
  if (adminPasswordOk(newPassword)) return { status: 400, error: "The new password is the same as the current one" };
  const changedAt = new Date().toISOString();
  overrides.admin = { ...hashPassword(newPassword), changedAt };
  savePasswords();
  const { token, ttl } = createToken(ADMIN.username, "admin");
  return { status: 200, token, expiresInMs: ttl };
}

module.exports = {
  login, logout, adminLogin, verify, adminVerify, requireAuth, requireAdmin,
  listUsernames, verifyToken, verifyUserToken, safeEqual,
  listSessions, endSession, onSessionEnded,
  listAccounts, resetUserPassword, changeAdminPassword, MIN_PASSWORD,
};
