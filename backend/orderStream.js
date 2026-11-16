// orderStream.js — pushed order updates from the XTS Interactive socket.
//
// Instead of finding out about a fill on the next status poll (up to the
// poll interval later), the execution engine waits on this stream: the
// broker pushes every order change over Socket.IO and the waiting leg wakes
// up immediately. Polling stays in place as the fallback.
//
// Connection (per logged-in client), as in the official xts-interactive-api SDK:
//   io(rootUrl, { path: "/interactive/socket.io",
//                 query: { token, userID, apiType: "INTERACTIVE" } })
//   events: connect, joined, error, disconnect, order, trade, position, logout
//   ("order"/"trade"/"position" payloads arrive as JSON strings)
//
// This socket only RECEIVES updates. It never places, modifies or cancels.

const EventEmitter = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(0);

const latest = new Map();   // appOrderId -> { at, data }
const sockets = new Map();  // clientId -> { socket, connected, lastEventAt }
const MAX_REMEMBERED = 5000;

function parse(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function handleOrderMessage(raw) {
  const d = parse(raw);
  const id = d?.AppOrderID;
  if (id === undefined || id === null || id === "") return;
  const key = String(id);
  latest.set(key, { at: Date.now(), data: d });
  if (latest.size > MAX_REMEMBERED) latest.delete(latest.keys().next().value);
  bus.emit(`order:${key}`, d);
}

// Resolves with the newest pushed update for this order that arrived after
// `since` (ms), or null when `timeoutMs` passes first.
function waitForOrderUpdate(appOrderId, timeoutMs, since = 0) {
  const key = String(appOrderId);
  const seen = latest.get(key);
  if (seen && seen.at > since) return Promise.resolve(seen.data);
  return new Promise(resolve => {
    const onUpdate = d => { clearTimeout(timer); resolve(d); };
    const timer = setTimeout(() => { bus.off(`order:${key}`, onUpdate); resolve(null); }, Math.max(0, timeoutMs));
    bus.once(`order:${key}`, onUpdate);
  });
}

function connect(client, rootUrl) {
  if (!client?.token || !client?.userID) return;
  disconnect(client.id);
  const io = require("socket.io-client");
  const socket = io(rootUrl, {
    path: "/interactive/socket.io",
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 2000,
    query: { token: client.token, userID: client.userID, apiType: "INTERACTIVE" },
  });
  const entry = { socket, connected: false, lastEventAt: null };
  sockets.set(client.id, entry);
  socket.on("connect",    () => { entry.connected = true;  console.log(`Order stream connected: ${client.id}`); });
  socket.on("disconnect", r  => { entry.connected = false; console.log(`Order stream disconnected: ${client.id} (${r})`); });
  socket.on("error",      e  => console.warn(`Order stream error ${client.id}:`, e?.message || e));
  socket.on("logout",     () => { entry.connected = false; });
  socket.on("order",      raw => { entry.lastEventAt = Date.now(); handleOrderMessage(raw); });
  socket.on("trade",      ()  => { entry.lastEventAt = Date.now(); });
}

function disconnect(clientId) {
  const entry = sockets.get(clientId);
  if (!entry) return;
  try { entry.socket.removeAllListeners(); entry.socket.close(); } catch (_) {}
  sockets.delete(clientId);
}

function status() {
  return Object.fromEntries([...sockets.entries()].map(([id, e]) => [id, {
    connected: e.connected, lastEventAt: e.lastEventAt ? new Date(e.lastEventAt).toISOString() : null,
  }]));
}

module.exports = { handleOrderMessage, waitForOrderUpdate, connect, disconnect, status };
