const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, Notification, dialog, safeStorage } = require("electron");
const path = require("path");
const pty = require("node-pty");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execSync, execFileSync, exec } = require("child_process");
const { Client: SSHClient } = require("ssh2");
const { ClaudeIntegrationManager } = require("./claude-integration-manager");
const { ApiServer } = require("./api-server");

// ── Platform detection ──────────────────────────────────────────────
const IS_WIN = os.platform() === "win32";
const IS_MAC = os.platform() === "darwin";
const IS_LINUX = os.platform() === "linux";

function isWayland() {
  if (!IS_LINUX) return false;
  return (
    process.env.WAYLAND_DISPLAY != null ||
    process.env.XDG_SESSION_TYPE === "wayland" ||
    (process.env.GDK_BACKEND || "").includes("wayland")
  );
}

const WAYLAND = isWayland();

// ── macOS notch detection ───────────────────────────────────────────
// Notch MacBooks have specific display resolutions at the native panel.
// We detect the notch by checking if the menu bar area (the gap between
// display.bounds.y and display.workArea.y) is taller than the traditional
// 25px menu bar. Notch Macs report ~37-38px because the menu bar extends
// to cover the notch height.
function detectMacNotch() {
  if (!IS_MAC) return false;
  try {
    const primary = screen.getPrimaryDisplay();
    const menuBarHeight = primary.workArea.y - primary.bounds.y;
    // Notch Macs have a menu bar height of ~37-38px (scaled).
    // Non-notch Macs have ~25px. Use 30 as the threshold.
    if (menuBarHeight > 30) return true;
    // Also check by known notch display widths (native resolution / scale)
    // 14" MBP: 3024x1964, 16" MBP: 3456x2234, 13"/15" MBA: 2560x1664 / 2880x1864
    const { width, height } = primary.size;
    const notchResolutions = [
      [3024, 1964], [3456, 2234], [2560, 1664], [2880, 1864],
      // Scaled equivalents that Electron might report
      [1512, 982], [1728, 1117], [1280, 832], [1440, 932],
      [1800, 1169], [2056, 1329],
    ];
    return notchResolutions.some(([w, h]) => width === w && height === h);
  } catch {
    return false;
  }
}

// Lazy-init after app is ready and screen API is available
let HAS_NOTCH = false;

// ── Config ──────────────────────────────────────────────────────────
const SETTINGS_DIR = path.join(os.homedir(), ".wotch");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  pillWidth: 200,
  pillHeight: 36,
  expandedWidth: 640,
  expandedHeight: 440,
  hoverPadding: 20,
  collapseDelay: 400,
  mousePollingMs: 100,
  defaultShell: "",          // empty = auto-detect
  startExpanded: false,
  pinned: false,             // remember pin state across restarts
  theme: "dark",
  autoLaunchClaude: false,
  displayIndex: 0,           // 0 = primary display
  position: "top",           // "top", "left", or "right"
  sshProfiles: [],           // saved SSH connection profiles
  // Claude Code integration
  integrationHooksEnabled: true,
  integrationHooksPort: 19520,
  integrationMcpEnabled: true,
  integrationMcpIpcPort: 19523,
  integrationAutoConfigureHooks: true,
  integrationAutoRegisterMCP: true,
  // Local API
  apiEnabled: false,
  apiPort: 19519,
  // Claude API chat
  apiBudgetMonthly: 0,       // 0 = unlimited
  chatDefaultModel: "claude-sonnet-4-6-20250514",
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch (err) {
    console.log("[wotch] Failed to load settings, using defaults:", err.message);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
    return true;
  } catch (err) {
    console.log("[wotch] Failed to save settings:", err.message);
    return false;
  }
}

let settings = loadSettings();

// ── Claude API: Credential Manager ─────────────────────────────────
const CREDENTIALS_PATH = path.join(SETTINGS_DIR, "credentials");
const CONVERSATIONS_DIR = path.join(SETTINGS_DIR, "conversations");
const USAGE_LOG_PATH = path.join(SETTINGS_DIR, "usage.json");

function tryReadFile(filePath) {
  try { return fs.readFileSync(filePath, "utf-8").trim(); } catch { return null; }
}

function deriveFallbackKey() {
  const material = [
    os.hostname(),
    os.homedir(),
    os.userInfo().username,
    tryReadFile("/etc/machine-id") || "no-machine-id",
  ].join("|");
  return crypto.pbkdf2Sync(material, "wotch-credential-salt", 100000, 32, "sha256");
}

function encryptFallback(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const result = Buffer.alloc(1 + 16 + 16 + encrypted.length);
  result[0] = 0x02;
  iv.copy(result, 1);
  authTag.copy(result, 17);
  encrypted.copy(result, 33);
  return result.toString("base64");
}

function decryptFallback(base64Data, key) {
  const data = Buffer.from(base64Data, "base64");
  if (data[0] !== 0x02) throw new Error("Unknown credential format");
  const iv = data.subarray(1, 17);
  const authTag = data.subarray(17, 33);
  const ciphertext = data.subarray(33);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
}

class CredentialManager {
  constructor(credentialsPath) {
    this.credentialsPath = credentialsPath;
    this.fallbackKey = null;
    this.cachedKey = null;
  }

  hasKey() {
    return fs.existsSync(this.credentialsPath);
  }

  setKey(apiKey) {
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      throw new Error("Invalid API key format");
    }
    let encoded;
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(apiKey);
      encoded = encrypted.toString("base64");
    } else {
      console.log("[wotch] OS keychain unavailable, using fallback encryption");
      if (!this.fallbackKey) this.fallbackKey = deriveFallbackKey();
      encoded = encryptFallback(apiKey, this.fallbackKey);
    }
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.credentialsPath, encoded, { encoding: "utf-8", mode: 0o600 });
    this.cachedKey = apiKey;
  }

  getKey() {
    if (this.cachedKey) return this.cachedKey;
    if (!this.hasKey()) return null;
    try {
      const raw = fs.readFileSync(this.credentialsPath, "utf-8");
      const buf = Buffer.from(raw, "base64");
      if (safeStorage.isEncryptionAvailable()) {
        try {
          this.cachedKey = safeStorage.decryptString(buf);
          return this.cachedKey;
        } catch { /* safeStorage failed, try fallback */ }
      }
      if (buf[0] === 0x02) {
        if (!this.fallbackKey) this.fallbackKey = deriveFallbackKey();
        this.cachedKey = decryptFallback(raw, this.fallbackKey);
        return this.cachedKey;
      }
      console.log("[wotch] Cannot decrypt credentials — keychain unavailable");
      return null;
    } catch (err) {
      console.log("[wotch] Failed to decrypt credentials:", err.message);
      return null;
    }
  }

  deleteKey() {
    this.cachedKey = null;
    try {
      if (fs.existsSync(this.credentialsPath)) fs.unlinkSync(this.credentialsPath);
    } catch (err) {
      console.log("[wotch] Failed to delete credentials:", err.message);
    }
  }

  async validateKey(apiKey) {
    const key = apiKey || this.getKey();
    if (!key) return { valid: false, error: "No API key provided" };
    try {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: key });
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      return { valid: true };
    } catch (err) {
      if (err.status === 401) return { valid: false, error: "Invalid API key" };
      if (err.status === 403) return { valid: false, error: "API key lacks required permissions" };
      return { valid: false, error: `Validation failed: ${err.message}` };
    }
  }

  clearCache() {
    this.cachedKey = null;
  }
}

const credentialManager = new CredentialManager(CREDENTIALS_PATH);

// ── Claude API: Token Tracker ──────────────────────────────────────
const MODEL_PRICING = {
  "claude-opus-4-6-20250514": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
};

class TokenTracker {
  constructor(logPath) {
    this.logPath = logPath;
    this.sessionUsage = { inputTokens: 0, outputTokens: 0, cost: 0 };
    this.conversationUsage = new Map();
  }

  calculateCost(model, inputTokens, outputTokens) {
    const p = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-6-20250514"];
    return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  }

  recordUsage(conversationId, model, inputTokens, outputTokens) {
    const cost = this.calculateCost(model, inputTokens, outputTokens);
    this.sessionUsage.inputTokens += inputTokens;
    this.sessionUsage.outputTokens += outputTokens;
    this.sessionUsage.cost += cost;

    const conv = this.conversationUsage.get(conversationId) || { inputTokens: 0, outputTokens: 0, cost: 0 };
    conv.inputTokens += inputTokens;
    conv.outputTokens += outputTokens;
    conv.cost += cost;
    this.conversationUsage.set(conversationId, conv);

    this.appendToLog({ conversationId, model, inputTokens, outputTokens, cost, timestamp: Date.now() });
    return { inputTokens, outputTokens, cost, sessionTotal: { ...this.sessionUsage } };
  }

  appendToLog(entry) {
    try {
      if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err) {
      console.log("[wotch] Failed to write usage log:", err.message);
    }
  }

  getSessionTotals() {
    return { ...this.sessionUsage };
  }

  getConversationTotals(conversationId) {
    return this.conversationUsage.get(conversationId) || { inputTokens: 0, outputTokens: 0, cost: 0 };
  }

  getMonthlyTotals() {
    try {
      if (!fs.existsSync(this.logPath)) return { inputTokens: 0, outputTokens: 0, cost: 0 };
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const lines = fs.readFileSync(this.logPath, "utf-8").trim().split("\n").filter(Boolean);
      let inputTokens = 0, outputTokens = 0, cost = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.timestamp >= monthStart) {
            inputTokens += entry.inputTokens || 0;
            outputTokens += entry.outputTokens || 0;
            cost += entry.cost || 0;
          }
        } catch { /* skip malformed lines */ }
      }
      return { inputTokens, outputTokens, cost };
    } catch {
      return { inputTokens: 0, outputTokens: 0, cost: 0 };
    }
  }
}

const tokenTracker = new TokenTracker(USAGE_LOG_PATH);

// ── Claude API: Context Engine ─────────────────────────────────────
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function estimateTokens(text) {
  // Rough estimate: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

function buildFileTree(dirPath, maxDepth, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const indent = "  ".repeat(currentDepth);
      if (entry.isDirectory()) {
        results.push(`${indent}${entry.name}/`);
        results.push(...buildFileTree(path.join(dirPath, entry.name), maxDepth, currentDepth + 1));
      } else {
        results.push(`${indent}${entry.name}`);
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ── Claude API: Conversation Manager ───────────────────────────────
const AVAILABLE_MODELS = [
  { id: "claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6", inputPrice: "$3/M", outputPrice: "$15/M" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", inputPrice: "$0.80/M", outputPrice: "$4/M" },
  { id: "claude-opus-4-6-20250514", name: "Claude Opus 4.6", inputPrice: "$15/M", outputPrice: "$75/M" },
];

function projectHash(projectPath) {
  return crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

function isValidConversationId(id) {
  return typeof id === "string" && /^conv-\d+$/.test(id);
}

class ClaudeAPIManager {
  constructor(credentialManager, tokenTracker) {
    this.credentialManager = credentialManager;
    this.tokenTracker = tokenTracker;
    this.anthropic = null;
    this.activeConversationId = null;
    this.conversations = new Map();
    this.currentAbortController = null;
    this.streaming = false;
  }

  _ensureClient() {
    const key = this.credentialManager.getKey();
    if (!key) throw new Error("No API key configured");
    if (!this.anthropic) {
      const Anthropic = require("@anthropic-ai/sdk");
      this.anthropic = new Anthropic({ apiKey: key });
    }
    return this.anthropic;
  }

  _invalidateClient() {
    this.anthropic = null;
  }

  newConversation(projectPath) {
    const id = `conv-${Date.now()}`;
    const conv = {
      id,
      projectPath: projectPath || null,
      projectName: projectPath ? path.basename(projectPath) : null,
      model: "claude-sonnet-4-6-20250514",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    this.conversations.set(id, conv);
    this.activeConversationId = id;
    return id;
  }

  async sendMessage(tabId, projectPath, userMessage, options, sendToRenderer) {
    const client = this._ensureClient();
    const model = options.model || "claude-sonnet-4-6-20250514";

    // Ensure active conversation
    if (!this.activeConversationId || !this.conversations.has(this.activeConversationId)) {
      this.newConversation(projectPath);
    }
    const conv = this.conversations.get(this.activeConversationId);
    conv.model = model;
    conv.updatedAt = new Date().toISOString();

    // Gather context
    let systemPrompt = "You are Claude, an AI assistant helping a developer working in Wotch (a floating terminal for Claude Code).\n\n## Current Context\n";
    const contextMeta = {};

    if (options.contextSources?.terminal !== false && tabId) {
      try {
        const termBuf = this._getTerminalBuffer(tabId);
        if (termBuf) {
          const cleaned = stripAnsi(termBuf);
          const lines = cleaned.split("\n");
          const trimmed = lines.slice(-200);
          systemPrompt += `\n### Recent Terminal Output\n\`\`\`\n${trimmed.join("\n")}\n\`\`\`\n`;
          contextMeta.terminal = { lineCount: trimmed.length, estimatedTokens: estimateTokens(trimmed.join("\n")), enabled: true };
        }
      } catch { /* ignore */ }
    }

    if (options.contextSources?.git !== false && projectPath) {
      try {
        const status = this._getGitStatus(projectPath);
        if (status) {
          systemPrompt += `\n### Git Status\nBranch: ${status.branch} | ${status.changedFiles} files changed | ${status.checkpoints || 0} checkpoints\n`;
          contextMeta.git = { changedFiles: status.changedFiles, estimatedTokens: 50, enabled: true };
        }
      } catch { /* ignore */ }
    }

    if (options.contextSources?.diff !== false && projectPath) {
      try {
        const diff = this._getGitDiff(projectPath);
        if (diff && diff !== "(no changes)") {
          const truncated = diff.length > 12000 ? diff.slice(0, 12000) + "\n... (truncated)" : diff;
          systemPrompt += `\n### Git Diff (uncommitted changes)\n\`\`\`diff\n${truncated}\n\`\`\`\n`;
          contextMeta.diff = { diffLines: truncated.split("\n").length, estimatedTokens: estimateTokens(truncated), enabled: true };
        }
      } catch { /* ignore */ }
    }

    if (options.contextSources?.files !== false && projectPath) {
      try {
        const tree = buildFileTree(projectPath, 3);
        if (tree.length > 0) {
          const treeTruncated = tree.slice(0, 100);
          const treeStr = treeTruncated.join("\n");
          systemPrompt += `\n### Project Structure\n${path.basename(projectPath)}/\n${treeStr}\n`;
          contextMeta.files = { fileCount: treeTruncated.length, estimatedTokens: estimateTokens(treeStr), enabled: true };
        }
      } catch { /* ignore */ }
    }

    // Add user message to conversation
    conv.messages.push({ role: "user", content: userMessage, timestamp: new Date().toISOString() });

    // Build messages array for API (only role + content)
    const apiMessages = conv.messages.map((m) => ({ role: m.role, content: m.content }));

    // Start streaming
    this.streaming = true;
    this.currentAbortController = new AbortController();
    let fullText = "";

    try {
      const stream = client.messages.stream({
        model,
        system: systemPrompt,
        messages: apiMessages,
        max_tokens: 4096,
      }, { signal: this.currentAbortController.signal });

      stream.on("text", (text) => {
        fullText += text;
        sendToRenderer("claude-stream-chunk", {
          conversationId: this.activeConversationId,
          chunk: text,
          accumulated: fullText,
        });
      });

      const finalMessage = await stream.finalMessage();
      const usage = finalMessage.usage;

      // Record usage
      const usageResult = this.tokenTracker.recordUsage(
        this.activeConversationId, model,
        usage.input_tokens, usage.output_tokens
      );

      // Add assistant message to conversation
      conv.messages.push({
        role: "assistant",
        content: fullText,
        timestamp: new Date().toISOString(),
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      });

      // Persist conversation
      this._saveConversation(conv);

      sendToRenderer("claude-stream-end", {
        conversationId: this.activeConversationId,
        content: fullText,
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
        cost: usageResult.cost,
        model,
        contextMeta,
      });

      // Check budget
      const budget = settings.apiBudgetMonthly || 0;
      if (budget > 0) {
        const monthly = this.tokenTracker.getMonthlyTotals();
        if (monthly.cost >= budget) {
          sendToRenderer("claude-budget-alert", { level: "exceeded", spent: monthly.cost, limit: budget });
        } else if (monthly.cost >= budget * 0.8) {
          sendToRenderer("claude-budget-alert", { level: "warning", spent: monthly.cost, limit: budget });
        }
      }

      return { success: true };
    } catch (err) {
      if (err.name === "AbortError") {
        // Save partial response if any text was received
        if (fullText.length > 0) {
          conv.messages.push({
            role: "assistant",
            content: fullText,
            timestamp: new Date().toISOString(),
            interrupted: true,
          });
          this._saveConversation(conv);
        }
        sendToRenderer("claude-stream-error", { error: "Stream cancelled", code: "CANCELLED" });
        return { success: false, error: "cancelled" };
      }
      const errMsg = err.status === 401 ? "Invalid API key" :
        err.status === 429 ? "Rate limited — try again in a moment" :
          err.message || "Unknown error";
      sendToRenderer("claude-stream-error", { error: errMsg, code: err.status ? `HTTP_${err.status}` : "UNKNOWN" });
      // Re-create client on auth error
      if (err.status === 401) this._invalidateClient();
      return { success: false, error: errMsg };
    } finally {
      this.streaming = false;
      this.currentAbortController = null;
    }
  }

  stopStream() {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
  }

  _getTerminalBuffer(tabId) {
    // Use API server's rolling buffer if available
    if (apiServer && apiServer.terminalBuffers) {
      const buf = apiServer.terminalBuffers.get(tabId);
      if (buf) return buf.data;
    }
    return null;
  }

  _getGitStatus(projectPath) {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
      }).trim();
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
      }).trim();
      const changedFiles = status ? status.split("\n").length : 0;
      return { branch, changedFiles };
    } catch {
      return null;
    }
  }

  _getGitDiff(projectPath) {
    try {
      return execFileSync("git", ["diff", "-U3"], {
        cwd: projectPath, encoding: "utf-8", timeout: 10000, maxBuffer: 1024 * 1024,
      }) || "(no changes)";
    } catch {
      return null;
    }
  }

  getConversations(projectPath) {
    if (!projectPath) return [];
    const hash = projectHash(projectPath);
    const dir = path.join(CONVERSATIONS_DIR, hash);
    if (!fs.existsSync(dir)) return [];
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
      return files.map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          return {
            id: data.id,
            projectName: data.projectName,
            model: data.model,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messageCount: data.messages?.length || 0,
            firstMessage: data.messages?.[0]?.content?.slice(0, 80) || "",
          };
        } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  loadConversation(conversationId) {
    if (!isValidConversationId(conversationId)) return null;
    // Check in-memory first
    if (this.conversations.has(conversationId)) {
      this.activeConversationId = conversationId;
      return this.conversations.get(conversationId);
    }
    // Search on disk
    try {
      const dirs = fs.readdirSync(CONVERSATIONS_DIR);
      for (const hash of dirs) {
        const filePath = path.join(CONVERSATIONS_DIR, hash, `${conversationId}.json`);
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (!isValidConversationId(data.id)) continue;
          this.conversations.set(data.id, data);
          this.activeConversationId = data.id;
          return data;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  deleteConversation(conversationId) {
    if (!isValidConversationId(conversationId)) return false;
    this.conversations.delete(conversationId);
    if (this.activeConversationId === conversationId) this.activeConversationId = null;
    try {
      const dirs = fs.readdirSync(CONVERSATIONS_DIR);
      for (const hash of dirs) {
        const filePath = path.join(CONVERSATIONS_DIR, hash, `${conversationId}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  _saveConversation(conv) {
    if (!conv.projectPath || !isValidConversationId(conv.id)) return;
    try {
      const hash = projectHash(conv.projectPath);
      const dir = path.join(CONVERSATIONS_DIR, hash);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Cap at 100 messages
      if (conv.messages.length > 100) {
        conv.messages = conv.messages.slice(-100);
      }
      fs.writeFileSync(path.join(dir, `${conv.id}.json`), JSON.stringify(conv, null, 2), { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      console.log("[wotch] Failed to save conversation:", err.message);
    }
  }

  getContextMetadata(tabId, projectPath) {
    const meta = {};
    if (tabId) {
      const termBuf = this._getTerminalBuffer(tabId);
      if (termBuf) {
        const cleaned = stripAnsi(termBuf);
        const lines = cleaned.split("\n");
        meta.terminal = { lineCount: lines.length, estimatedTokens: estimateTokens(cleaned), enabled: true };
      } else {
        meta.terminal = { lineCount: 0, estimatedTokens: 0, enabled: true };
      }
    }
    if (projectPath) {
      const status = this._getGitStatus(projectPath);
      if (status) {
        meta.git = { changedFiles: status.changedFiles, estimatedTokens: 50, enabled: true };
      }
      try {
        const diff = this._getGitDiff(projectPath);
        if (diff && diff !== "(no changes)") {
          meta.diff = { diffLines: diff.split("\n").length, estimatedTokens: estimateTokens(diff), enabled: true };
        }
      } catch { /* ignore */ }
      try {
        const tree = buildFileTree(projectPath, 3);
        meta.files = { fileCount: tree.length, estimatedTokens: estimateTokens(tree.join("\n")), enabled: true };
      } catch { /* ignore */ }
      meta.project = { name: path.basename(projectPath), path: projectPath };
    }
    return meta;
  }
}

let claudeAPIManager = null;

// ── Known hosts for SSH ────────────────────────────────────────────
const KNOWN_HOSTS_FILE = path.join(SETTINGS_DIR, "known_hosts.json");

function loadKnownHosts() {
  try {
    if (fs.existsSync(KNOWN_HOSTS_FILE)) {
      return JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, "utf-8"));
    }
  } catch { /* ignore */ }
  return {};
}

function saveKnownHosts(hosts) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(hosts, null, 2), { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    console.log("[wotch] Failed to save known hosts:", err.message);
  }
}

let mainWindow = null;
let tray = null;
let isExpanded = false;
let isPinned = settings.pinned || false;
let mousePoller = null;
let collapseTimeout = null;
let ptyProcesses = new Map(); // tabId → pty
const sshSessions = new Map(); // tabId → { client, stream, profileId, authMethod, reconnectTimer }
const pendingCredentials = new Map(); // tabId → { resolve, reject }
const pendingHostVerify = new Map(); // tabId → { resolve }

// ── Window positioning ──────────────────────────────────────────────
function getTargetDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return screen.getPrimaryDisplay();
  const idx = Math.min(settings.displayIndex || 0, displays.length - 1);
  return displays[idx];
}

function getTopOffset() {
  if (IS_MAC && !HAS_NOTCH) {
    const display = getTargetDisplay();
    return display.workArea.y - display.bounds.y;
  }
  return 0;
}

function getPillBounds() {
  const display = getTargetDisplay();
  const wa = display.workArea; // { x, y, width, height } — excludes taskbar/menu bar
  const pos = settings.position || "top";

  if (pos === "left") {
    return {
      x: wa.x,
      y: wa.y + Math.round((wa.height - settings.pillWidth) / 2),
      width: settings.pillHeight,
      height: settings.pillWidth,
    };
  }
  if (pos === "right") {
    return {
      x: wa.x + wa.width - settings.pillHeight,
      y: wa.y + Math.round((wa.height - settings.pillWidth) / 2),
      width: settings.pillHeight,
      height: settings.pillWidth,
    };
  }
  // "top" (default)
  const yOffset = getTopOffset();
  return {
    x: wa.x + Math.round((wa.width - settings.pillWidth) / 2),
    y: display.bounds.y + yOffset,
    width: settings.pillWidth,
    height: settings.pillHeight,
  };
}

function getExpandedBounds() {
  const display = getTargetDisplay();
  const wa = display.workArea;
  const pos = settings.position || "top";

  if (pos === "left") {
    const clampedH = Math.min(settings.expandedHeight, wa.height);
    const clampedW = Math.min(settings.expandedWidth, wa.width);
    return {
      x: wa.x,
      y: wa.y + Math.round((wa.height - clampedH) / 2),
      width: clampedW,
      height: clampedH,
    };
  }
  if (pos === "right") {
    const clampedH = Math.min(settings.expandedHeight, wa.height);
    const clampedW = Math.min(settings.expandedWidth, wa.width);
    return {
      x: wa.x + wa.width - clampedW,
      y: wa.y + Math.round((wa.height - clampedH) / 2),
      width: clampedW,
      height: clampedH,
    };
  }
  // "top" (default)
  const yOffset = getTopOffset();
  return {
    x: wa.x + Math.round((wa.width - settings.expandedWidth) / 2),
    y: display.bounds.y + yOffset,
    width: settings.expandedWidth,
    height: settings.expandedHeight,
  };
}

// ── Create window ───────────────────────────────────────────────────
function getAlwaysOnTopLevel() {
  // Wayland compositors don't support "screen-saver" level well.
  // "floating" is the safest cross-platform option on Linux.
  // On Windows/macOS "screen-saver" keeps it above fullscreen apps.
  if (WAYLAND) return "floating";
  if (IS_LINUX) return "floating";
  return "screen-saver";
}

function createWindow() {
  const pill = getPillBounds();

  const windowOpts = {
    x: pill.x,
    y: pill.y,
    width: pill.width,
    height: pill.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: !WAYLAND, // Wayland compositors handle shadows themselves
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  // On Linux, set the window type hint so the WM treats it as a panel/dock.
  // This helps with always-on-top, prevents it from appearing in alt-tab,
  // and avoids Wayland compositors applying unwanted decorations.
  if (IS_LINUX) {
    windowOpts.type = "dock";
  }

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Prevent the window from being moved
  mainWindow.setMovable(false);

  // Set always-on-top with the right level for the platform
  mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel());

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.webContents.send("position-changed", settings.position || "top");
    startMouseTracking();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    stopMouseTracking();
  });

  // Re-assert always-on-top on blur (some WMs will demote it)
  mainWindow.on("blur", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel());
    }
  });
}

// ── Expand / Collapse ───────────────────────────────────────────────
function expand() {
  if (isExpanded || !mainWindow) return;
  isExpanded = true;

  if (collapseTimeout) {
    clearTimeout(collapseTimeout);
    collapseTimeout = null;
  }

  const bounds = getExpandedBounds();
  mainWindow.setBounds(bounds, true);
  mainWindow.webContents.send("expansion-state", { expanded: true, pinned: isPinned });
}

function collapse() {
  if (!isExpanded || !mainWindow) return;
  // Don't collapse if pinned (hover-triggered collapse is blocked)
  if (isPinned) return;

  collapseTimeout = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { collapseTimeout = null; return; }
    isExpanded = false;
    const bounds = getPillBounds();
    mainWindow.setBounds(bounds, true);
    mainWindow.webContents.send("expansion-state", { expanded: false, pinned: isPinned });
    collapseTimeout = null;
  }, settings.collapseDelay);
}

function toggle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Toggle always works, even when pinned
  if (isExpanded) {
    if (collapseTimeout) clearTimeout(collapseTimeout);
    isExpanded = false;
    const bounds = getPillBounds();
    mainWindow.setBounds(bounds, true);
    mainWindow.webContents.send("expansion-state", { expanded: false, pinned: isPinned });
  } else {
    expand();
  }
}

function setPinned(pinned) {
  isPinned = pinned;
  settings.pinned = pinned;
  saveSettings(settings);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pin-state", isPinned);
  }
  // If we just pinned and aren't expanded, expand
  if (isPinned && !isExpanded) {
    expand();
  }
}

// ── Mouse tracking for hover-to-reveal ──────────────────────────────
// On Wayland, screen.getCursorScreenPoint() may return {x:0, y:0}
// because Wayland doesn't expose global cursor position to apps.
// We use a fallback: if we detect Wayland and cursor always reports 0,0,
// we rely solely on the global hotkey for toggling.
let waylandCursorBroken = false;
let cursorCheckCount = 0;

function startMouseTracking() {
  mousePoller = setInterval(() => {
    if (!mainWindow) return;

    const mousePos = screen.getCursorScreenPoint();

    // Detect if Wayland is blocking cursor position
    if (WAYLAND && cursorCheckCount < 20) {
      cursorCheckCount++;
      if (mousePos.x === 0 && mousePos.y === 0) {
        if (cursorCheckCount >= 10) {
          waylandCursorBroken = true;
          console.log("[wotch] Wayland: global cursor position unavailable, using hotkey-only mode");
          clearInterval(mousePoller);
          mousePoller = null;
          return;
        }
      } else {
        // Got a real position, cursor tracking works (XWayland or compatible compositor)
        cursorCheckCount = 20; // stop checking
      }
    }

    if (waylandCursorBroken) return;

    const winBounds = mainWindow.getBounds();

    // Check if mouse is within the window bounds + padding.
    // Edge-slam: extend detection to the target display edge for the anchor side.
    const pad = settings.hoverPadding;
    const pos = settings.position || "top";
    const display = getTargetDisplay();

    let inZoneX, inZoneY;

    if (pos === "left") {
      // Extend left edge to display boundary for slam-to-left activation
      inZoneX =
        mousePos.x >= display.bounds.x &&
        mousePos.x <= winBounds.x + winBounds.width + pad;
      inZoneY =
        mousePos.y >= winBounds.y - pad &&
        mousePos.y <= winBounds.y + winBounds.height + pad;
    } else if (pos === "right") {
      // Extend right edge to physical display boundary for slam-to-right activation
      const screenRight = display.bounds.x + display.bounds.width;
      inZoneX =
        mousePos.x >= winBounds.x - pad &&
        mousePos.x <= screenRight;
      inZoneY =
        mousePos.y >= winBounds.y - pad &&
        mousePos.y <= winBounds.y + winBounds.height + pad;
    } else {
      // "top" — extend to display top edge for slam-up activation
      const screenTop = display.bounds.y;
      inZoneX =
        mousePos.x >= winBounds.x - pad &&
        mousePos.x <= winBounds.x + winBounds.width + pad;
      inZoneY =
        mousePos.y >= Math.max(screenTop, winBounds.y - pad) &&
        mousePos.y <= winBounds.y + winBounds.height + pad;
    }

    const inZone = inZoneX && inZoneY;

    if (inZone && !isExpanded) {
      expand();
    } else if (!inZone && isExpanded && !isPinned) {
      collapse();
    } else if (inZone && collapseTimeout) {
      // Cancel pending collapse if mouse re-entered
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
  }, settings.mousePollingMs);
}

function stopMouseTracking() {
  if (mousePoller) {
    clearInterval(mousePoller);
    mousePoller = null;
  }
}

// ── PTY management ──────────────────────────────────────────────────
function createPty(tabId, cwd) {
  let shell;
  if (settings.defaultShell) {
    shell = settings.defaultShell;
  } else if (IS_WIN) {
    shell = "powershell.exe";
  } else if (IS_MAC) {
    shell = process.env.SHELL || "/bin/zsh";
  } else {
    shell = process.env.SHELL || "/bin/bash";
  }
  const startDir = cwd || os.homedir();

  const ptyProc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: startDir,
    env: { ...process.env, TERM: "xterm-256color", WOTCH_TAB_ID: tabId },
  });

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-data", { tabId, data });
    }
    // Feed data to status detector
    claudeStatus.feed(tabId, data);
    // Feed to API server terminal buffer + broadcast
    if (apiServer && apiServer.running) {
      apiServer.addTerminalData(tabId, data);
      apiServer.broadcastEvent("terminal:output", { tabId, output: data, format: "raw" });
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-exit", { tabId, exitCode });
    }
    ptyProcesses.delete(tabId);
    claudeStatus.removeTab(tabId);
    integrationManager.removeTab(tabId);
    // API: broadcast tab closed + clean up buffer
    if (apiServer && apiServer.running) {
      apiServer.broadcastEvent("tab:lifecycle", { action: "closed", tabId, tabType: "pty", exitCode });
      apiServer.removeTerminalBuffer(tabId);
    }
  });

  ptyProcesses.set(tabId, ptyProc);
  claudeStatus.addTab(tabId);
  integrationManager.addTab(tabId, startDir);
  // API: broadcast tab created
  if (apiServer && apiServer.running) {
    apiServer.broadcastEvent("tab:lifecycle", { action: "created", tabId, tabType: "pty", cwd: startDir });
  }
  return tabId;
}

// ── SSH session management ─────────────────────────────────────────

function sendToTab(tabId, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pty-data", { tabId, data: text });
  }
}

function requestCredential(tabId, type, prompt) {
  return new Promise((resolve, reject) => {
    pendingCredentials.set(tabId, { resolve, reject });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ssh-credential-request", { tabId, type, prompt });
    } else {
      reject(new Error("Window not available"));
    }
  });
}

function requestHostVerify(tabId, host, port, fingerprint, isChanged) {
  return new Promise((resolve) => {
    pendingHostVerify.set(tabId, { resolve });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ssh-host-verify", { tabId, host, port, fingerprint, isChanged });
    } else {
      resolve(false);
    }
  });
}

async function createSshSession(tabId, profileId, password, reconnectAttempts = 0) {
  const profile = (settings.sshProfiles || []).find((p) => p.id === profileId);
  if (!profile) throw new Error("SSH profile not found");

  const client = new SSHClient();
  const hostKey = `${profile.host}:${profile.port}`;

  // Build connection options
  const connectOpts = {
    host: profile.host,
    port: profile.port || 22,
    username: profile.username,
    readyTimeout: 10000,
  };

  // Auth setup
  if (profile.authMethod === "key") {
    // Validate keyPath: reject traversal, verify it's a regular file of reasonable size
    if (!profile.keyPath || typeof profile.keyPath !== "string") {
      throw new Error("Key path is required");
    }
    if (profile.keyPath.includes("..")) {
      throw new Error("Invalid key path: directory traversal not allowed");
    }
    const resolvedKey = path.resolve(profile.keyPath);
    try {
      const stat = fs.statSync(resolvedKey);
      if (!stat.isFile()) throw new Error("Key path is not a regular file");
      if (stat.size > 32768) throw new Error("File too large to be an SSH key (max 32KB)");
      connectOpts.privateKey = fs.readFileSync(resolvedKey, "utf-8");
    } catch (err) {
      throw new Error(`Failed to read key file: ${err.message}`);
    }
  } else {
    if (!password) throw new Error("Password required");
    connectOpts.password = password;
  }

  return new Promise((resolve, reject) => {
    let resolved = false;

    // Host key verification — MUST use callback pattern (key, verify) => {}
    // An async function returns a Promise (truthy), which ssh2 treats as verify(true),
    // auto-accepting all host keys. Use verify() callback instead.
    connectOpts.hostVerifier = (key, verify) => {
      const fingerprint = "SHA256:" + crypto.createHash("sha256").update(key).digest("base64");
      const knownHosts = loadKnownHosts();

      // Check stored fingerprint — also accept old entries without prefix and migrate them
      const storedFp = knownHosts[hostKey];
      if (storedFp === fingerprint || storedFp === fingerprint.slice(7)) {
        if (storedFp !== fingerprint) {
          knownHosts[hostKey] = fingerprint;
          saveKnownHosts(knownHosts);
        }
        verify(true);
        return;
      }

      const isChanged = hostKey in knownHosts;
      requestHostVerify(tabId, profile.host, profile.port, fingerprint, isChanged).then((accepted) => {
        if (accepted) {
          knownHosts[hostKey] = fingerprint;
          saveKnownHosts(knownHosts);
        }
        verify(accepted);
      });
    };

    client.on("ready", () => {
      client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          client.end();
          if (!resolved) { resolved = true; reject(err); }
          return;
        }

        stream.on("data", (data) => {
          const str = data.toString();
          sendToTab(tabId, str);
          claudeStatus.feed(tabId, str);
          // API: buffer + broadcast
          if (apiServer && apiServer.running) {
            apiServer.addTerminalData(tabId, str);
            apiServer.broadcastEvent("terminal:output", { tabId, output: str, format: "raw" });
          }
        });

        stream.on("close", () => {
          sendToTab(tabId, "\r\n\x1b[90m── SSH session closed ──\x1b[0m\r\n");

          const session = sshSessions.get(tabId);
          if (session && session.authMethod === "key" && !session.userKilled) {
            const attempt = reconnectAttempts + 1;
            if (attempt > 5) {
              sendToTab(tabId, "\x1b[31mSSH reconnect failed after 5 attempts. Open a new SSH tab to retry.\x1b[0m\r\n");
              sshSessions.delete(tabId);
              claudeStatus.removeTab(tabId);
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("pty-exit", { tabId, exitCode: 1 });
              }
            } else {
              const delay = Math.min(3000 * Math.pow(2, attempt - 1), 30000);
              sendToTab(tabId, `\x1b[33mSSH connection lost. Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}/5)...\x1b[0m\r\n`);
              session.reconnectTimer = setTimeout(async () => {
                try {
                  sshSessions.delete(tabId);
                  claudeStatus.removeTab(tabId);
                  await createSshSession(tabId, profileId, null, attempt);
                } catch (e) {
                  sendToTab(tabId, `\x1b[31mReconnect failed: ${e.message}\x1b[0m\r\n`);
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("pty-exit", { tabId, exitCode: 1 });
                  }
                }
              }, delay);
            }
          } else if (session && session.authMethod === "password" && !session.userKilled) {
            // Password-auth: can't auto-reconnect (password was discarded)
            sendToTab(tabId, "\x1b[33mSSH connection lost. Open a new SSH tab to reconnect.\x1b[0m\r\n");
            sshSessions.delete(tabId);
            claudeStatus.removeTab(tabId);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("pty-exit", { tabId, exitCode: 0 });
            }
          } else {
            // User-killed or no session — final cleanup
            sshSessions.delete(tabId);
            claudeStatus.removeTab(tabId);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("pty-exit", { tabId, exitCode: 0 });
            }
          }
        });

        sshSessions.set(tabId, {
          client,
          stream,
          profileId,
          authMethod: profile.authMethod,
          reconnectTimer: null,
          userKilled: false,
        });
        claudeStatus.addTab(tabId);

        if (!resolved) { resolved = true; resolve({ tabId, type: "ssh" }); }
      });
    });

    client.on("error", (err) => {
      sendToTab(tabId, `\x1b[31mSSH Error: ${err.message}\x1b[0m\r\n`);
      // Clean up pending credential/host-verify promises for this tab
      const pc = pendingCredentials.get(tabId);
      if (pc) { pc.reject(err); pendingCredentials.delete(tabId); }
      const ph = pendingHostVerify.get(tabId);
      if (ph) { ph.resolve(false); pendingHostVerify.delete(tabId); }
      if (!resolved) { resolved = true; reject(err); }
    });

    // Handle passphrase prompt for encrypted keys
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      (async () => {
        const responses = [];
        for (const prompt of prompts) {
          const credential = await requestCredential(tabId, "passphrase", prompt.prompt);
          responses.push(credential || "");
        }
        finish(responses);
      })().catch((err) => {
        sendToTab(tabId, `\x1b[31mKeyboard-interactive auth failed: ${err.message}\x1b[0m\r\n`);
        finish([]);
      });
    });

    client.connect(connectOpts);
  });
}

// ── Claude Code Status Detection ────────────────────────────────────
// Parses terminal output to detect Claude Code's state and generate
// short descriptions of what it's doing.
//
// States: idle, thinking, working, waiting, done, error
//
class ClaudeStatusDetector {
  constructor() {
    this.tabs = new Map(); // tabId → { state, description, buffer, lastActivity, claudeActive }
    this.previousStates = new Map(); // tabId → previous state
    this.broadcastTimer = null;
  }

  addTab(tabId) {
    this.tabs.set(tabId, {
      state: "idle",
      description: "",
      buffer: "",         // rolling buffer of recent clean text
      lastActivity: 0,
      claudeActive: false,
      recentFiles: [],
      recentTools: [],
    });
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  // Strip ANSI escape codes to get clean text
  stripAnsi(str) {
    return str.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
      ""
    ).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // strip other control chars
  }

  feed(tabId, rawData) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const clean = this.stripAnsi(rawData);
    tab.lastActivity = Date.now();

    // Append to rolling buffer, keep last ~2000 chars
    tab.buffer += clean;
    if (tab.buffer.length > 2000) {
      tab.buffer = tab.buffer.slice(-2000);
    }

    // ── Detect if Claude Code session is active ──
    // Claude Code shows distinctive patterns when launched
    if (!tab.claudeActive) {
      if (
        /claude\s/i.test(clean) ||
        /╭─/u.test(clean) ||
        /Claude Code/i.test(clean) ||
        /claude\.ai/i.test(clean)
      ) {
        tab.claudeActive = true;
      }
    }

    if (!tab.claudeActive) {
      tab.state = "idle";
      tab.description = "";
      this.broadcast();
      return;
    }

    // ── Pattern matching for state detection ──
    const prevState = tab.state;
    const prevDesc = tab.description;

    // Check for spinner characters (braille spinner used by many CLI tools)
    const hasSpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/u.test(rawData);

    // Check for Claude Code specific patterns
    const patterns = {
      // Thinking / Processing
      thinking: [
        /thinking/i,
        /processing/i,
        /analyzing/i,
        /understanding/i,
        /planning/i,
        /reasoning/i,
      ],
      // Tool use — reading, writing, executing
      toolUse: [
        /(?:Read|Reading)\s+(.{1,60})/i,
        /(?:Write|Writing)\s+(.{1,60})/i,
        /(?:Edit|Editing)\s+(.{1,60})/i,
        /(?:Update|Updating)\s+(.{1,60})/i,
        /(?:Create|Creating)\s+(.{1,60})/i,
        /(?:Delete|Deleting)\s+(.{1,60})/i,
        /(?:Search|Searching)\s+(.{1,60})/i,
        /(?:Replace|Replacing)\s+(.{1,60})/i,
        /(?:Run|Running|Execute|Executing)\s+(.{1,60})/i,
        /(?:Install|Installing)\s+(.{1,60})/i,
        /(?:Compile|Compiling|Build|Building)\s+(.{1,60})/i,
        /(?:Test|Testing)\s+(.{1,60})/i,
      ],
      // File paths in output
      filePaths: [
        /([a-zA-Z0-9_\-/.]+\.(ts|js|py|rs|go|jsx|tsx|css|html|json|toml|yaml|yml|md|txt|c|cpp|h|java|rb|php|swift|kt|sh|sql))\b/,
      ],
      // Waiting for user input
      waiting: [
        /\?\s*$/,
        /would you like/i,
        /do you want/i,
        /shall I/i,
        /should I/i,
        /choose|select|pick/i,
        /\(y\/n\)/i,
        /\[Y\/n\]/i,
        /approve|accept|reject|deny/i,
      ],
      // Done / Success
      done: [
        /[✓✔]\s*(.{0,60})/u,
        /(?:Done|Complete|Finished|Success|Applied)\b/i,
        /changes applied/i,
        /wrote \d+ file/i,
        /updated \d+ file/i,
      ],
      // Error
      error: [
        /[✗✘×]\s*(.{0,60})/u,
        /(?:Error|Failed|Failure)\b/i,
        /command failed/i,
        /permission denied/i,
        /not found/i,
      ],
      // Shell prompt (back to idle)
      prompt: [
        /[❯➜→▶\$#%]\s*$/,
        /^\s*\$\s*$/m,
      ],
    };

    // Priority-based state detection (check recent chunk)
    const recentClean = tab.buffer.slice(-500);

    // 1. Check for errors
    for (const re of patterns.error) {
      const m = clean.match(re);
      if (m) {
        tab.state = "error";
        tab.description = this.extractDescription(m, clean, "Error");
        break;
      }
    }

    // 2. Check for completion
    if (tab.state !== "error") {
      for (const re of patterns.done) {
        const m = clean.match(re);
        if (m) {
          tab.state = "done";
          tab.description = this.extractDescription(m, clean, "Done");
          break;
        }
      }
    }

    // 3. Check for waiting on user
    if (tab.state !== "error" && tab.state !== "done") {
      for (const re of patterns.waiting) {
        if (re.test(clean)) {
          tab.state = "waiting";
          tab.description = "Waiting for input";
          break;
        }
      }
    }

    // 4. Check for tool use (file operations, commands)
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting") {
      for (const re of patterns.toolUse) {
        const m = clean.match(re);
        if (m) {
          tab.state = "working";
          const target = (m[1] || "").trim();
          // Extract just the filename from path
          const shortTarget = target.includes("/") ? target.split("/").pop() : target;
          tab.description = shortTarget ? `Working on ${shortTarget.slice(0, 40)}` : "Working...";
          // Track recent files
          if (shortTarget && !tab.recentFiles.includes(shortTarget)) {
            tab.recentFiles.push(shortTarget);
            if (tab.recentFiles.length > 5) tab.recentFiles.shift();
          }
          break;
        }
      }
    }

    // 5. Check for file paths (secondary working indicator)
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting" && tab.state !== "working") {
      for (const re of patterns.filePaths) {
        const m = clean.match(re);
        if (m) {
          const fileName = m[1].split("/").pop();
          if (fileName && fileName.length > 2) {
            tab.state = "working";
            tab.description = `Touching ${fileName}`;
            if (!tab.recentFiles.includes(fileName)) {
              tab.recentFiles.push(fileName);
              if (tab.recentFiles.length > 5) tab.recentFiles.shift();
            }
          }
          break;
        }
      }
    }

    // 6. Check for thinking/spinner
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting" && tab.state !== "working") {
      if (hasSpinner) {
        tab.state = "thinking";
        tab.description = tab.description || "Thinking...";
      } else {
        for (const re of patterns.thinking) {
          if (re.test(clean)) {
            tab.state = "thinking";
            tab.description = "Thinking...";
            break;
          }
        }
      }
    }

    // 7. Shell prompt → back to idle (only if no other activity)
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting" &&
        tab.state !== "working" && tab.state !== "thinking") {
      for (const re of patterns.prompt) {
        if (re.test(clean)) {
          tab.state = "idle";
          tab.description = tab.claudeActive ? "Ready" : "";
          break;
        }
      }
    }

    // Generate richer descriptions based on accumulated context
    if (tab.state === "working" && tab.recentFiles.length > 1) {
      const count = tab.recentFiles.length;
      const latest = tab.recentFiles[tab.recentFiles.length - 1];
      tab.description = `Editing ${count} files (${latest})`;
    }

    // Only broadcast if something changed
    if (tab.state !== prevState || tab.description !== prevDesc) {
      this.broadcast();
      // Feed into the enhanced integration detector as the regex source
      integrationManager.feedRegex(tabId, tab.state, tab.description);
    }
  }

  extractDescription(match, clean, fallback) {
    // Try to get a meaningful snippet from the match
    if (match[1] && match[1].trim().length > 2) {
      return match[1].trim().slice(0, 50);
    }
    // Try to get context from surrounding text
    const words = clean.trim().split(/\s+/).slice(0, 8).join(" ");
    return words.length > 3 ? words.slice(0, 50) : fallback;
  }

  // Get the "most interesting" status across all tabs
  getAggregateStatus() {
    const priority = { error: 6, working: 5, thinking: 4, waiting: 2, done: 1, idle: 0 };
    let best = { state: "idle", description: "", tabId: null };

    for (const [tabId, tab] of this.tabs) {
      const p = priority[tab.state] || 0;
      const bestP = priority[best.state] || 0;
      if (p > bestP || (p === bestP && tab.lastActivity > (this.tabs.get(best.tabId)?.lastActivity || 0))) {
        best = { state: tab.state, description: tab.description, tabId };
      }
    }

    return best;
  }

  getTabStatus(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { state: "idle", description: "" };
    return { state: tab.state, description: tab.description };
  }

  broadcast() {
    // Debounce broadcasts to avoid flooding
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;

      // Check for done/error transitions → fire notification
      for (const [tabId, tab] of this.tabs) {
        const prev = this.previousStates.get(tabId) || "idle";
        if ((prev === "thinking" || prev === "working") &&
            (tab.state === "done" || tab.state === "error")) {
          if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
            try {
              const notif = new Notification({
                title: "Wotch",
                body: tab.state === "error"
                  ? `Claude error: ${tab.description || "Unknown"}`
                  : `Claude finished: ${tab.description || "Task complete"}`,
                silent: false,
              });
              notif.show();
            } catch { /* notifications may not be available */ }
          }
        }
        this.previousStates.set(tabId, tab.state);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        const aggregate = this.getAggregateStatus();
        const perTab = {};
        for (const [tabId, tab] of this.tabs) {
          perTab[tabId] = { state: tab.state, description: tab.description };
        }
        mainWindow.webContents.send("claude-status", { aggregate, perTab });
      }
    }, 150);
  }
}

const claudeStatus = new ClaudeStatusDetector();

// ── Integration Manager ────────────────────────────────────────────
const integrationManager = new ClaudeIntegrationManager({
  hooksEnabled: settings.integrationHooksEnabled,
  hooksPort: settings.integrationHooksPort,
  mcpEnabled: settings.integrationMcpEnabled,
  mcpIpcPort: settings.integrationMcpIpcPort,
  autoConfigureHooks: settings.integrationAutoConfigureHooks,
  autoRegisterMCP: settings.integrationAutoRegisterMCP,
});

// Wire the enhanced detector's status-changed events to renderer + API broadcast
integrationManager.on("status-changed", (tabId, status) => {
  const aggregate = integrationManager.getAggregateStatus();
  const perTab = {};
  for (const [tid] of integrationManager.statusDetector.tabs) {
    perTab[tid] = integrationManager.getStatus(tid);
  }
  // Renderer broadcast
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("claude-status", { aggregate, perTab });
  }
  // API WebSocket broadcast
  if (apiServer && apiServer.running) {
    apiServer.broadcastEvent("claude:status", { aggregate, tabs: perTab });
  }
});

// Wire notification events from hooks
integrationManager.on("notification", (event) => {
  if (Notification.isSupported()) {
    try {
      const notif = new Notification({
        title: "Claude Code",
        body: event.notification_type || "Notification",
        silent: false,
      });
      notif.show();
    } catch { /* notifications may not be available */ }
  }
});

// ── API Server ────────────────────────────────────────────────────
let apiServer = null;

function createApiServer() {
  apiServer = new ApiServer({
    ptyProcesses,
    sshSessions,
    integrationManager,
    mainWindow: () => mainWindow,
    createPty,
    killTab: (tabId) => {
      const p = ptyProcesses.get(tabId);
      if (p) { p.kill(); ptyProcesses.delete(tabId); }
      const s = sshSessions.get(tabId);
      if (s) {
        s.userKilled = true;
        if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
        if (s.stream) s.stream.close();
        if (s.client) s.client.end();
        sshSessions.delete(tabId);
      }
      claudeStatus.removeTab(tabId);
      integrationManager.removeTab(tabId);
    },
    writePty: (tabId, data) => {
      const p = ptyProcesses.get(tabId);
      if (p) { p.write(data); return; }
      const s = sshSessions.get(tabId);
      if (s && s.stream) s.stream.write(data);
    },
    detectProjects,
    gitCheckpoint: (projectPath, message) => {
      if (!isKnownProjectPath(projectPath)) return { success: false, message: "Unknown project path" };
      return gitCheckpoint(projectPath, message);
    },
    gitGetStatus: (projectPath) => {
      if (!isKnownProjectPath(projectPath)) return null;
      return gitGetStatus(projectPath);
    },
    gitListCheckpoints: (projectPath, limit) => {
      if (!isKnownProjectPath(projectPath)) return { projectPath, checkpoints: [], totalCount: 0 };
      return gitListCheckpoints(projectPath, limit);
    },
    gitDiff: (projectPath, mode) => {
      if (!isKnownProjectPath(projectPath)) return "Unknown project path";
      return gitDiffForApi(projectPath, mode);
    },
    loadSettings: () => ({ ...settings }),
    saveSettingsFn: (newSettings, source) => {
      const prev = { ...settings };
      for (const key of ALLOWED_SETTING_KEYS) {
        if (key in newSettings) settings[key] = newSettings[key];
      }
      saveSettings(settings);

      // Broadcast settings change
      if (apiServer) {
        const changed = {};
        for (const key of Object.keys(newSettings)) {
          if (key !== "sshProfiles") changed[key] = newSettings[key];
        }
        apiServer.broadcastEvent("settings:changed", { changed, source: source || "api" });
      }

      // Reposition window if needed
      const positionChanged = prev.position !== settings.position;
      if (positionChanged && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
        mainWindow.webContents.send("position-changed", settings.position || "top");
      } else if (isExpanded && mainWindow && (
        prev.expandedWidth !== settings.expandedWidth ||
        prev.expandedHeight !== settings.expandedHeight
      )) {
        mainWindow.setBounds(getExpandedBounds(), true);
      }
    },
    resetSettingsFn: () => {
      const preservedProfiles = settings.sshProfiles;
      settings = { ...DEFAULT_SETTINGS };
      settings.sshProfiles = preservedProfiles;
      saveSettings(settings);
      isPinned = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
        mainWindow.webContents.send("pin-state", false);
        mainWindow.webContents.send("position-changed", settings.position || "top");
      }
      return { ...settings };
    },
    setPinned,
    getExpansionState: () => ({ expanded: isExpanded, pinned: isPinned }),
    getPlatformInfo: () => ({
      platform: os.platform(),
      isMac: IS_MAC,
      isWayland: WAYLAND,
      waylandCursorBroken,
      hasNotch: HAS_NOTCH,
    }),
  });
}

// Also detect idle timeout — if no output for 5s while in thinking/working, might be done
const idleCheckInterval = setInterval(() => {
  const now = Date.now();
  for (const [tabId, tab] of claudeStatus.tabs) {
    if ((tab.state === "thinking" || tab.state === "working") && now - tab.lastActivity > 5000) {
      // Likely finished — transition to idle/done
      tab.state = "idle";
      tab.description = "Ready";
      claudeStatus.broadcast();
    }
    // Clear "done" state after 8 seconds
    if (tab.state === "done" && now - tab.lastActivity > 8000) {
      tab.state = "idle";
      tab.description = "Ready";
      claudeStatus.broadcast();
    }
    // Clear "error" state after 10 seconds
    if (tab.state === "error" && now - tab.lastActivity > 10000) {
      tab.state = "idle";
      tab.description = "Ready";
      claudeStatus.broadcast();
    }
  }
}, 2000);

// ── Project Detection ───────────────────────────────────────────────
const PROJECT_MARKERS = [
  // Git
  ".git",
  // Node / JS
  "package.json",
  // Python
  "pyproject.toml", "setup.py", "requirements.txt",
  // Rust
  "Cargo.toml",
  // Go
  "go.mod",
  // .NET / C#
  "*.sln", "*.csproj",
  // Java
  "pom.xml", "build.gradle",
  // General
  "Makefile", "CMakeLists.txt", "Dockerfile",
];

// Check if a directory looks like a project root
function isProjectDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath);
    return PROJECT_MARKERS.some((marker) => {
      if (marker.startsWith("*")) {
        const ext = marker.slice(1);
        return entries.some((e) => e.endsWith(ext));
      }
      return entries.includes(marker);
    });
  } catch {
    return false;
  }
}

// Detect projects from VS Code recently-opened or running instances
function detectProjects() {
  const projects = [];

  // Strategy 1: Check VS Code's recently opened workspaces (Windows)
  if (IS_WIN) {
    const storagePath = path.join(
      os.homedir(),
      "AppData", "Roaming", "Code", "User", "globalStorage", "storage.json"
    );
    try {
      const data = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
      const recent = data.openedPathsList?.workspaces3 || data.openedPathsList?.entries || [];
      for (const entry of recent.slice(0, 20)) {
        const p = typeof entry === "string" ? entry : entry.folderUri || entry.configPath || "";
        const folderPath = p.replace("file:///", "").replace(/\//g, path.sep);
        if (folderPath && fs.existsSync(folderPath) && isProjectDir(folderPath)) {
          projects.push({
            name: path.basename(folderPath),
            path: folderPath,
            source: "vscode-recent",
          });
        }
      }
    } catch { /* no VS Code storage found */ }
  }

  // Strategy 2: Check VS Code's recently opened (macOS/Linux)
  if (!IS_WIN) {
    const storagePaths = [
      // Standard VS Code on Linux
      path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "storage.json"),
      // VS Code OSS (Arch, etc.)
      path.join(os.homedir(), ".config", "Code - OSS", "User", "globalStorage", "storage.json"),
      // VSCodium
      path.join(os.homedir(), ".config", "VSCodium", "User", "globalStorage", "storage.json"),
      // Flatpak VS Code
      path.join(os.homedir(), ".var", "app", "com.visualstudio.code", "config", "Code", "User", "globalStorage", "storage.json"),
      // Snap VS Code
      path.join(os.homedir(), "snap", "code", "current", ".config", "Code", "User", "globalStorage", "storage.json"),
      // macOS
      path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "storage.json"),
    ];
    for (const storagePath of storagePaths) {
      try {
        const data = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
        const recent = data.openedPathsList?.workspaces3 || data.openedPathsList?.entries || [];
        for (const entry of recent.slice(0, 20)) {
          const p = typeof entry === "string" ? entry : entry.folderUri || entry.configPath || "";
          const folderPath = p.replace("file://", "");
          if (folderPath && fs.existsSync(folderPath) && isProjectDir(folderPath)) {
            projects.push({
              name: path.basename(folderPath),
              path: folderPath,
              source: "vscode-recent",
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  // Strategy 3: Try to detect running VS Code instances via CLI
  try {
    let cmd;
    if (IS_WIN) {
      cmd = 'wmic process where "name like \'%Code%\'" get CommandLine /format:list 2>nul';
    } else if (IS_MAC) {
      // macOS ps doesn't have -oP, use perl for regex
      cmd = "ps aux | grep '[C]ode' | perl -nle 'print $1 if /--folder-uri=(\\S+)/'";
    } else {
      // Linux — try grep -oP first (GNU grep), fall back to perl
      cmd = "ps aux | grep '[C]ode' | grep -oP '(?<=--folder-uri=)\\S+' 2>/dev/null || ps aux | grep '[C]ode' | perl -nle 'print $1 if /--folder-uri=(\\S+)/' 2>/dev/null";
    }
    const output = execSync(cmd, { encoding: "utf-8", timeout: 3000 });

    // Parse folder URIs from output
    let folderUris = [];
    if (IS_WIN) {
      folderUris = output.match(/--folder-uri[= ]file:\/\/\/([^\s"]+)/g) || [];
    } else {
      // On Unix, the grep/perl output gives us the raw URIs line by line
      const lines = output.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const uri = line.replace(/^--folder-uri=/, "").trim();
        if (uri.startsWith("file://")) {
          folderUris.push(uri);
        } else if (uri.startsWith("/")) {
          // Already a path
          folderUris.push("file://" + uri);
        }
      }
    }

    for (const raw of folderUris) {
      const cleaned = raw
        .replace(/--folder-uri[= ]/, "")
        .replace(/^file:\/\//, "")     // Unix: file:///path → /path
        .replace(/^\/([A-Z]:)/, "$1"); // Windows: /C: → C:
      const folderPath = decodeURIComponent(cleaned);
      if (fs.existsSync(folderPath) && isProjectDir(folderPath)) {
        projects.push({
          name: path.basename(folderPath),
          path: folderPath,
          source: "vscode-running",
        });
      }
    }
  } catch { /* process scan failed */ }

  // Strategy 3b: JetBrains IDEs (IntelliJ, PyCharm, WebStorm, etc.)
  try {
    const jetbrainsConfigDirs = [];
    if (IS_WIN) {
      const appData = path.join(os.homedir(), "AppData", "Roaming", "JetBrains");
      if (fs.existsSync(appData)) jetbrainsConfigDirs.push(appData);
    } else if (IS_MAC) {
      const libDir = path.join(os.homedir(), "Library", "Application Support", "JetBrains");
      if (fs.existsSync(libDir)) jetbrainsConfigDirs.push(libDir);
    } else {
      const configDir = path.join(os.homedir(), ".config", "JetBrains");
      if (fs.existsSync(configDir)) jetbrainsConfigDirs.push(configDir);
    }

    for (const jbDir of jetbrainsConfigDirs) {
      try {
        // Each IDE version has its own folder (e.g., IntelliJIdea2024.1)
        const ideVersions = fs.readdirSync(jbDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const ideVer of ideVersions) {
          const recentPath = path.join(jbDir, ideVer, "options", "recentProjects.xml");
          if (!fs.existsSync(recentPath)) continue;
          try {
            const xml = fs.readFileSync(recentPath, "utf-8");
            // Extract project paths from the XML — they appear as key="$USER_HOME$/path" or key="/absolute/path"
            const pathMatches = xml.match(/key="([^"]+)"/g) || [];
            for (const raw of pathMatches.slice(0, 10)) {
              let projPath = raw.replace('key="', "").replace('"', "")
                .replace("$USER_HOME$", os.homedir());
              if (IS_WIN) projPath = projPath.replace(/\//g, path.sep);
              if (fs.existsSync(projPath) && isProjectDir(projPath)) {
                const ideName = ideVer.replace(/\d{4}\.\d.*/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
                if (!projects.some((p) => p.path === projPath)) {
                  projects.push({
                    name: path.basename(projPath),
                    path: projPath,
                    source: `jetbrains`,
                  });
                }
              }
            }
          } catch { /* skip unreadable xml */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* JetBrains detection failed */ }

  // Strategy 3c: Xcode (macOS only) — check DerivedData and recent workspaces
  if (IS_MAC) {
    try {
      // Check DerivedData for recently built projects
      const derivedData = path.join(os.homedir(), "Library", "Developer", "Xcode", "DerivedData");
      if (fs.existsSync(derivedData)) {
        const entries = fs.readdirSync(derivedData, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "ModuleCache") continue;
          // DerivedData folders are named ProjectName-hashstring
          const infoPath = path.join(derivedData, entry.name, "info.plist");
          if (fs.existsSync(infoPath)) {
            try {
              const plist = fs.readFileSync(infoPath, "utf-8");
              const wsMatch = plist.match(/<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/);
              if (wsMatch) {
                const wsPath = wsMatch[1];
                const projDir = path.dirname(wsPath);
                if (fs.existsSync(projDir) && !projects.some((p) => p.path === projDir)) {
                  projects.push({
                    name: path.basename(projDir),
                    path: projDir,
                    source: "xcode",
                  });
                }
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* Xcode detection failed */ }
  }

  // Strategy 3d: Visual Studio (Windows only)
  if (IS_WIN) {
    try {
      // Check VS recent projects from Start Page data
      const vsBaseDirs = [
        path.join(os.homedir(), "AppData", "Local", "Microsoft", "VisualStudio"),
        path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "VisualStudio"),
      ];
      for (const vsBase of vsBaseDirs) {
        if (!fs.existsSync(vsBase)) continue;
        const versions = fs.readdirSync(vsBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const ver of versions) {
          // ApplicationPrivateSettings.xml contains recent projects
          const settingsPath = path.join(vsBase, ver, "ApplicationPrivateSettings.xml");
          if (!fs.existsSync(settingsPath)) continue;
          try {
            const xml = fs.readFileSync(settingsPath, "utf-8");
            // Extract solution paths
            const slnMatches = xml.match(/[A-Z]:\\[^<"]+\.sln/gi) || [];
            for (const slnPath of slnMatches.slice(0, 10)) {
              const projDir = path.dirname(slnPath);
              if (fs.existsSync(projDir) && !projects.some((p) => p.path === projDir)) {
                projects.push({
                  name: path.basename(projDir),
                  path: projDir,
                  source: "visualstudio",
                });
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* Visual Studio detection failed */ }
  }

  // Strategy 4: Scan common dev directories
  const devDirs = [
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), "projects"),
    path.join(os.homedir(), "dev"),
    path.join(os.homedir(), "Development"),
    path.join(os.homedir(), "src"),
    path.join(os.homedir(), "repos"),
    path.join(os.homedir(), "code"),
    path.join(os.homedir(), "workspace"),
    path.join(os.homedir(), "Documents", "Projects"),
    path.join(os.homedir(), "Documents", "GitHub"),
  ];

  for (const devDir of devDirs) {
    try {
      if (!fs.existsSync(devDir)) continue;
      const entries = fs.readdirSync(devDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const fullPath = path.join(devDir, entry.name);
        if (isProjectDir(fullPath)) {
          // Avoid duplicates
          if (!projects.some((p) => p.path === fullPath)) {
            projects.push({
              name: entry.name,
              path: fullPath,
              source: "scan",
            });
          }
        }
      }
    } catch { /* skip inaccessible dir */ }
  }

  // Deduplicate by path
  const seen = new Set();
  return projects.filter((p) => {
    if (seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

// ── Project path validation ───────────────────────────────────────
const knownProjectPaths = new Set();

function isKnownProjectPath(p) {
  if (!p || typeof p !== "string") return false;
  return knownProjectPaths.has(path.resolve(p));
}

// ── Git Checkpointing ──────────────────────────────────────────────
function gitCheckpoint(projectPath, message) {
  const result = { success: false, message: "", details: {} };

  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath, encoding: "utf-8", timeout: 5000 });
  } catch {
    result.message = "Not a git repository";
    return result;
  }

  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    if (!status) {
      result.message = "No changes to checkpoint";
      result.details = { branch, changedFiles: 0 };
      return result;
    }

    const changedFiles = status.split("\n").length;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const checkpointMsg = message || `wotch-checkpoint-${timestamp}`;

    execFileSync("git", ["add", "-A"], { cwd: projectPath, timeout: 5000 });

    execFileSync("git", ["commit", "-m", checkpointMsg], {
      cwd: projectPath, encoding: "utf-8", timeout: 10000,
    });

    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    result.success = true;
    result.message = `Checkpoint created: ${hash}`;
    result.details = { branch, hash, changedFiles, commitMessage: checkpointMsg };
    return result;
  } catch (err) {
    result.message = `Checkpoint failed: ${err.message}`;
    return result;
  }
}

function gitGetStatus(projectPath) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath, encoding: "utf-8", timeout: 5000 });
  } catch {
    return null;
  }

  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    const changedFiles = status ? status.split("\n").length : 0;

    let lastCommit = "";
    try {
      lastCommit = execFileSync("git", ["log", "-1", "--format=%h %s"], {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch { /* no commits yet */ }

    let checkpointCount = 0;
    try {
      const cpLog = execFileSync("git", ["log", "--oneline", "--grep=wotch-checkpoint"], {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      checkpointCount = cpLog ? cpLog.split("\n").length : 0;
    } catch { /* ignore */ }

    return { branch, changedFiles, lastCommit, checkpointCount };
  } catch {
    return null;
  }
}

function gitListCheckpoints(projectPath, limit = 20) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath, encoding: "utf-8", timeout: 5000 });
  } catch {
    return { projectPath, checkpoints: [], totalCount: 0 };
  }
  try {
    const output = execFileSync("git", ["log", `--max-count=${limit}`, "--grep=wotch-checkpoint", "--format=%H %ai %s"], {
      cwd: projectPath, encoding: "utf-8", timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output) return { projectPath, checkpoints: [], totalCount: 0 };
    const checkpoints = output.split("\n").map((line) => {
      const hash = line.slice(0, 40);
      const rest = line.slice(41);
      const dateEnd = rest.indexOf(" ", rest.indexOf(" ") + 1);
      const dateStr = rest.slice(0, rest.indexOf(" +") !== -1 ? rest.indexOf(" +") + 6 : dateEnd);
      const message = rest.slice(dateStr.length).trim();
      return { hash: hash.slice(0, 7), message, date: new Date(dateStr).toISOString() };
    });
    // Get total count
    let totalCount = checkpoints.length;
    try {
      const countOutput = execFileSync("git", ["log", "--oneline", "--grep=wotch-checkpoint"], {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      totalCount = countOutput ? countOutput.split("\n").length : 0;
    } catch { /* ignore */ }
    return { projectPath, checkpoints, totalCount };
  } catch {
    return { projectPath, checkpoints: [], totalCount: 0 };
  }
}

function gitDiffForApi(projectPath, mode) {
  try {
    const args = mode === "last-checkpoint" ? ["diff", "HEAD~1"] : ["diff"];
    return execFileSync("git", args, {
      cwd: projectPath, encoding: "utf-8", timeout: 10000,
      maxBuffer: 1024 * 1024,
    }) || "(no changes)";
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── IPC handlers ────────────────────────────────────────────────────
ipcMain.handle("pty-create", (_event, { tabId, cwd }) => {
  return createPty(tabId, cwd);
});

ipcMain.on("pty-write", (_event, { tabId, data }) => {
  const p = ptyProcesses.get(tabId);
  if (p) { p.write(data); return; }
  const s = sshSessions.get(tabId);
  if (s && s.stream) s.stream.write(data);
});

ipcMain.on("pty-resize", (_event, { tabId, cols, rows }) => {
  const p = ptyProcesses.get(tabId);
  if (p) { p.resize(cols, rows); return; }
  const s = sshSessions.get(tabId);
  if (s && s.stream) s.stream.setWindow(rows, cols, 0, 0);
});

ipcMain.on("pty-kill", (_event, { tabId }) => {
  const p = ptyProcesses.get(tabId);
  if (p) { p.kill(); ptyProcesses.delete(tabId); }
  const s = sshSessions.get(tabId);
  if (s) {
    s.userKilled = true;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.stream) s.stream.close();
    if (s.client) s.client.end();
    sshSessions.delete(tabId);
  }
  // Clean up any pending credential/host-verify promises for this tab
  const pc = pendingCredentials.get(tabId);
  if (pc) { pc.reject(new Error("Tab closed")); pendingCredentials.delete(tabId); }
  const ph = pendingHostVerify.get(tabId);
  if (ph) { ph.resolve(false); pendingHostVerify.delete(tabId); }
  claudeStatus.removeTab(tabId);
  integrationManager.removeTab(tabId);
});

ipcMain.handle("get-cwd", () => os.homedir());

// Project detection
ipcMain.handle("detect-projects", () => {
  const projects = detectProjects();
  for (const p of projects) knownProjectPaths.add(path.resolve(p.path));
  return projects;
});

// Git checkpoint
ipcMain.handle("git-checkpoint", (_event, { projectPath, message }) => {
  if (!isKnownProjectPath(projectPath)) return { success: false, message: "Unknown project path" };
  const result = gitCheckpoint(projectPath, message);
  // Broadcast checkpoint event via API
  if (result.success && apiServer && apiServer.running) {
    apiServer.broadcastEvent("git:checkpoint", {
      projectPath,
      success: true,
      hash: result.details.hash,
      branch: result.details.branch,
      changedFiles: result.details.changedFiles,
      message: result.details.commitMessage,
    });
  }
  return result;
});

// Git status
ipcMain.handle("git-status", (_event, { projectPath }) => {
  if (!isKnownProjectPath(projectPath)) return null;
  return gitGetStatus(projectPath);
});

// Platform info for the renderer
ipcMain.handle("get-platform-info", () => ({
  platform: os.platform(),
  isMac: IS_MAC,
  isWayland: WAYLAND,
  waylandCursorBroken,
  hasNotch: HAS_NOTCH,
}));

// Settings
ipcMain.handle("get-settings", () => ({ ...settings }));

const ALLOWED_SETTING_KEYS = [
  "pillWidth", "pillHeight", "expandedWidth", "expandedHeight",
  "hoverPadding", "collapseDelay", "mousePollingMs", "defaultShell",
  "startExpanded", "pinned", "theme", "autoLaunchClaude",
  "displayIndex", "position",
  "integrationHooksEnabled", "integrationMcpEnabled",
  "integrationAutoConfigureHooks", "integrationAutoRegisterMCP",
  "apiEnabled", "apiPort",
  "apiBudgetMonthly", "chatDefaultModel",
];

ipcMain.handle("save-settings", (_event, newSettings) => {
  const prev = { ...settings };
  // Only accept known setting keys — blocks prototype pollution and arbitrary key injection
  for (const key of ALLOWED_SETTING_KEYS) {
    if (key in newSettings) settings[key] = newSettings[key];
  }
  // Validate defaultShell if changed — must be empty or listed in /etc/shells (Unix) or exist (Windows)
  if (settings.defaultShell && settings.defaultShell !== prev.defaultShell) {
    let shellValid = false;
    try {
      if (!IS_WIN) {
        const shells = fs.readFileSync("/etc/shells", "utf-8")
          .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        shellValid = shells.includes(path.resolve(settings.defaultShell));
      } else {
        shellValid = fs.statSync(path.resolve(settings.defaultShell)).isFile();
      }
    } catch { /* stat or read failed */ }
    if (!shellValid) {
      settings.defaultShell = prev.defaultShell;
    }
  }
  const ok = saveSettings(settings);

  const positionChanged = prev.position !== settings.position;

  // If position changed, reposition the window and notify renderer
  if (positionChanged && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
    mainWindow.webContents.send("position-changed", settings.position || "top");
  }
  // If dimensions changed and we're expanded, re-apply bounds
  else if (isExpanded && mainWindow && (
    prev.expandedWidth !== settings.expandedWidth ||
    prev.expandedHeight !== settings.expandedHeight
  )) {
    mainWindow.setBounds(getExpandedBounds(), true);
  }

  // API server: handle enable/disable and port changes from UI
  if (apiServer) {
    // Broadcast settings change event
    const changed = {};
    for (const key of ALLOWED_SETTING_KEYS) {
      if (key in newSettings && key !== "sshProfiles") changed[key] = newSettings[key];
    }
    if (Object.keys(changed).length > 0) {
      apiServer.broadcastEvent("settings:changed", { changed, source: "ui" });
    }

    if (prev.apiEnabled && !settings.apiEnabled) {
      apiServer.stop().catch(() => {});
    } else if (!prev.apiEnabled && settings.apiEnabled) {
      apiServer.start().catch((err) => console.error("[wotch] API server start failed:", err.message));
    } else if (settings.apiEnabled && prev.apiPort !== settings.apiPort) {
      apiServer.restart().catch((err) => console.error("[wotch] API server restart failed:", err.message));
    }
  }

  return ok;
});

ipcMain.handle("reset-settings", () => {
  const preservedProfiles = settings.sshProfiles;
  settings = { ...DEFAULT_SETTINGS };
  settings.sshProfiles = preservedProfiles;
  saveSettings(settings);
  isPinned = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
    mainWindow.webContents.send("pin-state", false);
    mainWindow.webContents.send("position-changed", settings.position || "top");
  }
  return { ...settings };
});

// Pin mode
ipcMain.handle("set-pinned", (_event, pinned) => {
  setPinned(pinned);
  return isPinned;
});

ipcMain.handle("get-pinned", () => isPinned);

// Git diff
ipcMain.handle("git-diff", (_event, { projectPath, mode }) => {
  if (!isKnownProjectPath(projectPath)) return { success: false, diff: "Unknown project path" };
  try {
    const args = mode === "last-checkpoint" ? ["diff", "HEAD~1"] : ["diff"];
    const output = execFileSync("git", args, {
      cwd: projectPath, encoding: "utf-8", timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return { success: true, diff: output || "(no changes)" };
  } catch (err) {
    return { success: false, diff: err.message };
  }
});

// ── Integration IPC handlers ─────────────────────────────────────────
ipcMain.handle("integration-status", () => {
  return integrationManager.getIntegrationStatus();
});

ipcMain.handle("integration-configure-hooks", () => {
  try {
    const added = integrationManager.configureClaudeHooks();
    return { success: true, added };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("integration-register-mcp", () => {
  try {
    const mcpServerPath = app.isPackaged
      ? path.join(process.resourcesPath, "mcp-server.js")
      : path.join(__dirname, "mcp-server.js");
    const registered = integrationManager.registerMCPServer(mcpServerPath);
    return { success: true, registered };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── API Server IPC handlers ─────────────────────────────────────────
ipcMain.handle("api-get-info", () => {
  if (!apiServer) return { running: false, port: null, tokenMasked: null, connections: 0 };
  return apiServer.getInfo();
});

ipcMain.handle("api-copy-token", () => {
  if (!apiServer) return null;
  return apiServer.getToken();
});

ipcMain.handle("api-regenerate-token", () => {
  if (!apiServer) return null;
  return apiServer.regenerateToken();
});

// ── Claude API IPC Handlers ─────────────────────────────────────────
ipcMain.handle("claude-set-api-key", async (_event, { apiKey }) => {
  try {
    credentialManager.setKey(apiKey);
    const validation = await credentialManager.validateKey(apiKey);
    if (!validation.valid && validation.error === "Invalid API key") {
      credentialManager.deleteKey();
    }
    // Invalidate the Anthropic client so it picks up the new key
    if (claudeAPIManager) claudeAPIManager._invalidateClient();
    return validation;
  } catch (err) {
    return { valid: false, error: err.message };
  }
});

ipcMain.handle("claude-validate-key", async () => {
  return credentialManager.validateKey();
});

ipcMain.handle("claude-has-key", () => {
  return credentialManager.hasKey();
});

ipcMain.handle("claude-delete-key", () => {
  credentialManager.deleteKey();
  if (claudeAPIManager) claudeAPIManager._invalidateClient();
  return { success: true };
});

ipcMain.handle("claude-get-models", () => {
  return AVAILABLE_MODELS;
});

ipcMain.handle("claude-send-message", async (_event, { tabId, projectPath, message, options }) => {
  if (!claudeAPIManager) return { success: false, error: "API manager not initialized" };
  if (!credentialManager.hasKey()) return { success: false, error: "No API key configured" };
  // Input validation
  if (typeof message !== "string" || !message.trim()) return { success: false, error: "Message is required" };
  if (message.length > 100000) return { success: false, error: "Message too long (100K char limit)" };
  // Validate model against allowlist
  const validModelIds = AVAILABLE_MODELS.map((m) => m.id);
  if (options?.model && !validModelIds.includes(options.model)) {
    return { success: false, error: "Invalid model" };
  }
  // Reject if already streaming
  if (claudeAPIManager.streaming) return { success: false, error: "Already streaming a response" };
  const sendToRenderer = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  };
  return claudeAPIManager.sendMessage(tabId, projectPath, message, options || {}, sendToRenderer);
});

ipcMain.on("claude-stop-stream", () => {
  if (claudeAPIManager) claudeAPIManager.stopStream();
});

ipcMain.handle("claude-get-context", (_event, { tabId, projectPath }) => {
  if (!claudeAPIManager) return {};
  return claudeAPIManager.getContextMetadata(tabId, projectPath);
});

ipcMain.handle("claude-get-conversations", (_event, { projectPath }) => {
  if (!claudeAPIManager) return [];
  return claudeAPIManager.getConversations(projectPath);
});

ipcMain.handle("claude-load-conversation", (_event, { conversationId }) => {
  if (!claudeAPIManager) return null;
  return claudeAPIManager.loadConversation(conversationId);
});

ipcMain.handle("claude-delete-conversation", (_event, { conversationId }) => {
  if (!claudeAPIManager) return false;
  return claudeAPIManager.deleteConversation(conversationId);
});

ipcMain.handle("claude-new-conversation", (_event, { projectPath }) => {
  if (!claudeAPIManager) return null;
  return claudeAPIManager.newConversation(projectPath);
});

ipcMain.handle("claude-get-usage", () => {
  return {
    session: tokenTracker.getSessionTotals(),
    monthly: tokenTracker.getMonthlyTotals(),
  };
});

ipcMain.handle("claude-set-budget", (_event, { limit }) => {
  const val = parseFloat(limit);
  settings.apiBudgetMonthly = (Number.isFinite(val) && val >= 0) ? val : 0;
  saveSettings(settings);
  return { success: true };
});

// Terminal buffer read — used by MCP server to read xterm.js content
ipcMain.handle("terminal-buffer-read", (_event, { tabId, lines }) => {
  // This is called from the main process MCP IPC handler.
  // The actual buffer reading happens renderer-side; see below.
  return null; // Placeholder — real impl uses renderer IPC round-trip
});

// Display management
ipcMain.handle("get-displays", () => {
  return screen.getAllDisplays().map((d, i) => ({
    index: i,
    label: `Display ${i + 1}`,
    width: d.bounds.width,
    height: d.bounds.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
});

// Window resize (from drag handle)
ipcMain.on("resize-window", (_event, size) => {
  if (!mainWindow || !isExpanded) return;
  const pos = settings.position || "top";
  if (pos === "left" || pos === "right") {
    // For side positions, drag handle adjusts width
    const clamped = Math.max(400, Math.min(1200, size));
    settings.expandedWidth = clamped;
  } else {
    const clamped = Math.max(200, Math.min(900, size));
    settings.expandedHeight = clamped;
  }
  const bounds = getExpandedBounds();
  mainWindow.setBounds(bounds, false);
  saveSettings(settings);
});

// ── SSH IPC handlers ───────────────────────────────────────────────

ipcMain.handle("ssh-connect", async (_event, { tabId, profileId, password }) => {
  return createSshSession(tabId, profileId, password);
});

ipcMain.on("ssh-credential-response", (_event, { tabId, credential }) => {
  const pending = pendingCredentials.get(tabId);
  if (pending) {
    pending.resolve(credential);
    pendingCredentials.delete(tabId);
  }
});

ipcMain.on("ssh-host-verify-response", (_event, { tabId, accepted }) => {
  const pending = pendingHostVerify.get(tabId);
  if (pending) {
    pending.resolve(accepted);
    pendingHostVerify.delete(tabId);
  }
});

ipcMain.handle("ssh-save-profile", (_event, profile) => {
  if (!profile || typeof profile.host !== "string" || !profile.host.trim()) {
    throw new Error("Invalid SSH profile: host is required");
  }
  if (typeof profile.username !== "string" || !profile.username.trim()) {
    throw new Error("Invalid SSH profile: username is required");
  }
  profile.port = parseInt(profile.port) || 22;
  if (profile.port < 1 || profile.port > 65535) profile.port = 22;
  if (!profile.id) profile.id = crypto.randomUUID();
  const idx = (settings.sshProfiles || []).findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    settings.sshProfiles[idx] = profile;
  } else {
    if (!settings.sshProfiles) settings.sshProfiles = [];
    settings.sshProfiles.push(profile);
  }
  saveSettings(settings);
  return profile;
});

ipcMain.handle("ssh-delete-profile", (_event, profileId) => {
  settings.sshProfiles = (settings.sshProfiles || []).filter((p) => p.id !== profileId);
  saveSettings(settings);
  return true;
});

ipcMain.handle("ssh-list-profiles", () => {
  return settings.sshProfiles || [];
});

ipcMain.handle("ssh-browse-key", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select SSH Private Key",
    defaultPath: path.join(os.homedir(), ".ssh"),
    properties: ["openFile", "showHiddenFiles"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Electron CLI flags for Wayland support ─────────────────────────
// Enable Ozone so Electron can run natively on Wayland when available.
// This must be called before app.whenReady().
if (IS_LINUX) {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform,WaylandWindowDecorations");
}

// ── App lifecycle ───────────────────────────────────────────────────
const HOTKEY_LABEL = IS_MAC ? "⌘+`" : "Ctrl+`";

app.whenReady().then(() => {
  // Detect macOS notch (needs screen API, only available after app ready)
  HAS_NOTCH = detectMacNotch();
  if (IS_MAC) {
    console.log(`[wotch] macOS: ${HAS_NOTCH ? "notch detected — pill sits in notch area" : "no notch — pill below menu bar"}`);
  }

  createWindow();

  // ── Start Claude Code Integration ──
  const mcpHandlers = {
    gitCheckpoint: async (params) => {
      // Find the first known project path for MCP calls
      const projectPath = [...knownProjectPaths][0];
      if (!projectPath) return { success: false, message: "No project active" };
      return gitCheckpoint(projectPath, params.message);
    },
    gitGetStatus: async () => {
      const projectPath = [...knownProjectPaths][0];
      if (!projectPath) return null;
      return gitGetStatus(projectPath);
    },
    gitGetDiff: async (params) => {
      const projectPath = [...knownProjectPaths][0];
      if (!projectPath) return "(no project active)";
      try {
        const args = ["diff", `-U${params.contextLines || 3}`];
        return execFileSync("git", args, {
          cwd: projectPath, encoding: "utf-8", timeout: 10000, maxBuffer: 1024 * 1024,
        }) || "(no changes)";
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
    getProjectInfo: async () => {
      const projectPath = [...knownProjectPaths][0];
      if (!projectPath) return { path: null, name: null };
      return { path: projectPath, name: path.basename(projectPath) };
    },
    terminalBuffer: async (params) => {
      // Request buffer from renderer via IPC round-trip
      if (!mainWindow || mainWindow.isDestroyed()) return "(window not available)";
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve("(timeout reading buffer)"), 5000);
        const handler = (_e, data) => {
          clearTimeout(timeout);
          ipcMain.removeListener("terminal-buffer-response", handler);
          resolve(data || "(empty)");
        };
        ipcMain.on("terminal-buffer-response", handler);
        mainWindow.webContents.send("terminal-buffer-read", {
          tabId: params.tabId,
          lines: params.lines || 50,
        });
      });
    },
    notify: async (params) => {
      if (Notification.isSupported()) {
        const notif = new Notification({
          title: params.title || "Wotch",
          body: params.body || "",
          silent: false,
        });
        notif.show();
      }
      return "ok";
    },
    listTabs: async () => {
      const tabs = [];
      for (const [tabId] of ptyProcesses) {
        const status = integrationManager.getStatus(tabId);
        tabs.push({ tabId, type: "local", status: status.state });
      }
      for (const [tabId, s] of sshSessions) {
        const status = integrationManager.getStatus(tabId);
        tabs.push({ tabId, type: "ssh", profileId: s.profileId, status: status.state });
      }
      return tabs;
    },
    tabStatus: async (params) => {
      return integrationManager.getStatus(params.tabId);
    },
  };

  integrationManager.start(mcpHandlers).then(() => {
    // Auto-configure hooks if Claude Code is installed
    if (settings.integrationAutoConfigureHooks && settings.integrationHooksEnabled) {
      const claudeDir = path.join(os.homedir(), ".claude");
      if (fs.existsSync(claudeDir)) {
        try {
          integrationManager.configureClaudeHooks();
        } catch (err) {
          console.error("[wotch] Failed to auto-configure hooks:", err.message);
        }
      }
    }

    // Auto-register MCP server
    if (settings.integrationAutoRegisterMCP && settings.integrationMcpEnabled) {
      try {
        const mcpServerPath = app.isPackaged
          ? path.join(process.resourcesPath, "mcp-server.js")
          : path.join(__dirname, "mcp-server.js");
        integrationManager.registerMCPServer(mcpServerPath);
      } catch (err) {
        console.error("[wotch] Failed to auto-register MCP:", err.message);
      }
    }
  }).catch((err) => {
    console.error("[wotch] Integration manager failed to start:", err.message);
  });

  // ── Start Claude API Manager ──
  claudeAPIManager = new ClaudeAPIManager(credentialManager, tokenTracker);

  // ── Start API Server ──
  createApiServer();
  if (settings.apiEnabled) {
    apiServer.start().catch((err) => {
      console.error("[wotch] API server failed to start:", err.message);
    });
  }

  // If settings say start expanded or pinned, expand immediately
  if (settings.startExpanded || isPinned) {
    setTimeout(() => expand(), 300);
  }

  // Global hotkey: Ctrl/Cmd + ` (backtick)
  globalShortcut.register("CommandOrControl+`", toggle);

  // System tray
  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4y2P4z8DwHwMNMDAwMIxqIE0DI7kGMJFrABM+l4xqGBYaWMh1AQu5BrCQawALBYkUGwB1AACvQBJP3QAAAABJRU5ErkJggg=="
  );

  tray = new Tray(trayIcon);
  tray.setToolTip("Wotch");

  const platformLabel = IS_WIN ? "Windows" : IS_MAC ? `macOS${HAS_NOTCH ? " (notch)" : ""}` : `Linux${WAYLAND ? " (Wayland)" : ""}`;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Toggle (${HOTKEY_LABEL})`, click: toggle },
      { type: "separator" },
      {
        label: `Platform: ${platformLabel}`,
        enabled: false,
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );

  tray.on("click", toggle);

  if (WAYLAND) {
    console.log("[wotch] Running on Wayland — hover-to-reveal may be limited, use Ctrl+` to toggle");
  }

  // Fall back to primary display if current display is disconnected
  screen.on("display-removed", () => {
    const displays = screen.getAllDisplays();
    if (settings.displayIndex >= displays.length) {
      settings.displayIndex = 0;
      saveSettings(settings);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
      }
    }
  });

  // ── Auto-update (only in packaged builds) ──
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.logger = null;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on("update-available", (info) => {
        console.log(`[wotch] Update available: v${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("update-available", info.version);
        }
      });

      autoUpdater.on("update-downloaded", (info) => {
        console.log(`[wotch] Update downloaded: v${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("update-downloaded", info.version);
        }
      });

      autoUpdater.on("error", (err) => {
        console.log("[wotch] Auto-update error:", err.message);
      });

      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }, 10000);
    } catch (err) {
      console.log("[wotch] Auto-update not available:", err.message);
    }
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  clearInterval(idleCheckInterval);
  if (apiServer) apiServer.stop().catch(() => {});
  integrationManager.stop().catch(() => {});
  credentialManager.clearCache();
  if (claudeAPIManager) claudeAPIManager.stopStream();
  for (const [, p] of ptyProcesses) p.kill();
  ptyProcesses.clear();
  for (const [, s] of sshSessions) {
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    if (s.stream) s.stream.close();
    if (s.client) s.client.end();
  }
  sshSessions.clear();
  // Reject all pending credential/host-verify promises
  for (const [, p] of pendingCredentials) p.reject(new Error("App quitting"));
  pendingCredentials.clear();
  for (const [, p] of pendingHostVerify) p.resolve(false);
  pendingHostVerify.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
