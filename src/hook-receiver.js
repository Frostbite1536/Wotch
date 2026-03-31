// src/hook-receiver.js
// HTTP server that receives Claude Code hook events via type:http hooks.
// Claude Code POSTs the hook's stdin JSON directly as the request body.

const http = require("http");
const { EventEmitter } = require("events");

const MAX_BODY_SIZE = 65536; // 64KB
const RATE_LIMIT_PER_SECOND = 100;
const PORT_RANGE_START = 19520;
const PORT_RANGE_END = 19530;

class HookReceiver extends EventEmitter {
  constructor(port = PORT_RANGE_START) {
    super();
    this.port = port;
    this.server = null;
    this.active = false;
    this.eventCount = 0;
    this.rateLimitWindow = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));

      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          this.port++;
          if (this.port < PORT_RANGE_END) {
            console.log(`[wotch] Hook receiver port ${this.port - 1} in use, trying ${this.port}`);
            this.server.listen(this.port, "127.0.0.1");
          } else {
            this.active = false;
            const error = new Error("No available port for hook receiver (tried 19520-19529)");
            this.emit("error", error);
            reject(error);
          }
        } else {
          this.emit("error", err);
          reject(err);
        }
      });

      this.server.on("listening", () => {
        this.active = true;
        console.log(`[wotch] Hook receiver listening on 127.0.0.1:${this.port}`);
        this.emit("started", this.port);
        resolve(this.port);
      });

      this.server.listen(this.port, "127.0.0.1");
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.active = false;
        this.server.close(() => {
          console.log("[wotch] Hook receiver stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  isActive() {
    return this.active;
  }

  getPort() {
    return this.port;
  }

  getEventCount() {
    return this.eventCount;
  }

  _handleRequest(req, res) {
    // Only accept POST to /hook/*
    if (req.method !== "POST" || !req.url.startsWith("/hook/")) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Rate limiting
    if (this._isRateLimited()) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: "Rate limited" }));
      return;
    }

    const eventType = decodeURIComponent(req.url.slice("/hook/".length));

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: "Payload too large" }));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (res.writableEnded) return; // Already responded (413)

      try {
        const payload = JSON.parse(body);

        // Validate: must have session_id
        if (!payload || typeof payload.session_id !== "string") {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing session_id" }));
          return;
        }

        this.eventCount++;
        this.emit("hook-event", {
          eventType,
          ...payload,
        });

        // Return empty 200 — Wotch hooks are fire-and-forget
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  }

  _isRateLimited() {
    const now = Date.now();
    this.rateLimitWindow = this.rateLimitWindow.filter((t) => t > now - 1000);
    this.rateLimitWindow.push(now);
    return this.rateLimitWindow.length > RATE_LIMIT_PER_SECOND;
  }
}

module.exports = { HookReceiver };
