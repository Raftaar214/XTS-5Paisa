# XTS 5paisa Multi-Client Trading Dashboard

This project is a Node.js and React trading dashboard for the XTS 5paisa API. It provides a secured web dashboard, parent and child client management, live bid and ask market data, and multi-client order execution from a single portfolio screen.

The structure follows the same professional documentation pattern used by the Symphony Fintech XTS SDK: installation, configuration, usage, market data, order flow, examples, and deployment notes.

## Features

- Dashboard login using a local username and password.
- Parent and child client management from the web interface.
- One parent client with Interactive API and Market Data API credentials.
- Multiple child clients with Interactive API credentials and individual quantity multipliers.
- Live bid and ask updates through the XTS market data socket and local WebSocket relay.
- Instrument upload and server-side instrument loading.
- Multi-leg portfolio execution across all enabled, logged-in, and connected clients.
- Marketable limit order execution with retry, timeout, partial-fill, cancel, and order-history handling.
- Order book, trade book, and position views per client.

## Project Structure

```text
XTS 5paisa/
|-- backend/
|   |-- server.js              Express REST API and WebSocket relay
|   |-- auth.js                Dashboard authentication
|   |-- clients.js             Parent and child client storage
|   |-- xtsApi.js              XTS Interactive API wrapper
|   |-- Marketsocket.js        XTS Market Data login, socket, and quote handling
|   |-- instrumentloader.js    Instrument master loading and segment mapping
|   |-- index.js               Marketable limit order execution engine
|   |-- quotePacket.js         Binary quote packet helper
|   |-- httpAgent.js           HTTPS agent configuration
|   |-- package.json           Backend dependencies and scripts
|   `-- .env                   Local configuration and credentials
|
`-- frontend/
    |-- src/
    |   |-- App.jsx            Main trading dashboard
    |   |-- AuthGate.jsx       Login gate
    |   |-- LoginPage.jsx      Login page
    |   |-- UserManagement.jsx Client management panel
    |   |-- authFetch.js       Authenticated fetch wrapper
    |   `-- main.jsx           React entry point
    `-- package.json           Frontend dependencies and scripts
```

## Prerequisites

- Node.js 18 or later.
- npm.
- Valid XTS 5paisa Interactive API credentials.
- Valid XTS 5paisa Market Data API credentials for the parent account.
- A local instrument master file, for example `completedata.json`.

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
APP_USERNAME=admin
APP_PASSWORD=change-this-password
AUTH_SECRET=replace-with-a-long-random-secret

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

INSTRUMENT_FILE=C:/Users/HP/Downloads/completedata.json

PORT=5000
WS_PORT=3002
AUTO_LOGIN_ON_START=false
```

The `CLI1_*` and `MARKET_*` values are used only for first-run bootstrap when `backend/data/clients.json` does not exist. After the client file is created, manage users from the dashboard's User Management panel.

## Running the Application

Start the backend:

```bash
cd backend
npm start
```

The backend starts:

- REST API on `http://localhost:5000`.
- Local quote WebSocket on `ws://localhost:3002`.

Start the frontend in a separate terminal:

```bash
cd frontend
npm run dev
```

Open the Vite URL, usually:

```text
http://localhost:5173
```

## Dashboard Login

The dashboard login is separate from the broker API login.

- Dashboard login uses `APP_USERNAME` and `APP_PASSWORD`.
- Broker login happens per client from the dashboard using the configured XTS credentials.
- Authenticated dashboard sessions are signed with `AUTH_SECRET`.
- If `AUTH_SECRET` is not set, the backend creates a temporary secret and all users must log in again after every restart.

## Parent and Child Client Setup

Open User Management from the dashboard.

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

1. The backend loads instruments from `INSTRUMENT_FILE`.
2. The backend logs in to XTS Market Data using the parent client's market credentials.
3. The backend connects to the XTS market data socket.
4. The frontend subscribes to selected instrument tokens through `POST /api/subscribe`.
5. The backend tracks subscribed tokens and publishes bid, ask, and LTP updates to the frontend WebSocket.

## Order Flow

1. Select one to four portfolio legs in the dashboard.
2. Select segment, symbol, type, expiry, strike, side, and lots.
3. Log in and connect the required clients.
4. Press Execute.
5. The backend sends each leg to every active client.
6. Child quantities are multiplied by the configured child multiplier.
7. The execution engine places marketable limit orders, checks order history, cancels unfilled remainders, and retries as configured.

The active client rule is:

```js
client.enabled && client.isLogged && client.isConnected
```

## API Documentation

See [XTS_API_REFERENCE.md](./XTS_API_REFERENCE.md) for backend routes, request examples, client object rules, market data subscriptions, and deployment notes.

## Production Notes

- Change `APP_PASSWORD` before deployment.
- Set a permanent `AUTH_SECRET`.
- Keep `backend/.env` and `backend/data/clients.json` out of source control.
- Update frontend API constants before deploying to a remote server:
  - `frontend/src/App.jsx`: `API` and `WS`.
  - `frontend/src/UserManagement.jsx`: `API`.
  - `frontend/src/authFetch.js`: `API_BASE`.
- Use HTTPS and WSS behind a reverse proxy for internet-facing deployments.
- Build the frontend with `npm run build` and serve the generated `dist` folder in production.

## References

- Symphony Fintech XTS Java Client SDK: https://github.com/symphonyfintech/xts-javaclient-api-sdk
- XTS Market Data API documentation: https://symphonyfintech.com/xts-market-data-front-end-api/
- XTS Trading API documentation: https://symphonyfintech.com/xts-trading-front-end-api-v2/
