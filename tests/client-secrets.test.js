// client-secrets.test.js — API keys encrypted at rest with DATA_KEY.
// Uses a temporary data folder; never touches real keys or the network.
//
// Run:  node --test tests/client-secrets.test.js

// Quiet by default: heavy console output can corrupt node --test reporting. TEST_VERBOSE=1 to see logs.
if (!process.env.TEST_VERBOSE) { console.log = console.info = console.warn = console.error = () => {}; }
const BACKEND = require("path").join(__dirname, "..", "backend");

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xts-secrets-"));
process.env.XTS_DATA_DIR = dataDir;
const FILE = path.join(dataDir, "clients.json");
const PLAIN = [{ id: "P1", name: "Parent", role: "PARENT", multiplier: 1, rootUrl: "https://example.invalid", source: "WEBAPI",
  assignedTo: "", interactiveKey: "int-key-123456", interactiveSecret: "int-secret-abcdef", marketKey: "md-key-777", marketSecret: "md-secret-888", enabled: true }];

function loadClients(key) {
  if (key === undefined) delete process.env.DATA_KEY; else process.env.DATA_KEY = key;
  delete require.cache[require.resolve(BACKEND + "/clients")];
  return require(BACKEND + "/clients");
}

test("with DATA_KEY set, plain keys are encrypted on disk at once and still work in memory", () => {
  fs.writeFileSync(FILE, JSON.stringify(PLAIN));
  const m = loadClients("a-long-test-data-key");
  const disk = fs.readFileSync(FILE, "utf8");
  for (const v of ["int-key-123456", "int-secret-abcdef", "md-key-777", "md-secret-888"]) assert.ok(!disk.includes(v), `${v} not on disk`);
  assert.ok(disk.includes("enc:v1:"));
  assert.strictEqual(m.clients[0].interactiveSecret, "int-secret-abcdef");
  assert.strictEqual(m.clients[0].marketSecret, "md-secret-888");
});

test("restarting with the same DATA_KEY reads the encrypted keys back", () => {
  const m = loadClients("a-long-test-data-key");
  assert.strictEqual(m.clients[0].interactiveKey, "int-key-123456");
  assert.strictEqual(m.secretsLocked(), false);
});

test("a missing or wrong DATA_KEY never overwrites the file: keys load blank, saving is refused", () => {
  const before = fs.readFileSync(FILE, "utf8");
  for (const key of [undefined, "a-different-key"]) {
    const m = loadClients(key);
    assert.strictEqual(m.secretsLocked(), true);
    assert.strictEqual(m.clients[0].interactiveSecret, "");
    assert.throws(() => m.updateClient("P1", { name: "Renamed" }), /not saving/);
    assert.strictEqual(fs.readFileSync(FILE, "utf8"), before, "file unchanged");
  }
});
