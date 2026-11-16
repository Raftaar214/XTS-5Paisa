// scripts/show-urls.js — print the addresses to open the dashboard at,
// using this machine's network IPs and PORT from backend/.env.
// Used by start.bat. Reads files only; changes nothing.

const fs = require("fs");
const os = require("os");
const path = require("path");

const envFile = path.join(__dirname, "..", "backend", ".env");
const env = {};
try {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (_) { /* start.bat already checked the file exists */ }

const port = env.PORT || "5000";
const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter(i => i && i.family === "IPv4" && !i.internal)
  .map(i => i.address);

console.log("");
console.log("  XTS Trading Desk");
console.log("");
console.log("  Open the dashboard from any computer on the network:");
if (ips.length) ips.forEach(ip => console.log(`     http://${ip}:${port}`));
else console.log("     (no network address found — check the network connection)");
console.log(`  On this computer:  http://localhost:${port}`);
console.log("  Admin console:     press Ctrl+Shift+Space on the dashboard");
console.log("");
console.log("  Cloud server (AWS / Oracle): the public IP is not on this machine's");
console.log(`  network card — use http://<public-ip>:${port} and allow TCP ${port}`);
console.log("  in the instance's security group / security list.");
if (process.platform === "win32") {
  console.log("  Other computers can't connect? Allow the port in Windows Firewall");
  console.log("  (run in an Administrator prompt, once):");
  console.log(`     netsh advfirewall firewall add rule name="XTS Trading Desk" dir=in action=allow protocol=TCP localport=${port}`);
} else {
  console.log("  Other computers can't connect? Open the port in the server firewall, e.g.");
  console.log(`     sudo ufw allow ${port}/tcp        (Ubuntu)`);
  console.log(`     sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload   (Oracle Linux)`);
}
if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
  console.log("");
  console.log("  NOTE: ADMIN_USERNAME / ADMIN_PASSWORD are not set in backend/.env —");
  console.log("        the Admin console stays disabled until you add them.");
}
if (!env.AUTH_SECRET) {
  console.log("  NOTE: AUTH_SECRET is not set — everyone must log in again after each restart.");
}
console.log("");
console.log("");
