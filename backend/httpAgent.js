const https = require("https");

// ─────────────────────────────────────────────────────────────
// Shared HTTPS agent — exported BOTH ways so either import style works:
//   const { ipv4Agent } = require("./httpAgent");   ← named
//   const agent = require("./httpAgent");            ← default
//
// family:4    → always IPv4, preventing IPv4↔IPv6 switch between calls
// keepAlive   → reuses the same TCP connection (keeps same source IP)
// NO maxSockets limit — setting maxSockets:1 starves the connection
//   pool: when the market data socket.io holds the single allowed socket,
//   every other HTTP call (client login, positions, orders) queues and
//   times out. Remove the limit; keepAlive already gives us IP stability.
// ─────────────────────────────────────────────────────────────
const ipv4Agent = new https.Agent({
  family:    4,
  keepAlive: true,
});

module.exports = ipv4Agent;        // default export  → require("./httpAgent")
module.exports.ipv4Agent = ipv4Agent;  // named export → { ipv4Agent }
