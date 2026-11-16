# XTS 5paisa Multi-Client Trading Dashboard

This project is a Node.js and React trading dashboard for the XTS 5paisa API. It provides a secured web dashboard, parent and child client management, live bid and ask market data, and multi-client order execution from a single portfolio screen.

The structure follows the same professional documentation pattern used by the Symphony Fintech XTS SDK: installation, configuration, usage, market data, order flow, examples, and deployment notes.

## Features

- Dashboard login using a local username and password (one or more users).
- Admin console (Ctrl+Shift+Space, separate admin login) for client API keys, parent/child roster, kill switch, engine settings, risk limits and live monitoring.
- One parent client with Interactive API and Market Data API credentials.
- Multiple child clients with Interactive API credentials and individual quantity multipliers.
- Tick-by-tick bid/ask/LTP pushed from the XTS market-data socket (no polling), with automatic session recovery and per-leg subscribe/unsubscribe.
- Instrument master downloaded from Upstox on startup, with a Refresh Instruments button. All segments: NSE/BSE/MCX F&O, NSE/BSE equity, NSE/BSE currency — the admin chooses which ones are tradable.
- **Global PAPER / LIVE switch** (admin). PAPER is the default: every order, manual or strategy, is simulated on the live feed and nothing reaches the broker.
- One active login per dashboard user: logging in elsewhere warns, ends the other session, and asks for a fresh login.
- Lot sizing per client by multiplier or by capital (e.g. base ₹1 Cr → 1x, ₹2 Cr → 2x), plus per-strategy capital allocation per client.
- Multi-leg portfolio execution across all enabled, logged-in, and connected clients.
- Marketable limit order execution with retry, timeout, partial-fill, cancel, and order-history handling. Fills that arrive while a cancel is in flight are counted, so a retry never over-fills.
- Pre-trade risk limits and a global trading halt, enforced on the server before any order is sent.
- Order book, trade book, and position views per client (auto-refreshing), plus **Algo Pos** / **Algo Orders** views of each client's PAPER strategy positions and orders (LIVE strategy trades show in the broker views).
- **Automated strategies**: upload backtester strategy files (`*.strategy.json`), assign them to dashboard users, and they trade by themselves on their entry days and times — PAPER (simulated on the live feed, with `PAPER-…` order IDs) or LIVE.
- Durable trade book and activity log on the server (CSV download), safe across restarts and lost connections. The Global Market Log (orders, fills, pending, failures, errors, leg changes, subscriptions) is queued in the browser while offline and saved on the server.
- Execute-to-fill latency per order (queue / ack / fill / total), shown in the admin monitor.
- Per-client order spacing (110 ms, under the broker's 10 orders/s) and an orders-per-minute circuit breaker.
- Admin views of each client's margin (available / utilized) and a daily broker trade book per client.

## Project Structure

```text
XTS 5paisa/
|-- backend/
|-- start.bat                  One-click start: install, build, serve on this PC's IP
|-- scripts/show-urls.js       Prints the LAN URLs the dashboard can be opened on
|-- tests/                     All tests (fake broker — never place real orders)
|   `-- fixtures/
|-- backend/
|   |-- server.js              Express REST API, dashboard files and /ws quote relay
|   |-- auth.js                Dashboard/admin login, one session per user
|   |-- clients.js             Parent and child client storage (multiplier, capital)
|   |-- settings.js            PAPER/LIVE, kill switch, segments, sizing, engine, limits
|   |-- monitor.js             Execution history, latency, admin audit trail
|   |-- xtsApi.js              XTS Interactive API wrapper (every call guarded)
|   |-- orderStream.js         Interactive socket: pushed order/trade updates
|   |-- orderGuard.js          Per-client order spacing and per-minute breaker
|   |-- paperBroker.js         Simulated broker for PAPER mode
|   |-- Marketsocket.js        Market Data login, tick socket, recovery, subscriptions
|   |-- instrumentloader.js    Upstox instrument download, cache, segment mapping
|   |-- index.js               Marketable limit order execution engine
|   |-- journal.js             Durable trade book and activity log (JSONL + CSV)
|   |-- tradebooks.js          Daily broker trade book snapshots per client
|   |-- margin.js              Broker balance → available / utilized margin
|   |-- strategy/              Strategy loader, runner, option chain, store
|   |-- fsutil.js              Atomic file writes
|   |-- package.json           Backend dependencies and scripts
|   |-- data/                  clients.json, settings.json, sessions.json, journal/, …
|   `-- .env                   Local configuration and credentials
|
`-- frontend/
    |-- src/
    |   |-- App.jsx            Main trading dashboard
    |   |-- AuthGate.jsx       Login gate + Ctrl+Shift+Space admin shortcut
    |   |-- LoginPage.jsx      Login page (single-session warning)
    |   |-- AdminConsole.jsx   Admin console (monitor, execution & limits)
    |   |-- AdminClients.jsx   Admin client roster and API keys
    |   |-- AdminStrategies.jsx  Strategy upload, assignment, allocations
    |   |-- AdminTradeBooks.jsx  Daily broker trade books
    |   |-- AdminMargins.jsx   Client margins
    |   |-- StrategyPanel.jsx  User's Automated Strategies panel
    |   |-- JournalView.jsx    Trade book / activity log viewer
    |   |-- config.js          Backend REST / WebSocket URLs
    |   |-- download.js        CSV helpers
    |   |-- authFetch.js       Authenticated fetch wrapper
    |   `-- main.jsx           React entry point
    `-- package.json           Frontend dependencies and scripts
```

## Prerequisites

- Node.js 18 or later.
- npm.
- Valid XTS 5paisa Interactive API credentials.
- Valid XTS 5paisa Market Data API credentials for the parent account.
- Internet access from the backend to `assets.upstox.com` for the instrument master.

## Installation

Install backend dependencies:

```bash
cd backend
npm install
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

## Backend Configuration

Create or update `backend/.env` with the following values:

```env
# Dashboard users (APP_USER1_*, APP_USER2_*, … up to 20)
APP_USER1_NAME=trader1
APP_USER1_PASSWORD=change-this-password
AUTH_SECRET=replace-with-a-long-random-secret

# Admin console (Ctrl+Shift+Space). Use a different, strong password.
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-admin-password

# Browser origins allowed to call the API (comma-separated).
# Unset = localhost and private-LAN addresses only.
CORS_ORIGINS=http://localhost:5173

XTS_INTERACTIVE_URL=https://xtsmum.5paisa.com
XTS_MARKET_URL=https://xtsmum.5paisa.com
XTS_SOURCE=WEBAPI
MARKET_SOURCE=WEBAPI

MARKET_APP_KEY=your-market-data-app-key
MARKET_SECRET_KEY=your-market-data-secret-key

CLI1_ID=your-parent-client-id
CLI1_NAME=Parent Client
CLI1_INTERACTIVE_KEY=your-interactive-app-key
CLI1_INTERACTIVE_SECRET=your-interactive-secret-key

# Optional — this is the default
INSTRUMENT_URL=https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz

PORT=5000
AUTO_LOGIN_ON_START=false

# Optional tuning
# ORDER_MIN_GAP_MS=110            overrides Admin → Execution & Limits → order gap
# ORDER_POLL_GAP_MS=100
# MARKET_RELOGIN_BASE_MS=2000     first wait before a market-data re-login
# MARKET_TAKEOVER_BACKOFF_MS=30000  wait after repeated session takeovers
# XTS_DATA_DIR=./data
```

The `CLI1_*` and `MARKET_*` values are used only for first-run bootstrap when `backend/data/clients.json` does not exist. After that, manage clients from the Admin console.

`INSTRUMENT_FILE` is no longer used: the backend downloads the instrument master from `INSTRUMENT_URL` on every start and when **Refresh Instruments** is pressed. The last good download is kept in `backend/data/instruments-cache.json.gz` and is used only if Upstox cannot be reached at startup.

Everything runs on one port (`PORT`, default 5000): the dashboard, the REST API, and the quote WebSocket at `/ws`. `WS_PORT` is no longer used. To put the backend somewhere else, create `frontend/.env` with `VITE_API_URL=…` and `VITE_WS_URL=…` before building.

## Running the Application

### One click (Windows)

Double-click `start.bat` in the project folder. It installs missing packages, builds the dashboard, prints the addresses to open, and starts the server:

```text
http://<this PC's IP>:5000      e.g. http://192.168.1.9:5000
```

Other machines on the network open that address. If they cannot connect, allow inbound TCP 5000 in Windows Firewall (the script prints the exact command). `start.bat --check` does everything except start the server.

### Manually

```bash
cd frontend
npm run build
```

```bash
cd backend
npm start
```

Then open `http://<this PC's IP>:5000`. The built `index.html` is served with `no-cache`, so a rebuild shows up on the next page load.

### Frontend development

```bash
cd frontend
npm run dev
```

Vite serves on `http://localhost:5173` and talks to the backend on port 5000.

## Dashboard Login

The dashboard login is separate from the broker API login.

- Dashboard login uses `APP_USER{n}_NAME` / `APP_USER{n}_PASSWORD` (legacy `APP_USERNAME` / `APP_PASSWORD` still work).
- The admin console uses `ADMIN_USERNAME` / `ADMIN_PASSWORD` and its own 2-hour token. A dashboard token cannot open admin routes, and an admin token cannot trade.
- Broker login happens per client from the dashboard using the configured XTS credentials.
- Authenticated dashboard sessions are signed with `AUTH_SECRET`.
- If `AUTH_SECRET` is not set, the backend creates a temporary secret and all users must log in again after every restart.
- **One login per user.** If the user is already logged in somewhere else, the login page warns and offers **Log out the other session**. That ends the other session (its tab is signed out with a message) and the user then logs in fresh. Sessions are kept in `data/sessions.json`, so they survive a restart. The admin sees every logged-in user under Monitor and can end any session.

## Admin Console

Press **Ctrl+Shift+Space** anywhere in the app (login screen or dashboard) and log in with the admin credentials.

- **Monitor**: PAPER/LIVE and halt state, market-data feed health (ticks per minute, last tick, re-logins, session takeover warning), instruments, server uptime, every client's status, logged-in dashboard users (with **End session**), client margins, execute-to-fill latency, recent executions and the admin audit trail. Buttons to restart the market feed, refresh instruments, and disconnect or log out all clients.
- **Clients**: add, edit and delete parent and child clients, set Interactive and Market Data API keys (only ever shown masked), multiplier and capital, assign a client to a dashboard login, and log in / connect / enable any client.
- **Strategies**: upload, assign, allocate capital, control (see below).
- **Trade Books**: each client's broker trade book saved per day, with CSV.
- **Execution & Limits**:
  - **PAPER / LIVE** for the whole system (switching to LIVE asks for confirmation). In PAPER, the dashboard's Execute button and every strategy are simulated on the live feed; strategy assignments set to LIVE run as PAPER.
  - **Segments allowed for trading** and the product type per segment (NRML / MIS / CNC; equity defaults to CNC). Disallowed segments disappear from the dashboard and are refused by the server and the strategy runner.
  - **Lot sizing per client**: by each client's multiplier, or by capital (client capital ÷ base capital, e.g. base ₹1 Cr: ₹2 Cr → 2x, ₹1.5 Cr → 1.5x). Fractions round down by default (never more than the ratio), or to the nearest lot. A client whose size rounds to 0 lots is skipped and logged.
  - The trading kill switch, engine parameters (price buffer, fill timeout, retries, poll interval, cancel wait, order gap) and risk limits (max legs, lots per leg, quantity per order, order value, clients per execution, orders per minute). Limits are checked on the server before any order reaches the broker.

A new install starts in **PAPER** with **trading halted**. LIVE orders need both: mode set to LIVE and trading resumed.

## Automated Strategies

### Admin: upload and assign

Admin console → **Strategies**:

1. **Upload strategy files** — one or many `bt-strategy-config` v1 exports. Settings the live runner cannot reproduce (target, ORB, delta exit, IV filters, GIFT filters, preset strikes, fixed exit times other than `intraday_at`) are refused with the reason, so a strategy never trades differently from its backtest without anyone noticing. Costs/slippage are backtest-only and ignored.
2. **Assign** a strategy to a dashboard user: mode (**PAPER** by default, or LIVE), capital (₹ at 1x — what the daily loss % is measured against), and optionally which of that user's clients it trades (default: all of them). Several users can run the same strategy, and the same client can trade under several users' strategies — each assignment keeps its own positions.
3. **Allocations** (optional, per assignment): the capital each client gives this strategy. That client's lots = strategy lots × allocation ÷ the strategy capital (e.g. strategy capital ₹1 Cr, allocation ₹50 L → half the lots, rounded per the sizing rule). Blank = the client's normal sizing; 0 = the client sits this strategy out. A summary table shows each client's total allocation against its capital and flags over-allocation.
4. Watch and control every assignment (start, stop, square off, resume, enable/disable) and read everyone's trade book and activity log.

### User: start

Dashboard → **Automated Strategies** → **Start**. The strategy then runs inside the backend — the browser can be closed:

- **Entry days** come from `entry_days.dte`, counted in trading days to the chosen expiry (`current_week`, `next_week` or `monthly`) from the instrument master. A 0-DTE strategy started the day before expiry shows "Armed — next entry day …" and fires on expiry day.
- **Entries** fire once per schedule slot (IST). Slots that passed while the strategy was not running (late start, restart, downtime) are skipped, never fired late. Each leg group (`legs` and each `structures[]` entry) has its own schedule; the main symbol and every `extra_symbols` entry (e.g. NIFTY + SENSEX) trade on their own expiry days.
- **Strikes** by delta (Black-76 on the forward implied by put-call parity, using live quotes), ATM offset, or premium. `nearest_ge` picks the furthest strike whose |delta| is still ≥ the target. If no strike fits (none on that side of the target, or none within `tolerance`), the strike whose delta is nearest the target is taken instead, and the activity log says so ("took the nearest strike …"). The premium rule works the same way.
- **Quantity** = leg lots × `lots_per_entry` × lot size × the client's factor (its allocation ratio if set, otherwise the global sizing: multiplier or capital), rounded to whole lots.
- **Stops**: `per_leg` multiplier — a short leg is bought back when its LTP reaches entry × multiplier.
- **Daily loss**: when a client's P&L for the day reaches −(capital × multiplier × max_loss_pct), that client's positions are squared off and it takes no more entries that day.
- **Exit**: held to expiry and settled at the last traded price at 15:30 IST, or squared off at `exit.intraday_at`.
- **Stop** = no new entries, open positions stay protected by their stops. **Square off** closes everything now.
- **PAPER** goes through the same marketable-limit engine (buffer, timeout, cancel, retry) against a simulated broker that fills at the live bid/ask, sends nothing to the broker, and gives every simulated order a `PAPER-YYYYMMDD-XXXXXX` ID. **LIVE** uses the real broker and is blocked while trading is halted or the global mode is PAPER (exits still run). An order needing a manual check pauses the strategy.

Each client card has **Algo Pos** (that client's PAPER strategy positions with entry/exit order IDs, LTP, stop and P&L) and **Algo Orders** (every PAPER strategy order today, by PAPER order ID). LIVE strategy trades are real broker orders, so they appear only in the card's Orders / Trades / Positions views (the broker's own books); the Automated Strategies panel still lists every position of a strategy, PAPER or LIVE.

### Durability

- Strategy state is saved atomically after every change (`backend/data/strategy-runs/`); on restart the backend resumes every running strategy and re-subscribes its open positions.
- Every fill (manual and strategy) and every strategy decision is appended to `backend/data/journal/trades-YYYY-MM-DD.jsonl` / `events-YYYY-MM-DD.jsonl` and flushed to disk before continuing. Download any day as CSV from the dashboard (own records) or the admin console (everyone).
- The dashboard's **Global Market Log** is saved too: each line goes into a browser outbox (kept in `localStorage`) and is sent to the server every second, so lines written while the network or server is down are delivered when it comes back. After a refresh, today's saved lines reload into the panel. The **CSV** button on the log downloads today's activity.
- `AUTO_LOGIN_ON_START=true` logs every enabled client in to the broker and connects it when the backend starts, so LIVE strategies keep trading after an unattended restart.

### Order safety

Every broker request passes a per-client guard: orders for one client go out one at a time at least 110 ms apart (Admin → Execution & Limits → order gap, or `ORDER_MIN_GAP_MS`; the broker allows 10 orders/s), different clients in parallel, status polls at least 100 ms apart (`ORDER_POLL_GAP_MS`), and more than **Max orders per minute, per client** (Admin → Execution & Limits, default 60) is refused before reaching the broker and pauses every strategy using that client.

## Parent and Child Client Setup

Open the Admin console → Clients.

Parent client requirements:

- Client ID.
- Client name.
- Root URL.
- Interactive API key and secret.
- Market Data API key and secret.
- Only one parent client is allowed.

Child client requirements:

- Client ID.
- Client name.
- Interactive API key and secret.
- Multiplier.
- Market Data API credentials are not required.

The parent provides market data access. The parent and every child can participate in trading when enabled, logged in, and connected.

## Market Data Flow

1. The backend downloads the instrument master from Upstox (`INSTRUMENT_URL`).
2. The backend logs in to XTS Market Data using the parent client's market credentials.
3. The backend connects to the XTS market data socket (`publishFormat: JSON`, `broadcastMode: Full`) and receives every touchline/depth tick as it happens — no polling.
4. Each leg subscribes its own token through `POST /api/subscribe`; changing or removing a leg unsubscribes the old token (`POST /api/unsubscribe`). Tokens are reference-counted per owner (each dashboard and each strategy), so a token another leg or strategy still needs stays subscribed, and a removed token's price is cleared at once.
5. The backend pushes bid, ask, and LTP to the dashboard over `/ws` (dashboard token required). The browser applies updates once per animation frame, and re-subscribes every leg whenever the socket reconnects (500 ms first retry).
6. **Recovery**: if XTS ends the market session (server disconnect, logout, `Invalid Token`), the backend logs in again, reconnects, and re-subscribes every token automatically. Three or more forced re-logins in 5 minutes usually means another program is logged in with the same Market Data key; the monitor shows "Session taken over" and the backend waits 30 s between attempts instead of fighting it. Close the other program to fix it.

## Order Flow

1. Select one to eight portfolio legs in the dashboard (an admin can lower the maximum).
2. Select segment, symbol, type, expiry, strike, side, and lots.
3. Log in and connect the required clients.
4. Press Execute (the button says **EXECUTE (PAPER)** or **EXECUTE LIVE**). It is refused if an admin has halted trading, a segment is not allowed, a risk limit is exceeded, or your previous execution is still running.
5. The backend sends each leg to every active client.
6. Each client's lots = leg lots × its sizing factor (multiplier or capital ratio), in whole lots.
7. The execution engine places marketable limit orders priced to the instrument's own tick size, waits for the fill pushed over the Interactive order socket (falling back to polling the order history), cancels unfilled remainders, waits for the cancel to be confirmed, and retries only the quantity that is genuinely unfilled. PAPER runs the same steps against the simulated broker.
8. If an order's placement times out, or a cancel is not confirmed, the result is **MANUAL_CHECK** and nothing is retried automatically. Check the broker's order book.
9. Every result records latency: queue (waiting for the order gap), ack (send → order ID), fill (order ID → filled) and total.

The active client rule is:

```js
// LIVE
client.enabled && client.isLogged && client.isConnected
// PAPER — no broker login needed
client.enabled
```

## Tests

All tests live in `tests/` at the project root, run against a fake broker, and never contact 5paisa or Upstox:

```bash
cd backend
npm test
```

```bash
cd frontend
npm test
```

The strategy tests use a fake clock and a synthetic option chain; `placeOrder` in every test is a fake that records or refuses calls. Test output is quiet; set `TEST_VERBOSE=1` to see the code's logs.

## API Documentation

See [XTS_API_REFERENCE.md](./XTS_API_REFERENCE.md) for backend routes, request examples, client object rules, market data subscriptions, and deployment notes.

## Production Notes

- Use strong dashboard and admin passwords, and a permanent `AUTH_SECRET`.
- Set `CORS_ORIGINS` to the dashboard's public origin.
- Keep `backend/.env` and `backend/data/` out of source control.
- The backend serves the built dashboard itself (`frontend/dist`, or `FRONTEND_DIST`). If the dashboard is served from elsewhere, set `VITE_API_URL` and `VITE_WS_URL` in `frontend/.env` before building.
- Use HTTPS and WSS behind a reverse proxy for internet-facing deployments (proxy `/ws` as a WebSocket).
- Use only one running copy per Market Data key — a second copy (or another app on the same key) keeps kicking this one's market session.

## References

- Symphony Fintech on GitHub: https://github.com/symphonyfintech
- XTS Interactive API for Node.js: https://www.npmjs.com/package/xts-interactive-api
- Symphony Fintech XTS Java Client SDK: https://github.com/symphonyfintech/xts-javaclient-api-sdk
- XTS Market Data API documentation: https://symphonyfintech.com/xts-market-data-front-end-api/
- XTS Trading API documentation: https://symphonyfintech.com/xts-trading-front-end-api/
