import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";

async function start(t, mode = "success") {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const patch = `globalThis.fetch = async () => {
    await new Promise(r => setTimeout(r, 100));
    ${mode === "failure" ? 'throw new Error("private-api-token");' : 'return {ok:true,json:async()=>({iceServers:[{urls:["turn:turn.cloudflare.com:3478?transport=udp"],username:"ephemeral-user",credential:"ephemeral-pass"}]})};'}
  };`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(patch)}`, "server.js"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), TURN_PROVIDER: "cloudflare", CLOUDFLARE_TURN_KEY_ID: "key",
      CLOUDFLARE_TURN_API_TOKEN: "private-api-token", TURN_SECRET: "private-native-secret", TURN_URLS: "turn:native.example:3478" },
  });
  let output = "";
  child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
  t.after(async () => { child.kill(); await once(child, "exit"); assert.doesNotMatch(output, /private-api-token|private-native-secret/); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test server startup timed out")), 5000);
    child.stdout.on("data", () => { if (output.includes("listening")) { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("test server exited")); });
  });
  return async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=turn-test`);
    const messages = [];
    ws.on("message", data => messages.push(JSON.parse(data.toString())));
    await once(ws, "open"); t.after(() => ws.terminate());
    return { ws, messages, send: msg => ws.send(JSON.stringify(msg)) };
  };
}
async function waitFor(fn) {
  const deadline = Date.now() + 3000;
  while (!fn()) { if (Date.now() > deadline) throw new Error("message timeout"); await new Promise(r => setTimeout(r, 10)); }
  return fn();
}

test("WebSocket welcome and refresh carry Cloudflare ephemeral credentials", async t => {
  const connect = await start(t); const a = await connect();
  a.send({ type: "join", name: "A" }); a.send({ type: "join", name: "duplicate" });
  const welcome = await waitFor(() => a.messages.find(m => m.type === "welcome"));
  assert.equal(welcome.iceServers[0].urls[0], "turn:turn.cloudflare.com:3478?transport=udp");
  assert.doesNotMatch(JSON.stringify(welcome), /private-api-token|private-native-secret|native.example/);
  a.send({ type: "ice-refresh" });
  const refresh = await waitFor(() => a.messages.find(m => m.type === "ice-refresh"));
  assert.deepEqual(refresh.iceServers, welcome.iceServers);
  assert.equal(a.messages.filter(m => m.type === "welcome").length, 1);
});

test("leaving during credential fetch cannot resurrect a peer or strand a room", async t => {
  const connect = await start(t); const a = await connect();
  a.send({ type: "join", name: "gone" }); a.send({ type: "leave" });
  await once(a.ws, "close");
  const b = await connect(); b.send({ type: "join", name: "B" });
  const welcome = await waitFor(() => b.messages.find(m => m.type === "welcome"));
  assert.deepEqual(welcome.peers, []);
  const c = await connect(); c.send({ type: "join", name: "C" });
  const second = await waitFor(() => c.messages.find(m => m.type === "welcome"));
  assert.deepEqual(second.peers.map(p => p.name), ["B"]);
});

test("API failure still welcomes with native credentials and retry cadence", async t => {
  const connect = await start(t, "failure"); const a = await connect(); a.send({ type: "join", name: "A" });
  const welcome = await waitFor(() => a.messages.find(m => m.type === "welcome"));
  assert.equal(welcome.iceServers[0].urls[0], "turn:native.example:3478");
  assert.equal(welcome.iceRefreshMs, 30000);
});
