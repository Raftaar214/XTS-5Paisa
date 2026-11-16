// config.js — where the backend lives. One place for every file to use.
//
// Production (the backend serves this dashboard, e.g. http://19.167.80.19:5000):
//   REST       -> the same address the page was opened from
//   WebSocket  -> ws(s)://<same address>/ws
// Development (Vite dev server on :5173):
//   REST       -> <same host>:5000,  WebSocket -> ws://<same host>:5000/ws
//
// Override at build time (e.g. behind a reverse proxy) in frontend/.env:
//   VITE_API_URL=https://desk.example.com
//   VITE_WS_URL=wss://desk.example.com/ws

const loc = typeof window !== "undefined"
  ? window.location
  : { protocol: "http:", hostname: "localhost", host: "localhost:5000", origin: "http://localhost:5000" };
const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
const DEV = import.meta.env.DEV;

const defaultApi = DEV ? `${loc.protocol}//${loc.hostname}:5000` : loc.origin;
const defaultWs  = DEV ? `${wsProtocol}//${loc.hostname}:5000/ws` : `${wsProtocol}//${loc.host}/ws`;

export const API_BASE = (import.meta.env.VITE_API_URL || defaultApi).replace(/\/+$/, "");
export const WS_URL   = (import.meta.env.VITE_WS_URL  || defaultWs).replace(/\/+$/, "");
