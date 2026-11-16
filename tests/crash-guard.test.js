// crash-guard.test.js — a stray promise error must not stop the server; a
// truly unexpected error exits (so start.bat / start.sh restart it).
// Each case runs in its own child process that loads server.js WITHOUT
// starting it: no network, no broker, no orders.
//
// Run:  node --test tests/crash-guard.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function runChild(body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-crash-"));
  // A fake client file, so nothing is bootstrapped from the real backend/.env.
  fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify([{ id: "T1", name: "Test", role: "PARENT", multiplier: 1,
    rootUrl: "https://example.invalid", source: "WEBAPI", assignedTo: "", interactiveKey: "fake-key-1", interactiveSecret: "fake-secret-1",
    marketKey: "", marketSecret: "", enabled: true }]));
  const script = `
    process.env.XTS_DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.AUTH_SECRET = "test-only";
    const srv = require(${JSON.stringify(path.join(BACKEND, "server.js"))});
    srv.installCrashGuard();
    ${body}
  `;
  try {
    return spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20000, cwd: BACKEND });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test("an unhandled promise error is logged and the process keeps running", () => {
  const r = runChild(`
    Promise.reject(new Error("stray async error"));
    setTimeout(() => { console.log("STILL-RUNNING"); process.exit(0); }, 300);
  `);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /STILL-RUNNING/);
  assert.match(r.stderr, /unhandled error \(server keeps running\)/);
});

test("an unexpected error exits with code 1 so the start script restarts the server", () => {
  const r = runChild(`setTimeout(() => { throw new Error("boom"); }, 50);`);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /the server will restart/);
});
