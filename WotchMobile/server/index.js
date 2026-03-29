/**
 * Wotch Bridge Server — runs on your Ubuntu VPS.
 *
 * Creates a WebSocket server that:
 *   1. Authenticates incoming connections with a shared token
 *   2. Spawns a PTY shell session (just like the desktop app does)
 *   3. Pipes terminal data bidirectionally over WebSocket
 *
 * Usage:
 *   WOTCH_TOKEN=your-secret node index.js
 *   WOTCH_TOKEN=your-secret WOTCH_PORT=3456 node index.js
 *
 * If no WOTCH_TOKEN is set, a random one is generated and printed.
 *
 * Architecture (mirrors desktop main.js PTY management):
 *   Phone ←WebSocket→ Bridge Server ←node-pty→ bash/zsh ←→ claude
 */

const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const os = require("os");
const crypto = require("crypto");

// ── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.WOTCH_PORT) || 3456;
const TOKEN = process.env.WOTCH_TOKEN || crypto.randomBytes(24).toString("hex");
const SHELL = process.env.WOTCH_SHELL || process.env.SHELL || "/bin/bash";
const MAX_CONNECTIONS = parseInt(process.env.WOTCH_MAX_CONNECTIONS) || 3;

// ── State ───────────────────────────────────────────────────────────
const sessions = new Map(); // ws → { pty, authenticated }
let connectionCount = 0;

// ── WebSocket Server ────────────────────────────────────────────────
const wss = new WebSocketServer({ port: PORT });

console.log(`\n  ╭──────────────────────────────────────────╮`);
console.log(`  │         Wotch Bridge Server v0.1.0        │`);
console.log(`  ├──────────────────────────────────────────┤`);
console.log(`  │  Port:  ${String(PORT).padEnd(33)}│`);
console.log(`  │  Shell: ${SHELL.padEnd(33)}│`);
console.log(`  │  Token: ${TOKEN.slice(0, 8)}${"*".repeat(Math.max(0, TOKEN.length - 8)).slice(0, 25).padEnd(25)}│`);
console.log(`  ╰──────────────────────────────────────────╯\n`);

if (!process.env.WOTCH_TOKEN) {
  console.log(`  ⚠  No WOTCH_TOKEN set — using generated token.`);
  console.log(`     Full token: ${TOKEN}`);
  console.log(`     Set it in your app's Server Setup screen.\n`);
}

wss.on("connection", (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[wotch] New connection from ${clientIp}`);

  if (connectionCount >= MAX_CONNECTIONS) {
    ws.send(JSON.stringify({ type: "error", payload: "Max connections reached" }));
    ws.close(1013, "Max connections");
    return;
  }

  connectionCount++;
  const session = { pty: null, authenticated: false };
  sessions.set(ws, session);

  // Auth timeout — must authenticate within 10s
  const authTimeout = setTimeout(() => {
    if (!session.authenticated) {
      ws.send(JSON.stringify({ type: "error", payload: "Authentication timeout" }));
      ws.close(4001, "Auth timeout");
    }
  }, 10000);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages
    }

    switch (msg.type) {
      case "auth": {
        // Constant-time comparison to prevent timing attacks
        const provided = Buffer.from(String(msg.token || ""));
        const expected = Buffer.from(TOKEN);
        if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
          ws.send(JSON.stringify({ type: "error", payload: "Invalid token" }));
          ws.close(4003, "Auth failed");
          return;
        }

        clearTimeout(authTimeout);
        session.authenticated = true;
        console.log(`[wotch] Client ${clientIp} authenticated`);

        // Spawn PTY — same as desktop main.js createPty()
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;
        const ptyProcess = pty.spawn(SHELL, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.env.HOME || os.homedir(),
          env: { ...process.env, TERM: "xterm-256color" },
        });

        session.pty = ptyProcess;

        // PTY → WebSocket
        ptyProcess.onData((data) => {
          if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify({ type: "data", payload: data }));
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          console.log(`[wotch] PTY exited (code ${exitCode}) for ${clientIp}`);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "closed", payload: `Shell exited (code ${exitCode})` }));
          }
          ws.close(1000, "Shell exited");
        });

        ws.send(JSON.stringify({ type: "connected" }));
        break;
      }

      case "data": {
        if (!session.authenticated || !session.pty) return;
        session.pty.write(msg.payload || "");
        break;
      }

      case "resize": {
        if (!session.authenticated || !session.pty) return;
        const cols = Math.max(1, Math.min(500, msg.cols || 80));
        const rows = Math.max(1, Math.min(200, msg.rows || 24));
        session.pty.resize(cols, rows);
        break;
      }

      case "ping": {
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      }
    }
  });

  ws.on("close", () => {
    console.log(`[wotch] Client ${clientIp} disconnected`);
    clearTimeout(authTimeout);
    if (session.pty) {
      try { session.pty.kill(); } catch { /* already dead */ }
    }
    sessions.delete(ws);
    connectionCount--;
  });

  ws.on("error", (err) => {
    console.error(`[wotch] WebSocket error for ${clientIp}:`, err.message);
  });
});

// ── Graceful shutdown ───────────────────────────────────────────────
function shutdown() {
  console.log("\n[wotch] Shutting down...");
  for (const [ws, session] of sessions) {
    if (session.pty) {
      try { session.pty.kill(); } catch { /* ignore */ }
    }
    ws.close(1001, "Server shutting down");
  }
  wss.close(() => {
    console.log("[wotch] Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
