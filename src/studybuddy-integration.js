// StudyBuddy ↔ Wotch integration — /ask client.
//
// Reads StudyBuddy's extension token and port from its platform config dir,
// then POSTs {question, source:"wotch", context?} to http://127.0.0.1:<port>/ask.
// See docs/WOTCH_INTEGRATION.md §5.2 in the StudyBuddy repo.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

function studyBuddyConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "studybuddy");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "studybuddy");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "studybuddy");
}

function readConfigFile(name) {
  const file = path.join(studyBuddyConfigDir(), name);
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function isInstalled() {
  return readConfigFile("extension-token") != null && readConfigFile("extension-port") != null;
}

function readTokenAndPort() {
  const token = readConfigFile("extension-token");
  const portRaw = readConfigFile("extension-port");
  if (!token || !portRaw) return null;
  const port = parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { token, port };
}

async function ask({ question, context, timeoutMs } = {}) {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) throw new Error("question is empty");
  if (q.length > 4096) throw new Error("question exceeds 4 KB cap");

  const creds = readTokenAndPort();
  if (!creds) {
    const err = new Error("studybuddy-not-installed");
    err.code = "ENOCONFIG";
    throw err;
  }

  const payload = { question: q, source: "wotch" };
  if (typeof context === "string" && context.length > 0) {
    payload.context = context.length > 4096 ? context.slice(-4096) : context;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf-8");

  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: creds.port,
      path: "/ask",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Authorization": `Bearer ${creds.token}`,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, body: text });
        } else {
          const err = new Error(`studybuddy /ask returned ${res.statusCode}`);
          err.code = res.statusCode === 401 ? "EAUTH" : "EHTTP";
          err.status = res.statusCode;
          err.body = text;
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (e) => {
      const err = new Error(e.message || "request failed");
      err.code = e.code === "ECONNREFUSED" ? "ECONNREFUSED" : (e.code || "ENET");
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

module.exports = { ask, isInstalled, studyBuddyConfigDir };
