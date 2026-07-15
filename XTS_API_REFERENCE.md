# XTS 5paisa API Reference

This document describes the local backend API used by the XTS 5paisa Multi-Client Trading Dashboard. It is intended for developers and operators who need to configure, test, deploy, or extend the application.

## Base URLs

Local development:

```text
REST API:  http://localhost:5000
WebSocket: ws://localhost:3002
```

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

All other `/api/*` routes require the dashboard bearer token.

## Instruments

### Get Loaded Instruments

```http
GET /api/instruments
Authorization: Bearer signed-dashboard-token
```

Returns the currently loaded instrument master data.

### Upload Instruments

```http
POST /api/instruments
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Request can be a JSON array or an object containing instrument records.

Response:

```json
{
  "success": true,
  "count": 1000
}
```

## Client Management

Clients are stored in `backend/data/clients.json`. Runtime state such as login status, connection status, token, and user ID is kept in memory.

### List Dashboard Clients

```http
GET /api/clients
Authorization: Bearer signed-dashboard-token
```

Returns a safe dashboard snapshot:

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

### List Full Client Management View

```http
GET /api/clients/full
Authorization: Bearer signed-dashboard-token
```

Secrets are masked and are not returned in plain text.

### Add Client

```http
POST /api/clients
Authorization: Bearer signed-dashboard-token
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

### Update Client

```http
PUT /api/clients/:id
Authorization: Bearer signed-dashboard-token
Content-Type: application/json
```

Only supplied fields are updated.

### Delete Client

```http
DELETE /api/clients/:id
Authorization: Bearer signed-dashboard-token
```

If the client is logged in, the backend logs it out before removing it.

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

### Enable or Disable Trading

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

The backend converts dashboard segment names to XTS segment codes and subscribes through the XTS Market Data API.

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

Connect to:

```text
ws://localhost:3002
```

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
- Active client means enabled, logged in, and connected.
- Parent multiplier is always 1.
- Child order quantity is multiplied by the child multiplier.
- NSE and BSE F&O quantity is `lots * lot_size * multiplier`.
- MCX quantity is `lots * multiplier`.
- Orders are sent as XTS limit orders using a marketable limit price.
- The engine checks order history and can cancel and retry unfilled quantity.

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
    "status": "FILLED",
    "success": true
  }
]
```

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
NSE_FO -> NSEFO
BSE_FO -> BSEFO
MCX    -> MCXFO
```

Common XTS market data segment codes:

```text
NSECM: 1
NSEFO: 2
BSECM: 11
BSEFO: 12
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
async function addParentClient(token) {
  return apiRequest("/api/clients", {
    method: "POST",
    token,
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
async function addChildClient(token) {
  return apiRequest("/api/clients", {
    method: "POST",
    token,
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
function listenToQuotes(onQuote) {
  const socket = new WebSocket("ws://localhost:3002");

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

const quoteSocket = listenToQuotes((quotes) => {
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
  const token = await loginDashboard("admin", "change-this-password");

  await verifyDashboardToken(token);
  await loginAndConnectClient(token, "55583335");

  await subscribeMarketData(token, [
    { exchangeSegment: "NSE_FO", exchangeInstrumentID: 12345 },
  ]);

  const socket = listenToQuotes((quotes) => {
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

  return executeOrderMulti(legs, activeClients);
}
```

## Deployment Checklist

- Set a strong `APP_PASSWORD`.
- Set a permanent `AUTH_SECRET`.
- Confirm `INSTRUMENT_FILE` points to a valid instrument master file.
- Keep `.env` and `data/clients.json` private.
- Update frontend API constants for the production host.
- Use HTTPS for REST and WSS for WebSocket traffic in production.
- Confirm firewall rules allow the backend REST port and WebSocket port only as intended.
- Run frontend production build with `npm run build`.
- Serve the frontend `dist` folder through a production web server.

## Troubleshooting

### Dashboard login fails

Check `APP_USERNAME`, `APP_PASSWORD`, and `AUTH_SECRET` in `backend/.env`.

### Broker login fails

Confirm the client Interactive API key, secret, source, and root URL.

### Quotes do not update

Confirm the parent has Market Data API credentials and that the selected token has been subscribed. Check that the backend market data socket is connected.

### Order execution returns no active clients

At least one client must be enabled, logged in, and connected before execution.

### Frontend cannot reach backend

Confirm `API`, `WS`, and `API_BASE` are using the correct host and port.
