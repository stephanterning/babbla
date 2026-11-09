// Quick HTTPS tunnel for testing on real devices (iOS, phones, etc.).
// Requires cloudflared (provisioned in cloud VM via .cursor/environment.json).
//
// Usage: npm start (one terminal), npm run tunnel (another).
// Override target port with BABBLA_TUNNEL_PORT or PORT (default 8080).

import { spawn, execSync } from "node:child_process";

const PORT = Number(process.env.BABBLA_TUNNEL_PORT || process.env.PORT) || 8080;
const TARGET = `http://localhost:${PORT}`;

function hasCloudflared() {
  try {
    execSync("command -v cloudflared", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasCloudflared()) {
  console.error(
    "cloudflared not found. On Ubuntu/Debian: add the Cloudflare apt repo and",
    "install cloudflared, or re-run the Cursor environment install step."
  );
  process.exit(1);
}

console.error(`Starting cloudflared quick tunnel → ${TARGET}`);
console.error(
  "Copy the https://*.trycloudflare.com URL for real-device testing."
);
console.error("(URL changes each restart; no Cloudflare account needed.)");

const child = spawn(
  "cloudflared",
  ["tunnel", "--url", TARGET, "--no-autoupdate"],
  { stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
