# XTS 5paisa API Reference

This document describes the local backend API used by the XTS 5paisa Multi-Client Trading Dashboard. It is intended for developers and operators who need to configure, test, deploy, or extend the application.

## Base URLs

Everything is on one port (`PORT`, default 5000) — the dashboard, the REST API and the quote WebSocket:

```text
Dashboard: http://<server IP>:5000/
REST API:  http://<server IP>:5000/api/...
WebSocket: ws://<server IP>:5000/ws
```

The server listens on all interfaces (`0.0.0.0`). `index.html` is sent with `Cache-Control: no-cache`; hashed files under `/assets/` are cached for a year.

XTS broker endpoints are configured in `backend/.env`:

```env
XTS_INTERACTIVE_URL=https://xtsmum.5paisa.com
XTS_MARKET_URL=https://xtsmum.5paisa.com
```

## Authentication

The dashboard uses a local bearer token. This token protects local `/api/*` routes and is not the XTS broker token.

### Login

```http
POST /api/auth/login
Content-Type: application/json
```

Request:

```json
{
  "username": "admin",
  "password": "change-this-password"
}
```

Response:

```json
{
  "success": true,
  "token": "signed-dashboard-token",
  "username": "admin",
  "expiresInMs": 43200000
}
```

**One login per user.** If the user already has an active session, the login is refused:

```http
HTTP/1.1 409 Conflict
```

```json
{
  "code": "ALREADY_LOGGED_IN",
  "error": "trader1 is already logged in on another system. Log that session out to continue.",
  "activeSession": { "ip": "192.168.1.20", "since": "2026-11-13T04:00:00.000Z", "userAgent": "…", "lastSeenAt": "…" }
}
```

Sending the same credentials with `"force": true` ends the other session and returns **no token** — the user must log in again:

```json
{ "success": true, "loggedOutOther": true, "message": "The other session was logged out. Log in again to continue." }
```

A request made with an ended session's token gets `401` with `code` `SESSION_REPLACED` (another login took over), `SESSION_ENDED` (logged out or ended by the admin) or `UNAUTHORIZED`, and its quote WebSocket is closed. Sessions are stored in `data/sessions.json` and survive restarts.

### Logout

```http
POST /api/auth/logout
Authorization: Bearer signed-dashboard-token
```

Ends the session so the user can log in from another system without `force`.

### Verify Token

```http
GET /api/auth/verify
Authorization: Bearer signed-dashboard-token
```

Response:

```json
{
  "valid": true,
  "username": "admin"
}
```

### Admin Login

The Admin console (Ctrl+Shift+Space in the dashboard) has its own credentials, `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `backend/.env`.

```http
POST /api/admin/login
GET  /api/admin/verify
```

Same request and response shape as the dashboard login. Admin tokens last 2 hours.

Token scopes:

- `/api/admin/*` routes accept **only** an admin token.
- All other `/api/*` routes accept **only** a dashboard user token.

Failed logins are rate-limited per IP (8 attempts per 10 minutes). Passwords are compared in constant time.

### CORS

Browser requests are accepted only from origins listed in `CORS_ORIGINS` (comma-separated). When it is unset, localhost and private-LAN origins are allowed. Other origins receive `403`.

## Instruments

### Instrument Source

The backend downloads the instrument master from Upstox when it starts:

```text
https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz
```

Override with `INSTRUMENT_URL` in `backend/.env`. The last good download is cached in `backend/data/instruments-cache.json.gz` and used only if Upstox cannot be reached at startup. A failed refresh never replaces data that is already loaded.

### Get Dashboard Instruments

```http
GET /api/instruments
Authorization: Bearer signed-dashboard-token
```

Returns the F&O contracts the leg builder uses (`NSE_FO`, `BSE_FO`, `MCX_FO`), trimmed to `segment`, `exchange_token`, `asset_symbol`, `instrument_type`, `expiry`, `strike_price`, `lot_size`, `trading_symbol`. Every segment stays mapped on the server for quote subscriptions.

### Refresh Instruments

```http
POST /api/instruments/refresh
Authorization: Bearer signed-dashboard-token
```

Downloads a fresh master from Upstox. Overlapping requests share one download.

Response (also returned by `GET /api/instruments/status`):

```json
{
  "source": "upstox",
  "url": "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz",
  "fetchedAt": "2026-11-13T03:45:10.000Z",
  "refreshing": false,
  "lastError": null,
  "count": 120000,
  "dashboardCount": 85000
}
```

If the download fails but data is already loaded, the response is still `200` with `lastError` set. If no data is available at all, the response is `502`.

### Upload Instruments

```http
POST /api/instruments
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Replaces the loaded master with a JSON array (or an object holding one) until the next refresh.

## Client Management (Admin)

Clients are stored in `backend/data/clients.json`. Runtime state such as login status, connection status, token, and user ID is kept in memory. Adding, editing and deleting clients requires an **admin** token; dashboard users cannot read keys or change the roster.

### List Dashboard Clients

```http
GET /api/clients
Authorization: Bearer signed-dashboard-token
```

Returns only the clients assigned to the logged-in dashboard user plus unassigned ones:

```json
[
  {
    "id": "55583335",
    "name": "Parent Client",
    "enabled": true,
    "isLogged": false,
    "isConnected": false
  }
]
```

### List All Clients

```http
GET /api/admin/clients
Authorization: Bearer signed-admin-token
```

Secrets are masked and are never returned in plain text.

### Add Client

```http
POST /api/admin/clients
Authorization: Bearer signed-admin-token
Content-Type: application/json
```

Parent request:

```json
{
  "id": "55583335",
  "name": "Parent Client",
  "role": "PARENT",
  "rootUrl": "https://xtsmum.5paisa.com",
  "source": "WEBAPI",
  "assignedTo": "",
  "interactiveKey": "interactive-api-key",
  "interactiveSecret": "interactive-secret-key",
  "marketKey": "market-data-api-key",
  "marketSecret": "market-data-secret-key",
  "enabled": true
}
```

Child request:

```json
{
  "id": "CHILD001",
  "name": "Child Client",
  "role": "CHILD",
  "multiplier": 2,
  "rootUrl": "https://xtsmum.5paisa.com",
  "source": "WEBAPI",
  "assignedTo": "trader1",
  "interactiveKey": "interactive-api-key",
  "interactiveSecret": "interactive-secret-key",
  "enabled": true
}
```

Rules:

- Only one parent is allowed.
- Parent requires Interactive API and Market Data API credentials.
- Child requires Interactive API credentials only.
- Child multiplier must be greater than zero.
- Blank secret fields during update keep the existing stored value.
- `assignedTo` limits the client to one dashboard user; empty means everyone.

### Update Client

```http
PUT /api/admin/clients/:id
Authorization: Bearer signed-admin-token
Content-Type: application/json
```

Only supplied fields are updated. Changing the parent's Market Data keys or Root URL restarts the market feed.

### Delete Client

```http
DELETE /api/admin/clients/:id
Authorization: Bearer signed-admin-token
```

If the client is logged in, the backend logs it out before removing it.

### Admin Session Control for Any Client

```http
POST /api/admin/clients/:id/login
POST /api/admin/clients/:id/logout
POST /api/admin/clients/:id/connect
POST /api/admin/clients/:id/disconnect
POST /api/admin/clients/:id/toggle        { "enabled": false }
POST /api/admin/clients/disconnect-all
POST /api/admin/clients/logout-all
Authorization: Bearer signed-admin-token
```

`toggle` is persisted to `clients.json`.

## Admin: Execution Controls and Monitoring

### Settings (mode, kill switch, segments, sizing, engine, risk limits)

```http
GET /api/admin/settings
PUT /api/admin/settings
Authorization: Bearer signed-admin-token
```

`PUT` accepts any subset:

```json
{
  "tradingMode": "PAPER",
  "tradingHalted": true,
  "haltReason": "Volatile open",
  "allowedSegments": ["NSE_FO", "BSE_FO", "NSE_EQ"],
  "products": { "NSE_EQ": "CNC", "BSE_EQ": "CNC", "default": "NRML" },
  "sizing": { "mode": "capital", "baseCapital": 10000000, "rounding": "floor" },
  "engine": { "bufferPct": 0.5, "fillTimeout": 4, "maxRetries": 1, "pollInterval": 0.5, "cancelTimeout": 5, "retryDelay": 2, "orderGapMs": 110 },
  "limits": { "maxLegs": 8, "maxLotsPerLeg": 10, "maxQtyPerOrder": 1800, "maxOrderValue": 500000, "maxActiveClients": 0, "maxOrdersPerMinute": 60 }
}
```

| Field | Values |
|---|---|
| `tradingMode` | `PAPER` (default — every order simulated on the live feed, nothing reaches the broker) or `LIVE` |
| `allowedSegments` | any of `NSE_FO`, `BSE_FO`, `MCX_FO`, `NSE_EQ`, `BSE_EQ`, `NCD_FO`, `BCD_FO` (default the three F&O segments). `GET` lists them under `segments`. |
| `products` | product type per segment: `NRML`, `MIS` or `CNC` (`GET` lists them under `productTypes`); `default` covers segments not named |
| `sizing.mode` | `multiplier` (each client's multiplier) or `capital` (client capital ÷ `baseCapital`) |
| `sizing.rounding` | `floor` (default — never more than the ratio) or `round` |
| `engine.orderGapMs` | minimum gap between two orders of one client, 50–2000 ms (default 110; `ORDER_MIN_GAP_MS` overrides) |

Values outside the allowed ranges (returned by `GET` under `ranges`) are rejected with `400`. A limit of `0` means no limit. Settings are saved to `backend/data/settings.json`. A new install starts with `tradingMode: "PAPER"` and `tradingHalted: true`.

### Monitor

```http
GET /api/admin/monitor
Authorization: Bearer signed-admin-token
```

Returns uptime, memory, trading settings, executions in flight, dashboard socket count, instrument status, every client, the last 300 execution results, the last 300 admin actions (audit trail), plus:

- `market`: `{ loggedIn, socketConnected, joined, subscribedTokens, ticksLastMinute, lastTickAt, lastTickAgeMs, reloginsLast5Min, takeoverSuspected, lastError, rootUrl }`. `takeoverSuspected` is true after 3+ forced re-logins in 5 minutes — another program is using the same Market Data key.
- `sessions`: logged-in dashboard users.
- `orderStreams`: each client's Interactive order-socket state.
- `latency`: execute-to-fill statistics (queue / ack / fill / total, ms).

History resets when the backend restarts.

### Dashboard Sessions

```http
GET    /api/admin/sessions
DELETE /api/admin/sessions/:username
Authorization: Bearer signed-admin-token
```

`GET` returns `[{ username, ip, since, userAgent, lastSeenAt }]`. `DELETE` ends that user's session (their dashboard is signed out with `SESSION_ENDED`).

### Margins and Trade Books

```http
GET  /api/admin/margins
GET  /api/admin/tradebooks?date=YYYY-MM-DD
GET  /api/admin/tradebooks/all?date=YYYY-MM-DD&format=csv
GET  /api/admin/tradebooks/:clientId?date=YYYY-MM-DD&format=csv
POST /api/admin/tradebooks/snapshot
Authorization: Bearer signed-admin-token
```

`/margins` reads each logged-in client's broker balance (`/interactive/user/balance` → `RMSSubLimits`) and returns available, utilized and related figures; clients that are not logged in show why. Trade books are the broker's own trade book per client, saved per day; `snapshot` saves today's now.

### Other Admin Actions

```http
POST /api/admin/market/restart
POST /api/admin/instruments/refresh
GET  /api/admin/users
Authorization: Bearer signed-admin-token
```

`/users` lists dashboard usernames (never passwords) for the "Assigned To" field.

## Client Session Controls

### Login Client

```http
POST /api/clients/:id/login
Authorization: Bearer signed-dashboard-token
```

Logs the selected client in to the XTS Interactive API.

### Logout Client

```http
POST /api/clients/:id/logout
Authorization: Bearer signed-dashboard-token
```

### Login All Clients

```http
POST /api/clients/login-all
Authorization: Bearer signed-dashboard-token
```

### Logout All Clients

```http
POST /api/clients/logout-all
Authorization: Bearer signed-dashboard-token
```

### Connect or Disconnect Client for Trading

```http
POST /api/clients/:id/connect
POST /api/clients/:id/disconnect
Authorization: Bearer signed-dashboard-token
```

A connected client is eligible for order execution only when it is also enabled and logged in.

### Connect or Disconnect All Clients

```http
POST /api/clients/connect-all
POST /api/clients/disconnect-all
Authorization: Bearer signed-dashboard-token
```

### Enable or Disable Trading for a Client

```http
POST /api/clients/:id/toggle
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Request:

```json
{
  "enabled": true
}
```

## Market Data

### Subscribe Tokens

```http
POST /api/subscribe
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Request:

```json
{
  "tokens": ["12345", "67890"],
  "segments": ["NSE_FO", "BSE_FO"]
}
```

Response:

```json
{
  "status": "subscribed",
  "count": 2
}
```

The backend converts dashboard segment names to XTS segment codes and subscribes through the XTS Market Data API (`POST /apimarketdata/instruments/subscription`, `xtsMessageCode 1501`, in chunks of 50). Ticks then arrive on the market socket (`1501-json-full` touchline, `1502-json-full` depth) and are pushed to the dashboard immediately — there is no polling. Subscriptions are owned per dashboard user and per strategy; a token is unsubscribed from XTS only when no owner needs it. After a market-session recovery every owned token is subscribed again automatically.

### Unsubscribe Tokens

```http
POST /api/unsubscribe
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Request:

```json
{
  "tokens": ["12345"]
}
```

### Local Quote WebSocket

Connect with a dashboard token:

```text
ws://<server IP>:5000/ws?token=signed-dashboard-token
```

Connections without a valid token are refused with HTTP `401`. Sockets whose token expires, or whose session is ended or replaced, are closed with code `4401`. Each quote carries `ts` (server receive time, ms). An unsubscribed token is sent once as `{ "12345": { "removed": true } }` so the dashboard clears its price.

Quote message:

```json
{
  "type": "quote",
  "data": {
    "12345": {
      "bid": 100.25,
      "ask": 100.35,
      "ltp": 100.3,
      "hasData": true
    }
  }
}
```

Snapshot message:

```json
{
  "type": "quotes",
  "data": {
    "12345": {
      "bid": 100.25,
      "ask": 100.35,
      "ltp": 100.3,
      "hasData": true
    }
  }
}
```

## Order Execution

### Execution Settings (read-only)

```http
GET /api/execution/config
Authorization: Bearer signed-dashboard-token
```

Returns `tradingMode`, `tradingHalted`, `haltReason`, `engine`, `limits`, `allowedSegments` and `sizing` so the dashboard can show what the engine will do.

### Activity Log

```http
POST /api/activity
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

```json
{ "entries": [ { "ts": 1794587155676, "message": "L2 segment → NSE_EQ" } ] }
```

Saves Global Market Log lines (at most 500 per request, 1000 characters each) to the day's event journal with `source: "UI"`; the level (`info` / `warn` / `error`) is taken from the text. The dashboard queues lines in `localStorage` and sends them every second, so lines written offline arrive later. Response: `{ "saved": 1 }`.

```http
GET /api/journal/events?date=YYYY-MM-DD
GET /api/journal/events?date=YYYY-MM-DD&format=csv
GET /api/journal/trades?date=YYYY-MM-DD&format=csv
```

The user's own events (UI, execution, strategy) and fills for that day. CSV columns for events: `date, time, source, level, user, strategy, assignmentId, client, message, clientTime, id`. Admins use `/api/admin/journal/...` for everyone.

### Execute Portfolio

```http
POST /api/order
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Request:

```json
{
  "legs": [
    {
      "segment": "NSE_FO",
      "symbol": "NIFTY",
      "type": "CE",
      "expiry": "2026-07-30",
      "strike": "25000",
      "exchange_token": "12345",
      "lot_size": 75,
      "lots": "1",
      "side": "Buy",
      "bid": 100.25,
      "ask": 100.35,
      "ltp": 100.3
    }
  ]
}
```

Execution behavior:

- Orders are sent to every active client.
- **LIVE** (`tradingMode: "LIVE"`): active client means enabled, logged in, and connected. **PAPER** (default): every enabled client, through the simulated broker (`PAPER-YYYYMMDD-XXXXXX` order IDs, fills against the live bid/ask) — nothing reaches 5paisa.
- Each client's lots = `lots × factor`, in whole lots (rounded down by default). The factor is the client's multiplier (`sizing.mode: "multiplier"`) or `capital ÷ baseCapital` (`"capital"`). A client that rounds to 0 lots gets `FAILED` with "rounds to 0 lots"; the others still trade.
- Quantity is `lots × lot_size` (equity lot size is 1); MCX quantity is in lots.
- Product type comes from Admin → Execution & Limits (`NRML` for F&O, `CNC` for equity by default).
- Orders are XTS limit orders at a marketable price (ask/bid ± buffer), rounded to the instrument's own tick size.
- The engine waits for the fill pushed over the Interactive order socket (falling back to polling the order history), cancels unfilled quantity after the fill timeout, waits for the broker to confirm, and retries only what is genuinely unfilled. Fills that arrive while the cancel is in flight are counted. PAPER uses the same steps.
- Orders of one client go out at least `orderGapMs` (110 ms) apart; different clients run in parallel.
- A placement that times out or gets no response is **not** retried: the result is `MANUAL_CHECK`. A rejection the broker answers is retried.
- `avgPrice` is the quantity-weighted average across attempts.

Refusals (nothing is sent to the broker):

| Status | Reason |
|--------|--------|
| `423` | Trading halted by admin |
| `400` | No legs, too many legs, segment not allowed, lots not a whole number, lots above `maxLotsPerLeg`, no active clients, too many active clients |
| `409` | An execution is already running for this dashboard user |

Per-order limits (`maxQtyPerOrder`, `maxOrderValue`) are checked for each client after its multiplier. An order over the limit comes back as `FAILED` with an error starting "Risk limit".

Result `status` values: `FILLED`, `PARTIAL`, `FAILED`, `MANUAL_CHECK`.

Response:

```json
[
  {
    "client": "55583335",
    "clientName": "Parent Client",
    "label": "NIFTY CE 25000",
    "token": "12345",
    "side": "BUY",
    "requestedQty": 75,
    "filledQty": 75,
    "remainingQty": 0,
    "avgPrice": 100.35,
    "orderId": "123456789",
    "multiplier": 1,
    "attempts": [],
    "latency": { "queueMs": 0, "ackMs": 38, "fillMs": 112, "totalMs": 150 },
    "status": "FILLED",
    "success": true
  }
]
```

`latency`: `queueMs` waiting for the order gap, `ackMs` send → order ID, `fillMs` order ID → filled, `totalMs` Execute → filled. Every execution and per-client result is also written to the activity journal (`source: "EXECUTION"`).

## Automated Strategies

### Admin

```http
GET    /api/admin/strategies                 library (summary, warnings, who it is assigned to)
POST   /api/admin/strategies                 { "fileName": "x.strategy.json", "content": { …bt-strategy-config… } }
DELETE /api/admin/strategies/:id             refused while assigned
GET    /api/admin/strategies/:id/raw         the uploaded file
GET    /api/admin/assignments                every assignment with live status
POST   /api/admin/assignments                { "strategyId", "username", "capital", "mode": "PAPER"|"LIVE", "clientIds": [] }
PUT    /api/admin/assignments/:id            same fields, plus "allocations": { "<clientId>": 5000000 }; mode can change only while STOPPED
DELETE /api/admin/assignments/:id            only when STOPPED with no open positions
POST   /api/admin/assignments/:id/start|stop|squareoff|resume
GET    /api/admin/journal/trades|events?date=YYYY-MM-DD[&user=name][&format=csv]
Authorization: Bearer signed-admin-token
```

Upload errors return `400` with `error` (all reasons joined) and `errors` (list).

`allocations` (₹ per client, needs the assignment's `capital`): that client's lots = strategy lots × allocation ÷ capital. A client without an allocation uses the global sizing; `0` keeps the client out of this strategy. While the global mode is PAPER, LIVE assignments run as PAPER (status shows `assignedMode: "LIVE"`, `mode: "PAPER"`). Legs in segments that are not allowed are skipped.

### Dashboard user

```http
GET  /api/strategies                          strategies assigned to me, with status and positions
POST /api/strategies/:id/start|stop|squareoff|resume
GET  /api/journal/trades|events?date=YYYY-MM-DD[&format=csv]   my own records
GET  /api/clients/:id/strategy-positions      my PAPER strategies' positions on that client (open + today); LIVE ones are excluded
GET  /api/clients/:id/strategy-orders?date=   my PAPER strategies' orders on that client, by PAPER order ID; LIVE ones are excluded
Authorization: Bearer signed-dashboard-token
```

Status object (abridged):

```json
{
  "assignmentId": "asg_…", "strategyName": "0dte v2", "mode": "PAPER",
  "status": "RUNNING", "phase": "Armed — next entry day 2026-11-17 at 09:20",
  "symbols": [{ "underlying": "NIFTY", "expiry": "2026-11-17", "dte": 1, "entryDay": false }],
  "openPositions": 0, "pnlToday": { "realized": 0, "unrealized": 0, "total": 0 },
  "positions": []
}
```

Statuses: `STOPPED`, `RUNNING`, `STOPPING` (no new entries; open positions still protected), `PAUSED` (manual check needed or order breaker tripped — review, then resume).

Trade journal records carry `source` (MANUAL / STRATEGY), `mode` (LIVE / PAPER), `orderId` (broker AppOrderID, or `PAPER-YYYYMMDD-XXXXXX`), `reason` (MANUAL, ENTRY <group> <slot>, STOP, DAILY_LOSS, TIME_EXIT, SQUARE_OFF, EXPIRY) and `pnl` on exits.

## Order, Trade, and Position Books

### Orders

```http
GET /api/clients/:id/orders
Authorization: Bearer signed-dashboard-token
```

### Trades

```http
GET /api/clients/:id/trades
Authorization: Bearer signed-dashboard-token
```

### Positions

```http
GET /api/clients/:id/positions
Authorization: Bearer signed-dashboard-token
```

When positions are returned, the backend attempts to subscribe to open position tokens so live quotes are available.

## Segment Mapping

Common dashboard segment values:

```text
NSE_FO          -> NSEFO   (F&O, NRML)
BSE_FO          -> BSEFO   (F&O, NRML)
MCX / MCX_FO    -> MCXFO   (commodity F&O, quantity in lots)
NSE_EQ          -> NSECM   (equity, CNC; series EQ/BE/BZ/SM/ST)
BSE_EQ          -> BSECM   (equity, CNC; groups A/B/T/X/XT/M/MT/Z/ZP/P/MS/R/TS)
NCD_FO          -> NSECD   (currency)
BCD_FO          -> BSECD   (currency)
```

`NSE_COM` is not offered (no XTS segment). Tick sizes come from the instrument master (`tick_size` in paise ÷ 100).

XTS market data segment codes:

```text
NSECM: 1
NSEFO: 2
NSECD: 3
BSECM: 11
BSEFO: 12
BSECD: 13
MCXFO: 51
```

## Function Code Examples

The following examples show how to call the local dashboard API from JavaScript. These examples are written as standalone functions and can be used in a browser, Node.js 18 or later, or a frontend service file.

### API Client Helper

```js
const API_BASE = "http://localhost:5000";

async function apiRequest(path, options = {}) {
  const token = options.token;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || data?.message || `HTTP ${response.status}`);
  }

  return data;
}
```

### Dashboard Login Function

```js
async function loginDashboard(username, password) {
  const data = await apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  return data.token;
}

async function verifyDashboardToken(token) {
  return apiRequest("/api/auth/verify", {
    method: "GET",
    token,
  });
}
```

### Add Parent Client Function

```js
// Requires an ADMIN token from POST /api/admin/login
async function addParentClient(adminToken) {
  return apiRequest("/api/admin/clients", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({
      id: "55583335",
      name: "Parent Client",
      role: "PARENT",
      rootUrl: "https://xtsmum.5paisa.com",
      source: "WEBAPI",
      interactiveKey: "interactive-api-key",
      interactiveSecret: "interactive-secret-key",
      marketKey: "market-data-api-key",
      marketSecret: "market-data-secret-key",
      enabled: true,
    }),
  });
}
```

### Add Child Client Function

```js
async function addChildClient(adminToken) {
  return apiRequest("/api/admin/clients", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({
      id: "CHILD001",
      name: "Child Client",
      role: "CHILD",
      multiplier: 2,
      rootUrl: "https://xtsmum.5paisa.com",
      source: "WEBAPI",
      interactiveKey: "interactive-api-key",
      interactiveSecret: "interactive-secret-key",
      enabled: true,
    }),
  });
}
```

### Login and Connect Client Function

```js
async function loginAndConnectClient(token, clientId) {
  const loginResult = await apiRequest(`/api/clients/${clientId}/login`, {
    method: "POST",
    token,
  });

  if (loginResult.status === "login_failed") {
    throw new Error(loginResult.error || "Client login failed");
  }

  const connectResult = await apiRequest(`/api/clients/${clientId}/connect`, {
    method: "POST",
    token,
  });

  return {
    login: loginResult,
    connect: connectResult,
  };
}
```

### Subscribe Market Data Function

```js
async function subscribeMarketData(token, instruments) {
  return apiRequest("/api/subscribe", {
    method: "POST",
    token,
    body: JSON.stringify({
      tokens: instruments.map((item) => String(item.exchangeInstrumentID)),
      segments: instruments.map((item) => item.exchangeSegment),
    }),
  });
}

await subscribeMarketData(token, [
  { exchangeSegment: "NSE_FO", exchangeInstrumentID: 12345 },
  { exchangeSegment: "BSE_FO", exchangeInstrumentID: 67890 },
]);
```

### Listen to Live Quotes Function

```js
function listenToQuotes(token, onQuote) {
  const socket = new WebSocket(`ws://localhost:5000/ws?token=${encodeURIComponent(token)}`);

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "quote" || message.type === "quotes") {
      onQuote(message.data);
    }
  };

  socket.onerror = () => {
    console.error("Quote WebSocket error");
  };

  socket.onclose = () => {
    console.warn("Quote WebSocket closed");
  };

  return socket;
}

const quoteSocket = listenToQuotes(token, (quotes) => {
  console.log("Live quotes:", quotes);
});
```

### Execute Portfolio Function

```js
async function executePortfolio(token) {
  return apiRequest("/api/order", {
    method: "POST",
    token,
    body: JSON.stringify({
      legs: [
        {
          segment: "NSE_FO",
          symbol: "NIFTY",
          type: "CE",
          expiry: "2026-07-30",
          strike: "25000",
          exchange_token: "12345",
          lot_size: 75,
          lots: "1",
          side: "Buy",
          bid: 100.25,
          ask: 100.35,
          ltp: 100.3,
        },
      ],
    }),
  });
}
```

### Fetch Order, Trade, and Position Books

```js
async function getClientBooks(token, clientId) {
  const [orders, trades, positions] = await Promise.all([
    apiRequest(`/api/clients/${clientId}/orders`, { method: "GET", token }),
    apiRequest(`/api/clients/${clientId}/trades`, { method: "GET", token }),
    apiRequest(`/api/clients/${clientId}/positions`, { method: "GET", token }),
  ]);

  return { orders, trades, positions };
}
```

### Complete Local API Flow

```js
async function runExample() {
  const token = await loginDashboard("trader1", "change-this-password");

  await verifyDashboardToken(token);
  await loginAndConnectClient(token, "55583335");

  await subscribeMarketData(token, [
    { exchangeSegment: "NSE_FO", exchangeInstrumentID: 12345 },
  ]);

  const socket = listenToQuotes(token, (quotes) => {
    console.log("Quote update:", quotes);
  });

  const result = await executePortfolio(token);
  console.log("Execution result:", result);

  socket.close();
}
```

## Backend Module Functions

The backend also exposes internal functions that are used by `server.js`. These functions are not HTTP endpoints. They are useful when extending backend behavior or writing backend-side tests.

### Interactive API Functions

Defined in `backend/xtsApi.js`:

```js
const {
  loginClient,
  logoutClient,
  placeOrder,
  cancelOrder,
  getOrderHistory,
  getOrders,
  getTrades,
  getPositions,
} = require("./xtsApi");
```

Example:

```js
async function loginAndPlaceDirectOrder(client) {
  const session = await loginClient(client);

  client.token = session.token;
  client.userID = session.userID;
  client.isLogged = true;

  return placeOrder(client, {
    exchangeSegment: "NSEFO",
    exchangeInstrumentID: 12345,
    productType: "NRML",
    orderType: "LIMIT",
    orderSide: "BUY",
    timeInForce: "DAY",
    disclosedQuantity: 0,
    orderQuantity: 75,
    limitPrice: 100.35,
    stopPrice: 0,
    orderUniqueIdentifier: `MANUAL_${Date.now()}`,
  });
}
```

### Market Data Functions

Defined in `backend/Marketsocket.js`:

```js
const {
  loginMarketData,
  connectMarketSocket,
  subscribeTokens,
  unsubscribeTokens,
  onPriceUpdate,
  getLivePrices,
} = require("./Marketsocket");
```

Example:

```js
async function startMarketDataForTokens() {
  const token = await loginMarketData();

  if (!token) {
    throw new Error("Market Data login failed");
  }

  connectMarketSocket();

  onPriceUpdate((quotes) => {
    console.log("Quote update:", quotes);
  });

  await subscribeTokens(["12345"], ["NSE_FO"]);

  return getLivePrices();
}
```

### Execution Engine Function

Defined in `backend/index.js`:

```js
const { executeOrderMulti } = require("./index");
```

Example:

```js
async function executeForActiveClients(legs, clients) {
  const activeClients = clients.filter((client) => {
    return client.enabled && client.isLogged && client.isConnected;
  });

  if (!activeClients.length) {
    throw new Error("No active clients");
  }

  // Pass engine settings and per-order limits explicitly when calling directly.
  return executeOrderMulti(legs, activeClients, {
    bufferPct: 0.5, fillTimeout: 4, maxRetries: 1,
    limits: { maxQtyPerOrder: 1800, maxOrderValue: 500000 },
  });
}
```

## Deployment Checklist

- Set strong dashboard passwords and a separate strong `ADMIN_PASSWORD`.
- Set a permanent `AUTH_SECRET`.
- Set `CORS_ORIGINS` to the dashboard's public origin.
- Confirm the backend can reach `assets.upstox.com` (or set `INSTRUMENT_URL`).
- Keep `.env` and `data/` private.
- Set `VITE_API_URL` / `VITE_WS_URL` in `frontend/.env` if the backend is not on the dashboard's host.
- Review risk limits, then resume trading from the Admin console.
- Use HTTPS for REST and WSS for WebSocket traffic in production.
- Confirm firewall rules allow the backend REST port and WebSocket port only as intended.
- Run frontend production build with `npm run build`.
- Serve the frontend `dist` folder through a production web server.

## Troubleshooting

### Dashboard login fails

Check `APP_USER{n}_NAME`, `APP_USER{n}_PASSWORD`, and `AUTH_SECRET` in `backend/.env`.

### Admin console says it is disabled

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `backend/.env` and restart the backend.

### Execute is greyed out with "Trading halted"

An admin must resume trading in Admin console → Execution & Limits.

### Broker login fails

Confirm the client Interactive API key, secret, source, and root URL.

### Quotes do not update

Confirm the parent has Market Data API credentials and that the selected token has been subscribed. Check that the backend market data socket is connected.

### Order execution returns no active clients

At least one client must be enabled, logged in, and connected before execution.

### Frontend cannot reach backend

The frontend uses the address it was opened from (REST on the same origin, WebSocket at `/ws`), or `VITE_API_URL` / `VITE_WS_URL` if set. Also check `CORS_ORIGINS`.

### Instruments did not load

Open Admin console → Monitor. The Instruments card shows the last download error. Press **Refresh instruments** once the backend can reach Upstox.
