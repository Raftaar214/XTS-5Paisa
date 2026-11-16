#!/usr/bin/env bash
#  XTS Trading Desk — start on a Linux / macOS server.
#
#    ./start.sh           install what is missing, build the dashboard,
#                         start the backend (dashboard + API + live quotes
#                         all on PORT from backend/.env, default 5000)
#    ./start.sh --check   do everything EXCEPT start the server
#
#  Then open  http://<server IP>:<PORT>  in a browser.
#  For a server that keeps running after you log out, see README.md
#  "Deploying on a server" (systemd).
set -euo pipefail
cd "$(dirname "$0")"

CHECK_ONLY=""
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Install Node.js 18 or later and run this again." >&2
  exit 1
fi

if [ ! -f backend/.env ]; then
  echo "[ERROR] backend/.env is missing. Copy backend/.env.example to backend/.env and fill it in." >&2
  exit 1
fi

if [ ! -d backend/node_modules ]; then
  echo "Installing backend packages..."
  (cd backend && npm ci --omit=dev 2>/dev/null || npm install --omit=dev)
fi

if [ ! -d frontend/node_modules ]; then
  echo "Installing dashboard packages..."
  (cd frontend && npm ci 2>/dev/null || npm install)
fi

echo "Building the dashboard..."
(cd frontend && npm run build --silent)

node scripts/show-urls.js

if [ -n "$CHECK_ONLY" ]; then
  echo "Check complete - packages installed and dashboard built. Server NOT started (--check)."
  exit 0
fi

echo "Starting the backend. Press Ctrl+C to stop."
cd backend
exec node server.js
