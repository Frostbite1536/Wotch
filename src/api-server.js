// src/api-server.js
// Wotch Local API — HTTP + WebSocket server for external tool integration.
// Runs in the Electron main process, binds to 127.0.0.1 only.

const http = require("http");
const crypto = require("crypto");
const url = require("url");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const WebSocket = require("ws");

const API_TOKEN_PATH = path.join(os.homedir(), ".wotch", "api-token");
const API_PORT_PATH = path.join(os.homedir(), ".wotch", "api-port");
const MAX_PORT_ATTEMPTS = 10;
const WS_AUTH_TIMEOUT = 5000;
const WS_HEARTBEAT_INTERVAL = 30000;
const WS_PONG_TIMEOUT = 10000;
const WS_MAX_CONNECTIONS = 10;
const WS_MAX_MESSAGES_PER_SEC = 50;
const MAX_BODY_SIZE = 1024 * 64; // 64KB

// ── Token Management ───────────────────────────────────────────────

function loadOrGenerateToken() {
  try {
    const existing = fs.readFileSync(API_TOKEN_PATH, "utf-8").trim();
    if (existing.startsWith("wotch_") && existing.length === 71) {
      return existing;
    }
  } catch { /* file doesn't exist or unreadable */ }

  const token = "wotch_" + crypto.randomBytes(32).toString("hex");
  const dir = path.dirname(API_TOKEN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(API_TOKEN_PATH, token + "\n", { encoding: "utf-8", mode: 0o600 });
  return token;
}

function maskToken(token) {
  if (!token || token.length < 15) return "wotch_****";
  return token.slice(0, 10) + "..." + token.slice(-4);
}

// ── DNS Rebinding Protection ───────────────────────────────────────

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validateHost(req) {
  const host = req.headers["host"];
  if (!host) return false;
  const hostWithoutPort = host.replace(/:\d+$/, "");
  return ALLOWED_HOSTS.has(hostWithoutPort);
}

// ── Rate Limiter (Token Bucket) ────────────────────────────────────

class RateLimiter {
  constructor(capacity = 100, refillRate = 20) {
    this.capacity = capacity;
    this.refillRate = refillRate; // tokens per second
    this.buckets = new Map();    // ip -> { tokens, lastRefill }
  }

  allow(ip) {
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(ip, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

// ── HTTP Router ────────────────────────────────────────────────────

class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, paramNames: string[], handler }
  }

  add(method, pathStr, handler) {
    const paramNames = [];
    const regexStr = pathStr.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
  }

  get(pathStr, handler) { this.add("GET", pathStr, handler); }
  post(pathStr, handler) { this.add("POST", pathStr, handler); }
  patch(pathStr, handler) { this.add("PATCH", pathStr, handler); }
  delete(pathStr, handler) { this.add("DELETE", pathStr, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.pattern);
      if (m) {
        const params = {};
        route.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}

// ── API Server ─────────────────────────────────────────────────────

class ApiServer extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.server = null;
    this.wss = null;
    this.token = null;
    this.running = false;
    this.port = null;
    this.startedAt = null;
    this.router = new Router();
    this.rateLimiter = new RateLimiter(100, 20);
    this.wsClients = new Map(); // ws -> { authenticated, subscriptions, sessionId, msgCount, msgCountReset }
    this.heartbeatInterval = null;
    this.terminalBuffers = new Map(); // tabId -> { data: string }

    this._setupRoutes();
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async start() {
    if (this.running) return;

    this.token = loadOrGenerateToken();
    this.startedAt = Date.now();

    this.server = http.createServer((req, res) => this._handleRequest(req, res));

    this.wss = new WebSocket.Server({ noServer: true });
    this.wss.on("connection", (ws, req) => this._handleWsConnection(ws, req));

    this.server.on("upgrade", (req, socket, head) => {
      if (!validateHost(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const parsed = url.parse(req.url);
      if (parsed.pathname !== "/v1/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      // Check connection limit
      if (this.wsClients.size >= WS_MAX_CONNECTIONS) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    const basePort = this.options.loadSettings().apiPort || 19519;
    await this._listen(basePort);

    // Write port file for external discovery
    fs.writeFileSync(API_PORT_PATH, String(this.port) + "\n", { encoding: "utf-8", mode: 0o600 });

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => this._heartbeat(), WS_HEARTBEAT_INTERVAL);

    this.running = true;
    console.log(`[wotch] API server listening on 127.0.0.1:${this.port}`);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all WebSocket connections
    for (const [ws] of this.wsClients) {
      try { ws.close(1001, "Server shutting down"); } catch { /* ignore */ }
    }
    this.wsClients.clear();

    // Close servers
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    await new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
    this.server = null;

    // Clean up port file
    try { fs.unlinkSync(API_PORT_PATH); } catch { /* ignore */ }

    console.log("[wotch] API server stopped");
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  getInfo() {
    return {
      running: this.running,
      port: this.port,
      tokenMasked: maskToken(this.token),
      connections: this.wsClients.size,
    };
  }

  getToken() {
    return this.token;
  }

  regenerateToken() {
    this.token = "wotch_" + crypto.randomBytes(32).toString("hex");
    const dir = path.dirname(API_TOKEN_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(API_TOKEN_PATH, this.token + "\n", { encoding: "utf-8", mode: 0o600 });

    // Disconnect all WS clients
    for (const [ws] of this.wsClients) {
      try { ws.close(4004, "Token revoked"); } catch { /* ignore */ }
    }
    this.wsClients.clear();

    return maskToken(this.token);
  }

  // ── Terminal buffer tracking ───────────────────────────────────

  addTerminalData(tabId, data) {
    let buf = this.terminalBuffers.get(tabId);
    if (!buf) {
      buf = { data: "" };
      this.terminalBuffers.set(tabId, buf);
    }
    buf.data += data;
    if (buf.data.length > 50000) {
      buf.data = buf.data.slice(-50000);
    }
  }

  removeTerminalBuffer(tabId) {
    this.terminalBuffers.delete(tabId);
  }

  // ── Event Broadcasting ─────────────────────────────────────────

  broadcastEvent(type, payload) {
    if (this.wsClients.size === 0) return;

    const message = JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    for (const [ws, client] of this.wsClients) {
      if (!client.authenticated) continue;
      if (!this._clientSubscribedTo(client, type, payload)) continue;
      try { ws.send(message); } catch { /* ignore dead sockets */ }
    }
  }

  _clientSubscribedTo(client, type, payload) {
    if (client.subscriptions.has("*")) {
      // Check tab filter for terminal:output
      if (type === "terminal:output" && client.filters["terminal:output"]) {
        return client.filters["terminal:output"].includes(payload.tabId);
      }
      return true;
    }
    if (!client.subscriptions.has(type)) return false;
    // Check tab filter
    if (type === "terminal:output" && client.filters["terminal:output"]) {
      return client.filters["terminal:output"].includes(payload.tabId);
    }
    return true;
  }

  // ── HTTP Request Handling ──────────────────────────────────────

  async _handleRequest(req, res) {
    // DNS rebinding check — first line of defense
    if (!validateHost(req)) {
      this._sendJson(res, 403, { ok: false, error: "Forbidden", code: "FORBIDDEN" });
      return;
    }

    // CORS — deny all cross-origin
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Content-Length": "0" });
      res.end();
      return;
    }

    // Rate limiting (exempt health check)
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    if (pathname !== "/v1/health") {
      const ip = req.socket.remoteAddress || "127.0.0.1";
      if (!this.rateLimiter.allow(ip)) {
        res.setHeader("Retry-After", "1");
        this._sendJson(res, 429, { ok: false, error: "Too many requests", code: "RATE_LIMITED" });
        return;
      }
    }

    // Route match
    const match = this.router.match(req.method, pathname);
    if (!match) {
      this._sendJson(res, 404, { ok: false, error: "Not found", code: "NOT_FOUND" });
      return;
    }

    // Auth check (skip for health)
    if (pathname !== "/v1/health") {
      if (!this._authenticate(req)) {
        this._sendJson(res, 401, { ok: false, error: "Invalid or missing authentication token", code: "UNAUTHORIZED" });
        return;
      }
    }

    // Parse body for POST/PATCH/PUT
    let body = null;
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      try {
        body = await this._readBody(req);
      } catch (err) {
        this._sendJson(res, 400, { ok: false, error: err.message, code: "VALIDATION_ERROR" });
        return;
      }
    }

    // Execute handler
    try {
      await match.handler(req, res, match.params, parsed.query, body);
    } catch (err) {
      console.error("[wotch] API handler error:", err.message);
      this._sendJson(res, 500, { ok: false, error: "Internal server error", code: "INTERNAL_ERROR" });
    }
  }

  _authenticate(req) {
    const auth = req.headers["authorization"];
    if (!auth) return false;
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") return false;
    const provided = Buffer.from(parts[1]);
    const expected = Buffer.from(this.token);
    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > MAX_BODY_SIZE) {
          reject(new Error("Request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data) { resolve(null); return; }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  _sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  // ── WebSocket Handling ─────────────────────────────────────────

  _handleWsConnection(ws, req) {
    const clientState = {
      authenticated: false,
      subscriptions: new Set(),
      filters: {},
      sessionId: "ws-" + crypto.randomBytes(4).toString("hex"),
      msgCount: 0,
      msgCountReset: Date.now(),
    };
    this.wsClients.set(ws, clientState);

    // Auth timeout
    const authTimer = setTimeout(() => {
      if (!clientState.authenticated) {
        try {
          ws.send(JSON.stringify({ type: "auth:error", message: "Authentication timeout" }));
          ws.close(4002, "Authentication timeout");
        } catch { /* ignore */ }
      }
    }, WS_AUTH_TIMEOUT);

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
      // WS message rate limiting
      const now = Date.now();
      if (now - clientState.msgCountReset > 1000) {
        clientState.msgCount = 0;
        clientState.msgCountReset = now;
      }
      clientState.msgCount++;
      if (clientState.msgCount > WS_MAX_MESSAGES_PER_SEC) {
        try { ws.send(JSON.stringify({ type: "error", message: "Rate limited", code: "RATE_LIMITED" })); } catch { /* ignore */ }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed
      }

      if (!clientState.authenticated) {
        // Only accept auth messages before authentication
        if (msg.type === "auth") {
          clearTimeout(authTimer);
          const provided = Buffer.from(String(msg.token || ""));
          const expected = Buffer.from(this.token);
          if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
            clientState.authenticated = true;
            try {
              ws.send(JSON.stringify({
                type: "auth:ok",
                sessionId: clientState.sessionId,
                serverVersion: this._getVersion(),
              }));
            } catch { /* ignore */ }
          } else {
            try {
              ws.send(JSON.stringify({ type: "auth:error", message: "Invalid token" }));
              ws.close(4001, "Authentication failed");
            } catch { /* ignore */ }
          }
        }
        return;
      }

      // Authenticated message handling
      switch (msg.type) {
        case "subscribe": {
          const events = Array.isArray(msg.events) ? msg.events : [];
          for (const e of events) clientState.subscriptions.add(e);
          if (msg.filter?.tabIds) {
            for (const e of events) {
              clientState.filters[e] = msg.filter.tabIds;
            }
          }
          try {
            ws.send(JSON.stringify({ type: "subscribe:ok", events: [...clientState.subscriptions] }));
          } catch { /* ignore */ }
          break;
        }
        case "unsubscribe": {
          const events = Array.isArray(msg.events) ? msg.events : [];
          for (const e of events) {
            clientState.subscriptions.delete(e);
            delete clientState.filters[e];
          }
          try {
            ws.send(JSON.stringify({ type: "unsubscribe:ok", events: [...clientState.subscriptions] }));
          } catch { /* ignore */ }
          break;
        }
        case "ping": {
          try {
            ws.send(JSON.stringify({ type: "pong", id: msg.id }));
          } catch { /* ignore */ }
          break;
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      this.wsClients.delete(ws);
    });

    ws.on("error", () => {
      clearTimeout(authTimer);
      this.wsClients.delete(ws);
    });
  }

  _heartbeat() {
    for (const [ws, client] of this.wsClients) {
      if (ws.isAlive === false) {
        // Did not respond to previous ping within the interval
        this.wsClients.delete(ws);
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
      // 10s pong timeout — terminate if no pong received
      const pongTimer = setTimeout(() => {
        if (ws.isAlive === false) {
          this.wsClients.delete(ws);
          try { ws.terminate(); } catch { /* ignore */ }
        }
      }, WS_PONG_TIMEOUT);
      // Don't let the timer keep the process alive
      if (pongTimer.unref) pongTimer.unref();
    }
  }

  // ── Route Setup ────────────────────────────────────────────────

  _setupRoutes() {
    // Health (no auth)
    this.router.get("/v1/health", (req, res) => {
      this._sendJson(res, 200, {
        ok: true,
        data: {
          status: "healthy",
          version: this._getVersion(),
          uptime: Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000),
          apiVersion: "v1",
        },
      });
    });

    // Info
    this.router.get("/v1/info", (req, res) => {
      const { ptyProcesses, sshSessions, getExpansionState } = this.options;
      const expansion = getExpansionState();
      let ptyCount = 0, sshCount = 0;
      for (const [,] of ptyProcesses) ptyCount++;
      for (const [,] of sshSessions) sshCount++;

      this._sendJson(res, 200, {
        ok: true,
        data: {
          version: this._getVersion(),
          platform: os.platform(),
          electron: process.versions.electron || "unknown",
          node: process.versions.node,
          uptime: Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000),
          tabs: { total: ptyCount + sshCount, pty: ptyCount, ssh: sshCount },
          api: {
            port: this.port,
            wsConnections: this.wsClients.size,
            startedAt: new Date(this.startedAt).toISOString(),
          },
          window: {
            expanded: expansion.expanded,
            pinned: expansion.pinned,
          },
        },
      });
    });

    // Claude status — all tabs
    this.router.get("/v1/status", (req, res) => {
      const { integrationManager } = this.options;
      const aggregate = integrationManager.getAggregateStatus();
      const tabs = {};
      for (const [tabId] of integrationManager.statusDetector.tabs) {
        tabs[tabId] = integrationManager.getStatus(tabId);
      }
      this._sendJson(res, 200, { ok: true, data: { aggregate, tabs } });
    });

    // Claude status — single tab
    this.router.get("/v1/status/:tabId", (req, res, params) => {
      const { integrationManager } = this.options;
      const status = integrationManager.getStatus(params.tabId);
      if (!status || !integrationManager.statusDetector.tabs.has(params.tabId)) {
        this._sendJson(res, 404, { ok: false, error: "Tab not found", code: "NOT_FOUND" });
        return;
      }
      this._sendJson(res, 200, { ok: true, data: { tabId: params.tabId, ...status } });
    });

    // List tabs
    this.router.get("/v1/tabs", (req, res) => {
      const { ptyProcesses, sshSessions, integrationManager } = this.options;
      const tabs = [];
      for (const [tabId] of ptyProcesses) {
        const status = integrationManager.getStatus(tabId) || { state: "idle", description: "" };
        tabs.push({ id: tabId, type: "pty", status: { state: status.state, description: status.description } });
      }
      for (const [tabId, s] of sshSessions) {
        const status = integrationManager.getStatus(tabId) || { state: "idle", description: "" };
        tabs.push({ id: tabId, type: "ssh", profileId: s.profileId, status: { state: status.state, description: status.description } });
      }
      this._sendJson(res, 200, { ok: true, data: { tabs } });
    });

    // Create tab
    this.router.post("/v1/tabs", (req, res, params, query, body) => {
      const { createPty } = this.options;
      const cwd = body?.cwd || os.homedir();
      const tabId = `tab-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
      try {
        createPty(tabId, cwd);
        this._sendJson(res, 201, { ok: true, data: { tabId, type: "pty", cwd } });
      } catch (err) {
        this._sendJson(res, 500, { ok: false, error: "Failed to create tab", code: "INTERNAL_ERROR" });
      }
    });

    // Delete tab
    this.router.delete("/v1/tabs/:tabId", (req, res, params) => {
      const { ptyProcesses, sshSessions, killTab } = this.options;
      const tabId = params.tabId;
      if (!ptyProcesses.has(tabId) && !sshSessions.has(tabId)) {
        this._sendJson(res, 404, { ok: false, error: "Tab not found", code: "NOT_FOUND" });
        return;
      }
      killTab(tabId);
      this._sendJson(res, 200, { ok: true, data: { tabId, closed: true } });
    });

    // Read terminal buffer
    this.router.get("/v1/tabs/:tabId/buffer", (req, res, params, query) => {
      const { ptyProcesses, sshSessions } = this.options;
      const tabId = params.tabId;
      if (!ptyProcesses.has(tabId) && !sshSessions.has(tabId)) {
        this._sendJson(res, 404, { ok: false, error: "Tab not found", code: "NOT_FOUND" });
        return;
      }

      const lines = Math.min(Math.max(parseInt(query.lines) || 100, 1), 1000);
      const format = query.format === "clean" ? "clean" : "raw";

      const buf = this.terminalBuffers.get(tabId);
      let content = buf ? buf.data : "";

      // Trim to requested lines
      const allLines = content.split("\n");
      if (allLines.length > lines) {
        content = allLines.slice(-lines).join("\n");
      }

      // Strip ANSI if clean format requested
      if (format === "clean") {
        content = content.replace(
          // eslint-disable-next-line no-control-regex
          /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
          ""
        ).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      }

      this._sendJson(res, 200, {
        ok: true,
        data: { tabId, lines, format, content, totalBytes: buf ? buf.data.length : 0 },
      });
    });

    // Write to terminal
    this.router.post("/v1/tabs/:tabId/input", (req, res, params, query, body) => {
      const { ptyProcesses, sshSessions, writePty } = this.options;
      const tabId = params.tabId;
      if (!ptyProcesses.has(tabId) && !sshSessions.has(tabId)) {
        this._sendJson(res, 404, { ok: false, error: "Tab not found", code: "NOT_FOUND" });
        return;
      }
      if (!body || typeof body.data !== "string") {
        this._sendJson(res, 422, { ok: false, error: "Missing 'data' field", code: "VALIDATION_ERROR" });
        return;
      }
      writePty(tabId, body.data);
      this._sendJson(res, 200, { ok: true, data: { tabId, bytesWritten: Buffer.byteLength(body.data) } });
    });

    // Create checkpoint
    this.router.post("/v1/checkpoints", (req, res, params, query, body) => {
      const { gitCheckpoint } = this.options;
      if (!body || !body.projectPath) {
        this._sendJson(res, 422, { ok: false, error: "Missing 'projectPath'", code: "VALIDATION_ERROR" });
        return;
      }
      const result = gitCheckpoint(body.projectPath, body.message);
      if (result.message === "Not a git repository") {
        this._sendJson(res, 422, { ok: false, error: "Not a git repository", code: "VALIDATION_ERROR" });
        return;
      }
      const status = result.success ? 201 : 200;
      this._sendJson(res, status, { ok: true, data: result });

      // Broadcast checkpoint event
      if (result.success) {
        this.broadcastEvent("git:checkpoint", {
          projectPath: body.projectPath,
          success: true,
          hash: result.details.hash,
          branch: result.details.branch,
          changedFiles: result.details.changedFiles,
          message: result.details.commitMessage,
        });
      }
    });

    // List checkpoints
    this.router.get("/v1/checkpoints", (req, res, params, query) => {
      const { gitListCheckpoints } = this.options;
      if (!query.projectPath) {
        this._sendJson(res, 422, { ok: false, error: "Missing 'projectPath' query parameter", code: "VALIDATION_ERROR" });
        return;
      }
      const limit = Math.min(Math.max(parseInt(query.limit) || 20, 1), 100);
      const result = gitListCheckpoints(query.projectPath, limit);
      this._sendJson(res, 200, { ok: true, data: result });
    });

    // Git status
    this.router.get("/v1/git/status", (req, res, params, query) => {
      const { gitGetStatus } = this.options;
      if (!query.projectPath) {
        this._sendJson(res, 422, { ok: false, error: "Missing 'projectPath' query parameter", code: "VALIDATION_ERROR" });
        return;
      }
      const result = gitGetStatus(query.projectPath);
      if (result === null) {
        this._sendJson(res, 200, { ok: true, data: { projectPath: query.projectPath, isGitRepo: false } });
        return;
      }
      this._sendJson(res, 200, { ok: true, data: { projectPath: query.projectPath, ...result } });
    });

    // Git diff
    this.router.get("/v1/git/diff", (req, res, params, query) => {
      const { gitDiff } = this.options;
      if (!query.projectPath) {
        this._sendJson(res, 422, { ok: false, error: "Missing 'projectPath' query parameter", code: "VALIDATION_ERROR" });
        return;
      }
      const mode = query.mode === "last-checkpoint" ? "last-checkpoint" : "working";
      const result = gitDiff(query.projectPath, mode);
      this._sendJson(res, 200, { ok: true, data: { projectPath: query.projectPath, mode, diff: result } });
    });

    // Projects
    this.router.get("/v1/projects", (req, res) => {
      const { detectProjects } = this.options;
      const projects = detectProjects();
      this._sendJson(res, 200, { ok: true, data: { projects } });
    });

    // Get settings (redacted)
    this.router.get("/v1/settings", (req, res) => {
      const s = { ...this.options.loadSettings() };
      delete s.sshProfiles; // INV-SEC-013
      this._sendJson(res, 200, { ok: true, data: s });
    });

    // Update settings
    this.router.patch("/v1/settings", (req, res, params, query, body) => {
      if (!body || typeof body !== "object") {
        this._sendJson(res, 422, { ok: false, error: "Invalid request body", code: "VALIDATION_ERROR" });
        return;
      }
      // Reject sshProfiles — INV-SEC-013
      if ("sshProfiles" in body) {
        this._sendJson(res, 422, { ok: false, error: "sshProfiles cannot be modified via the API", code: "VALIDATION_ERROR" });
        return;
      }

      const validationErrors = this._validateSettings(body);
      if (validationErrors) {
        this._sendJson(res, 422, { ok: false, error: validationErrors, code: "VALIDATION_ERROR" });
        return;
      }

      const { saveSettingsFn } = this.options;
      saveSettingsFn(body, "api");
      this._sendJson(res, 200, { ok: true, data: body });

      // Handle API server lifecycle changes after response is sent
      if ("apiEnabled" in body && body.apiEnabled === false) {
        // Shut down after responding
        setImmediate(() => this.stop().catch((err) => {
          console.error("[wotch] API stop failed:", err.message);
        }));
      } else if ("apiPort" in body) {
        setImmediate(() => this.restart().catch((err) => {
          console.error("[wotch] API restart failed:", err.message);
        }));
      }
    });

    // Reset settings
    this.router.post("/v1/settings/reset", (req, res) => {
      const { resetSettingsFn } = this.options;
      const result = resetSettingsFn();
      const redacted = { ...result };
      delete redacted.sshProfiles;
      this._sendJson(res, 200, { ok: true, data: redacted });
    });

    // Platform info
    this.router.get("/v1/platform", (req, res) => {
      const { getPlatformInfo } = this.options;
      this._sendJson(res, 200, { ok: true, data: getPlatformInfo() });
    });
  }

  _validateSettings(body) {
    const rules = {
      pillWidth: { type: "number", min: 100, max: 400 },
      pillHeight: { type: "number", min: 24, max: 60 },
      expandedWidth: { type: "number", min: 400, max: 1200 },
      expandedHeight: { type: "number", min: 200, max: 900 },
      hoverPadding: { type: "number", min: 0, max: 100 },
      collapseDelay: { type: "number", min: 100, max: 5000 },
      mousePollingMs: { type: "number", min: 50, max: 1000 },
      defaultShell: { type: "string", maxLen: 256 },
      startExpanded: { type: "boolean" },
      pinned: { type: "boolean" },
      theme: { type: "enum", values: ["dark", "light", "purple", "green"] },
      autoLaunchClaude: { type: "boolean" },
      displayIndex: { type: "number", min: 0, max: 9 },
      position: { type: "enum", values: ["top", "left", "right"] },
      apiEnabled: { type: "boolean" },
      apiPort: { type: "number", min: 1024, max: 65535 },
    };

    for (const [key, value] of Object.entries(body)) {
      const rule = rules[key];
      if (!rule) continue; // skip unknown keys (they'll be filtered by save handler)

      if (rule.type === "number") {
        if (typeof value !== "number" || value < rule.min || value > rule.max) {
          return `${key} must be a number between ${rule.min} and ${rule.max}`;
        }
      } else if (rule.type === "string") {
        if (typeof value !== "string" || (rule.maxLen && value.length > rule.maxLen)) {
          return `${key} must be a string (max ${rule.maxLen} chars)`;
        }
      } else if (rule.type === "boolean") {
        if (typeof value !== "boolean") {
          return `${key} must be a boolean`;
        }
      } else if (rule.type === "enum") {
        if (!rule.values.includes(value)) {
          return `${key} must be one of: ${rule.values.join(", ")}`;
        }
      }
    }
    return null;
  }

  // ── Internal Helpers ───────────────────────────────────────────

  _getVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
      return pkg.version || "0.0.0";
    } catch {
      return "0.0.0";
    }
  }

  _listen(basePort) {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryPort = (port) => {
        const onError = (err) => {
          if (err.code === "EADDRINUSE" && attempt < MAX_PORT_ATTEMPTS) {
            attempt++;
            tryPort(port + 1);
          } else {
            reject(err);
          }
        };
        this.server.once("error", onError);
        this.server.listen(port, "127.0.0.1", () => {
          // Remove the startup error handler and add a runtime one
          this.server.removeListener("error", onError);
          this.server.on("error", (err) => {
            console.error("[wotch] API server error:", err.message);
          });
          this.port = port;
          resolve();
        });
      };
      tryPort(basePort);
    });
  }
}

module.exports = { ApiServer, loadOrGenerateToken, maskToken };
