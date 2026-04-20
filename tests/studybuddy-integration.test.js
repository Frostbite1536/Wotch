// Unit tests for src/studybuddy-integration.js
//
// Run with: npm test
//
// The module reads StudyBuddy's token+port from the platform config dir.
// Tests redirect that dir by setting XDG_CONFIG_HOME (Linux/test fallback)
// and APPDATA (Windows) before requiring the module.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ── Sandbox the StudyBuddy config dir ────────────────────────────
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wotch-sb-test-"));
process.env.XDG_CONFIG_HOME = TMP_ROOT;
process.env.APPDATA = TMP_ROOT;
// On macOS, studyBuddyConfigDir() ignores the env vars and uses ~/Library/...
// so these tests are primarily validated on Linux + Windows CI.

// Platform-agnostic resolution of where the module will look:
function sandboxedConfigDir() {
  if (process.platform === "win32") return path.join(TMP_ROOT, "studybuddy");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "studybuddy");
  }
  return path.join(TMP_ROOT, "studybuddy");
}

const CONFIG_DIR = sandboxedConfigDir();
fs.mkdirSync(CONFIG_DIR, { recursive: true });

function writeConfig(token, port) {
  fs.writeFileSync(path.join(CONFIG_DIR, "extension-token"), token);
  fs.writeFileSync(path.join(CONFIG_DIR, "extension-port"), String(port));
}

function clearConfig() {
  for (const f of ["extension-token", "extension-port"]) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// Require after env is set.
const sb = require("../src/studybuddy-integration");

// ── Test helpers ─────────────────────────────────────────────────
function listenOnPort(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Tests ────────────────────────────────────────────────────────
describe("studybuddy-integration", () => {
  describe("config resolution", () => {
    test("studyBuddyConfigDir returns a plausible path", () => {
      const dir = sb.studyBuddyConfigDir();
      assert.ok(typeof dir === "string");
      assert.ok(dir.toLowerCase().includes("studybuddy"));
    });

    test("isInstalled is false when config files are missing", () => {
      clearConfig();
      if (process.platform === "darwin") return; // sandbox does not cover ~/Library
      assert.equal(sb.isInstalled(), false);
    });

    test("isInstalled is true when both token and port files exist", () => {
      if (process.platform === "darwin") return;
      writeConfig("tkn-123", 19521);
      assert.equal(sb.isInstalled(), true);
      clearConfig();
    });
  });

  describe("ask()", () => {
    test("rejects empty question", async () => {
      await assert.rejects(() => sb.ask({ question: "" }), /question is empty/);
      await assert.rejects(() => sb.ask({ question: "   " }), /question is empty/);
    });

    test("rejects over-long question (>4 KB)", async () => {
      const big = "x".repeat(4097);
      await assert.rejects(() => sb.ask({ question: big }), /exceeds 4 KB cap/);
    });

    test("throws ENOCONFIG when StudyBuddy is not installed", async () => {
      if (process.platform === "darwin") return;
      clearConfig();
      await assert.rejects(
        () => sb.ask({ question: "hi" }),
        (err) => err.code === "ENOCONFIG",
      );
    });

    test("succeeds on 200 and sends Bearer token + JSON body", async () => {
      if (process.platform === "darwin") return;
      let seenAuth = null;
      let seenBody = null;
      let seenPath = null;
      let seenMethod = null;
      const { server, port } = await listenOnPort((req, res) => {
        seenAuth = req.headers["authorization"];
        seenPath = req.url;
        seenMethod = req.method;
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seenBody = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      try {
        writeConfig("tkn-abc", port);
        const result = await sb.ask({ question: "what's module 03?", context: "last term output" });
        assert.equal(result.ok, true);
        assert.equal(result.status, 200);
        assert.equal(seenAuth, "Bearer tkn-abc");
        assert.equal(seenMethod, "POST");
        assert.equal(seenPath, "/ask");
        const parsed = JSON.parse(seenBody);
        assert.equal(parsed.question, "what's module 03?");
        assert.equal(parsed.source, "wotch");
        assert.equal(parsed.context, "last term output");
      } finally {
        clearConfig();
        await closeServer(server);
      }
    });

    test("tails context to last 4 KB when oversized", async () => {
      if (process.platform === "darwin") return;
      let seenBody = null;
      const { server, port } = await listenOnPort((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seenBody = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200); res.end("{}");
        });
      });
      try {
        writeConfig("tkn", port);
        const big = "A".repeat(3000) + "B".repeat(5000);
        await sb.ask({ question: "q", context: big });
        const parsed = JSON.parse(seenBody);
        assert.equal(parsed.context.length, 4096);
        // Tail preserved → must end with Bs.
        assert.equal(parsed.context.at(-1), "B");
      } finally {
        clearConfig();
        await closeServer(server);
      }
    });

    test("maps 401 to EAUTH", async () => {
      if (process.platform === "darwin") return;
      const { server, port } = await listenOnPort((_req, res) => {
        res.writeHead(401); res.end('{"error":"nope"}');
      });
      try {
        writeConfig("tkn", port);
        await assert.rejects(
          () => sb.ask({ question: "hi" }),
          (err) => err.code === "EAUTH" && err.status === 401,
        );
      } finally {
        clearConfig();
        await closeServer(server);
      }
    });

    test("maps connection refused to ECONNREFUSED", async () => {
      if (process.platform === "darwin") return;
      // Pick a port that (almost certainly) has no listener.
      writeConfig("tkn", 1); // port 1 requires privilege; nothing will answer
      await assert.rejects(
        () => sb.ask({ question: "hi" }),
        (err) => err.code === "ECONNREFUSED" || err.code === "ENET",
      );
      clearConfig();
    });

    test("maps hung request to a timeout-shaped error", async () => {
      if (process.platform === "darwin") return;
      // Server accepts the connection but never responds — ask() should time out.
      const { server, port } = await listenOnPort(() => { /* intentionally hang */ });
      try {
        writeConfig("tkn", port);
        await assert.rejects(
          () => sb.ask({ question: "hi", timeoutMs: 150 }),
          (err) => err.code === "ENET" || /timeout/i.test(err.message),
        );
      } finally {
        clearConfig();
        await closeServer(server);
      }
    });
  });
});
