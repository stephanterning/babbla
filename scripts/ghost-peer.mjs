// Test helper: joins a room over the signaling WS but never answers WebRTC, so a
// real browser peer keeps showing the "ansluter" (connecting) tile state. Used
// only for manual GUI verification; not part of the app.
import { WebSocket } from "ws";

const room = process.argv[2] || "";
const name = process.argv[3] || "Ghost";
const query = room ? `?room=${encodeURIComponent(room)}` : "";
const ws = new WebSocket(`ws://localhost:8080/ws${query}`);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "join", name }));
  console.log(`ghost "${name}" joined room "${room || "main"}"`);
});
ws.on("message", () => {}); // ignore offers/ice → never connects
ws.on("close", () => console.log("ghost closed"));
ws.on("error", (e) => console.error("ghost error", e.message));
