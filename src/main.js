const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, Notification, dialog, safeStorage } = require("electron");
const path = require("path");
const pty = require("node-pty");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execSync, execFileSync, exec } = require("child_process");
const vm = require("vm");
let SSHClient;
try { SSHClient = require("ssh2").Client; } catch { SSHClient = null; console.warn("[wotch] ssh2 not installed — SSH features disabled"); }
let ClaudeIntegrationManager;
try { ({ ClaudeIntegrationManager } = require("./claude-integration-manager")); } catch { ClaudeIntegrationManager = null; console.warn("[wotch] claude-integration-manager not found — integration features disabled"); }
let ApiServer;
try { ({ ApiServer } = require("./api-server")); } catch { ApiServer = null; console.warn("[wotch] api-server not found — API features disabled"); }

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
  hoverEnabled: true,           // false = hotkey-only mode
  collapseDelay: 400,
  mousePollingMs: 100,
  defaultShell: "",          // empty = auto-detect
  startExpanded: false,
  pinned: false,             // remember pin state across restarts
  theme: "dark",
  autoLaunchClaude: false,
  launchCommand: "claude",       // command to run on new tab (e.g. "claude", "openclaude")
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
  // IDE Bridge
  integrationBridgeEnabled: true,
  integrationBridgePort: 19521,
  // Local API
  apiEnabled: false,
  apiPort: 19519,
  // Claude API chat
  apiBudgetMonthly: 0,       // 0 = unlimited
  chatDefaultModel: "claude-sonnet-4-6-20250514",
  plugins: {},
  agentSettings: {
    enabled: true,
    maxConcurrentAgents: 3,
    defaultApprovalMode: "ask-first",
    approvalTimeoutMs: 300000,
    logRetentionDays: 30,
    autoTriggerEnabled: true,
  },
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
const tabCwds = new Map();    // tabId → last known working directory (via OSC 7)
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
      sandbox: false,
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
    if (!settings.hoverEnabled) return; // Hotkey-only mode

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
    env: {
      ...process.env,
      TERM: "xterm-256color",
      WOTCH_TAB_ID: tabId,
      // Inject OSC 7 cwd reporting for bash (zsh/fish do it automatically)
      ...((!IS_WIN && !process.env.PROMPT_COMMAND) ? { PROMPT_COMMAND: 'printf "\\e]7;file://%s%s\\a" "$HOSTNAME" "$PWD"' } : {}),
    },
  });

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-data", { tabId, data });
    }
    // Track working directory via OSC 7 escape sequence (emitted by modern shells)
    const osc7 = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)[\x07\x1b]/);
    if (osc7) tabCwds.set(tabId, decodeURIComponent(osc7[1]));
    // Feed data to status detector
    claudeStatus.feed(tabId, data);
    // Feed to plugin system (status detectors + terminal listeners)
    const cleanData = claudeStatus.stripAnsi(data);
    pluginHost.feedTerminalData(tabId, data, cleanData);
    // Check agent triggers
    agentManager.checkTriggers(tabId, cleanData);
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
    this.tabs = new Map(); // tabId → { state, description, buffer, lastActivity, claudeActive, aiType }
    this.previousStates = new Map(); // tabId → previous state
    this.broadcastTimer = null;
  }

  addTab(tabId) {
    this.tabs.set(tabId, {
      state: "idle",
      description: "",
      buffer: "",         // rolling buffer of recent clean text
      lastActivity: 0,
      claudeActive: false,  // true when any supported AI CLI is active
      aiType: null,         // "claude" | "gemini" | null
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

    // ── Detect if a supported AI CLI session is active ──
    if (!tab.claudeActive) {
      if (
        /claude\s/i.test(clean) ||
        /╭─/u.test(clean) ||
        /Claude Code/i.test(clean) ||
        /claude\.ai/i.test(clean)
      ) {
        tab.claudeActive = true;
        tab.aiType = "claude";
      } else if (
        /Gemini CLI/i.test(clean) ||
        /gemini\.google\.com/i.test(clean)
      ) {
        tab.claudeActive = true;
        tab.aiType = "gemini";
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
      // Done / Success (Claude Code + Gemini CLI)
      done: [
        /[✓✔]\s*(.{0,60})/u,
        /^◆\s+(.{0,60})/um,         // Gemini CLI: diamond only at line start
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
              const aiLabel = tab.aiType === "gemini" ? "Gemini" : "Claude";
              const notif = new Notification({
                title: "Wotch",
                body: tab.state === "error"
                  ? `${aiLabel} error: ${tab.description || "Unknown"}`
                  : `${aiLabel} finished: ${tab.description || "Task complete"}`,
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

// ── Plugin System ──────────────────────────────────────────────────

const PLUGINS_DIR = path.join(os.homedir(), ".wotch", "plugins");
const PLUGIN_DATA_DIR = path.join(os.homedir(), ".wotch", "plugin-data");
const VALID_PERMISSIONS = [
  "fs.read", "fs.write", "process.exec", "net.fetch",
  "git.read", "git.write", "terminal.read", "terminal.write",
  "ui.panels", "ui.notifications",
];
const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{2,49}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const COMMAND_ID_RE = /^[a-z][a-z0-9-]+\.[a-zA-Z][a-zA-Z0-9.]+$/;
const PLUGIN_LIFECYCLE_TIMEOUT = 5000;

function validateManifest(manifest, dirName) {
  const errors = [];
  if (!manifest.name || typeof manifest.name !== "string") {
    errors.push("Missing or invalid 'name'");
  } else if (!PLUGIN_NAME_RE.test(manifest.name)) {
    errors.push(`Invalid name format: ${manifest.name}`);
  } else if (manifest.name !== dirName) {
    errors.push(`Name '${manifest.name}' doesn't match directory '${dirName}'`);
  }
  if (!manifest.version || !SEMVER_RE.test(manifest.version)) {
    errors.push("Missing or invalid 'version' (must be semver)");
  }
  if (!manifest.displayName || typeof manifest.displayName !== "string" || manifest.displayName.length > 100) {
    errors.push("Missing or invalid 'displayName'");
  }
  if (!manifest.description || typeof manifest.description !== "string" || manifest.description.length > 500) {
    errors.push("Missing or invalid 'description'");
  }
  if (!manifest.main && !manifest.renderer) {
    errors.push("At least one of 'main' or 'renderer' must be specified");
  }
  if (manifest.main) {
    if (typeof manifest.main !== "string" || !manifest.main.endsWith(".js") || manifest.main.includes("..")) {
      errors.push("Invalid 'main' entry point");
    }
  }
  if (manifest.renderer) {
    if (typeof manifest.renderer !== "string" || !manifest.renderer.endsWith(".js") || manifest.renderer.includes("..")) {
      errors.push("Invalid 'renderer' entry point");
    }
  }
  if (manifest.permissions) {
    if (!Array.isArray(manifest.permissions)) {
      errors.push("'permissions' must be an array");
    } else {
      for (const p of manifest.permissions) {
        if (!VALID_PERMISSIONS.includes(p)) errors.push(`Unknown permission: ${p}`);
      }
    }
  }
  if (manifest.contributes) {
    if (manifest.contributes.commands) {
      for (const cmd of manifest.contributes.commands) {
        if (!cmd.id || !COMMAND_ID_RE.test(cmd.id)) errors.push(`Invalid command id: ${cmd.id}`);
        else if (!cmd.id.startsWith(manifest.name + ".")) errors.push(`Command '${cmd.id}' must be prefixed with '${manifest.name}.'`);
        if (!cmd.title) errors.push(`Command '${cmd.id}' missing title`);
      }
    }
    if (manifest.contributes.statusDetectors) {
      for (const det of manifest.contributes.statusDetectors) {
        if (!det.id || !det.id.startsWith(manifest.name + ".")) errors.push(`Status detector '${det.id}' must be prefixed with '${manifest.name}.'`);
      }
    }
    if (manifest.contributes.panels) {
      if (!manifest.permissions || !manifest.permissions.includes("ui.panels")) {
        errors.push("Panel contributions require 'ui.panels' permission");
      }
      for (const panel of manifest.contributes.panels) {
        if (!panel.id || !panel.id.startsWith(manifest.name + ".")) errors.push(`Panel '${panel.id}' must be prefixed with '${manifest.name}.'`);
      }
    }
    if (manifest.contributes.settings) {
      for (const s of manifest.contributes.settings) {
        if (!s.id || !s.id.startsWith(manifest.name + ".")) errors.push(`Setting '${s.id}' must be prefixed with '${manifest.name}.'`);
        if (!["string", "number", "boolean"].includes(s.type)) errors.push(`Setting '${s.id}' has invalid type: ${s.type}`);
      }
    }
    if (manifest.contributes.themes) {
      const requiredColorKeys = ["--bg", "--bg-solid", "--border", "--accent", "--accent-dim", "--text", "--text-dim", "--text-muted", "--green", "termBg", "termFg", "termCursor"];
      for (const theme of manifest.contributes.themes) {
        if (!theme.id || !theme.id.startsWith(manifest.name + ".")) errors.push(`Theme '${theme.id}' must be prefixed with '${manifest.name}.'`);
        if (!theme.colors) errors.push(`Theme '${theme.id}' missing colors`);
        else {
          for (const key of requiredColorKeys) {
            if (!(key in theme.colors)) errors.push(`Theme '${theme.id}' missing color key: ${key}`);
          }
        }
      }
    }
  }
  return errors;
}

function createScopedConsole(pluginId) {
  const prefix = `[wotch:plugin:${pluginId}]`;
  return {
    log: (...args) => console.log(prefix, ...args),
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}

function createPluginApi(pluginId, manifest, grantedPermissions, pluginHost) {
  function requirePermission(perm, method) {
    if (!grantedPermissions.has(perm)) {
      throw new Error(`Permission denied: '${perm}' required for ${method}`);
    }
  }

  const api = {
    version: app.getVersion() || "1.0.0",

    // ── commands (no permission) ──
    commands: {
      register(cmd) {
        if (!cmd.id || !cmd.title || !cmd.handler) throw new Error("Command requires id, title, handler");
        pluginHost.registerCommand(pluginId, cmd);
        return { dispose: () => pluginHost.unregisterCommand(pluginId, cmd.id) };
      },
      execute(commandId) {
        return pluginHost.executeCommand(commandId);
      },
      list() {
        return Promise.resolve(pluginHost.listCommands());
      },
    },

    // ── status (registerDetector requires terminal.read) ──
    status: {
      onChanged(callback) {
        pluginHost.addStatusListener(pluginId, callback);
        return { dispose: () => pluginHost.removeStatusListener(pluginId, callback) };
      },
      getAll() {
        return Promise.resolve(pluginHost.getAllStatuses());
      },
      get(tabId) {
        return Promise.resolve(pluginHost.getTabStatus(tabId));
      },
      registerDetector(detectorId, callback) {
        requirePermission("terminal.read", "status.registerDetector");
        pluginHost.registerDetector(pluginId, detectorId, callback);
        return { dispose: () => pluginHost.unregisterDetector(pluginId, detectorId) };
      },
    },

    // ── ui ──
    ui: {
      addPanel(panel) {
        requirePermission("ui.panels", "ui.addPanel");
        pluginHost.registerPanel(pluginId, panel);
        return {
          dispose: () => pluginHost.unregisterPanel(pluginId, panel.id),
          setHtml: (html) => pluginHost.updatePanel(pluginId, panel.id, html),
          postMessage: (data) => pluginHost.postPanelMessage(pluginId, panel.id, data),
          setVisible: (v) => pluginHost.setPanelVisible(pluginId, panel.id, v),
        };
      },
      showNotification(options) {
        requirePermission("ui.notifications", "ui.showNotification");
        pluginHost.showNotification(pluginId, options);
      },
      isExpanded: () => Promise.resolve(isExpanded),
      onExpansionChanged(callback) {
        pluginHost.addExpansionListener(pluginId, callback);
        return { dispose: () => pluginHost.removeExpansionListener(pluginId, callback) };
      },
    },

    // ── tabs (read-only, no permission) ──
    tabs: {
      list() {
        const list = [];
        for (const [tabId] of ptyProcesses) {
          list.push({ id: tabId, name: tabId, connectionType: "local", cwd: "", isActive: false });
        }
        return Promise.resolve(list);
      },
      getActive() {
        return Promise.resolve(null); // Active tab is tracked in renderer
      },
      onCreated(callback) {
        pluginHost.addTabListener(pluginId, "created", callback);
        return { dispose: () => pluginHost.removeTabListener(pluginId, "created", callback) };
      },
      onClosed(callback) {
        pluginHost.addTabListener(pluginId, "closed", callback);
        return { dispose: () => pluginHost.removeTabListener(pluginId, "closed", callback) };
      },
      onActivated(callback) {
        pluginHost.addTabListener(pluginId, "activated", callback);
        return { dispose: () => pluginHost.removeTabListener(pluginId, "activated", callback) };
      },
    },

    // ── terminal (read/write permission-gated) ──
    terminal: {
      onData(callback) {
        requirePermission("terminal.read", "terminal.onData");
        pluginHost.addTerminalListener(pluginId, callback);
        return { dispose: () => pluginHost.removeTerminalListener(pluginId, callback) };
      },
      onTabData(tabId, callback) {
        requirePermission("terminal.read", "terminal.onTabData");
        const wrapper = (evt) => { if (evt.tabId === tabId) callback(evt.data); };
        pluginHost.addTerminalListener(pluginId, wrapper);
        return { dispose: () => pluginHost.removeTerminalListener(pluginId, wrapper) };
      },
      write(tabId, data) {
        requirePermission("terminal.write", "terminal.write");
        const p = ptyProcesses.get(tabId);
        if (p) p.write(data);
      },
      writeActive(data) {
        requirePermission("terminal.write", "terminal.writeActive");
        // Write to first pty as fallback (active tab is renderer-side state)
        const first = ptyProcesses.entries().next().value;
        if (first) first[1].write(data);
      },
    },

    // ── settings (no permission) ──
    settings: {
      get(settingId) {
        const pluginSettings = (settings.plugins && settings.plugins[pluginId] && settings.plugins[pluginId].settings) || {};
        if (settingId in pluginSettings) return Promise.resolve(pluginSettings[settingId]);
        // Return default from manifest
        const def = (manifest.contributes && manifest.contributes.settings || []).find(s => s.id === settingId);
        return Promise.resolve(def ? def.default : undefined);
      },
      set(settingId, value) {
        if (!settings.plugins) settings.plugins = {};
        if (!settings.plugins[pluginId]) settings.plugins[pluginId] = {};
        if (!settings.plugins[pluginId].settings) settings.plugins[pluginId].settings = {};
        const old = settings.plugins[pluginId].settings[settingId];
        settings.plugins[pluginId].settings[settingId] = value;
        saveSettings(settings);
        pluginHost.emitSettingChanged(pluginId, settingId, old, value);
        return Promise.resolve();
      },
      onChanged(settingId, callback) {
        pluginHost.addSettingListener(pluginId, settingId, callback);
        return { dispose: () => pluginHost.removeSettingListener(pluginId, settingId, callback) };
      },
      getAll() {
        const pluginSettings = (settings.plugins && settings.plugins[pluginId] && settings.plugins[pluginId].settings) || {};
        const result = {};
        for (const s of (manifest.contributes && manifest.contributes.settings || [])) {
          result[s.id] = s.id in pluginSettings ? pluginSettings[s.id] : s.default;
        }
        return Promise.resolve(result);
      },
    },

    // ── project (no permission) ──
    project: {
      getCurrent: () => Promise.resolve(null), // Project is renderer state
      onChanged: (callback) => {
        pluginHost.addProjectListener(pluginId, callback);
        return { dispose: () => pluginHost.removeProjectListener(pluginId, callback) };
      },
      list: () => Promise.resolve([]),
    },

    // ── fs (requires fs.read / fs.write) ──
    fs: {
      readFile(filePath) {
        requirePermission("fs.read", "fs.readFile");
        return fs.promises.readFile(path.resolve(filePath), "utf-8");
      },
      writeFile(filePath, content) {
        requirePermission("fs.write", "fs.writeFile");
        const resolved = path.resolve(filePath);
        return fs.promises.mkdir(path.dirname(resolved), { recursive: true })
          .then(() => fs.promises.writeFile(resolved, content, { mode: 0o644 }));
      },
      appendFile(filePath, content) {
        requirePermission("fs.write", "fs.appendFile");
        return fs.promises.appendFile(path.resolve(filePath), content);
      },
      exists(filePath) {
        requirePermission("fs.read", "fs.exists");
        return fs.promises.access(path.resolve(filePath)).then(() => true).catch(() => false);
      },
      stat(filePath) {
        requirePermission("fs.read", "fs.stat");
        return fs.promises.stat(path.resolve(filePath)).then(s => ({
          size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(),
          modifiedMs: s.mtimeMs, createdMs: s.birthtimeMs,
        }));
      },
      readdir(dirPath) {
        requirePermission("fs.read", "fs.readdir");
        return fs.promises.readdir(path.resolve(dirPath));
      },
      mkdir(dirPath) {
        requirePermission("fs.write", "fs.mkdir");
        return fs.promises.mkdir(path.resolve(dirPath), { recursive: true });
      },
      unlink(filePath) {
        requirePermission("fs.write", "fs.unlink");
        return fs.promises.unlink(path.resolve(filePath));
      },
    },

    // ── process (requires process.exec) ──
    process: {
      exec(command, options = {}) {
        requirePermission("process.exec", "process.exec");
        return new Promise((resolve, reject) => {
          exec(command, {
            cwd: options.cwd || os.homedir(),
            timeout: options.timeout || 30000,
            maxBuffer: options.maxBuffer || 1048576,
            env: options.env ? { ...process.env, ...options.env } : process.env,
          }, (err, stdout, stderr) => {
            resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: err ? (err.code || 1) : 0 });
          });
        });
      },
      cwd: () => Promise.resolve(process.cwd()),
      env: (name) => Promise.resolve(process.env[name]),
    },

    // ── net (requires net.fetch) ──
    net: {
      async fetch(url, options = {}) {
        requirePermission("net.fetch", "net.fetch");
        const mod = url.startsWith("https") ? require("https") : require("http");
        return new Promise((resolve, reject) => {
          const parsedUrl = new URL(url);
          const reqOpts = {
            hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || "GET", headers: options.headers || {},
            timeout: options.timeout || 30000,
          };
          const req = mod.request(reqOpts, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; if (body.length > 10485760) { req.destroy(); reject(new Error("Response too large")); } });
            res.on("end", () => {
              const headers = {};
              for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
              resolve({ status: res.statusCode, statusText: res.statusMessage, headers, body, ok: res.statusCode >= 200 && res.statusCode < 300 });
            });
          });
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
          if (options.body) req.write(options.body);
          req.end();
        });
      },
    },

    // ── git (requires git.read / git.write) ──
    git: {
      status(projectPath) {
        requirePermission("git.read", "git.status");
        const pp = projectPath || [...knownProjectPaths][0];
        if (!pp) return Promise.resolve({ branch: "", changedFiles: 0, checkpointCount: 0, isGitRepo: false });
        return Promise.resolve(gitGetStatus(pp));
      },
      diff(projectPath, mode) {
        requirePermission("git.read", "git.diff");
        const pp = projectPath || [...knownProjectPaths][0];
        if (!pp) return Promise.resolve({ diff: "", stats: { additions: 0, deletions: 0, files: 0 } });
        try {
          const args = ["diff"];
          if (mode === "staged") args.push("--cached");
          const diff = execFileSync("git", args, { cwd: pp, encoding: "utf-8", timeout: 10000, maxBuffer: 1048576 }) || "";
          return Promise.resolve({ diff, stats: { additions: 0, deletions: 0, files: 0 } });
        } catch (err) { return Promise.resolve({ diff: `Error: ${err.message}`, stats: { additions: 0, deletions: 0, files: 0 } }); }
      },
      branch(projectPath) {
        requirePermission("git.read", "git.branch");
        const pp = projectPath || [...knownProjectPaths][0];
        if (!pp) return Promise.resolve("");
        try {
          return Promise.resolve(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: pp, encoding: "utf-8", timeout: 5000 }).trim());
        } catch { return Promise.resolve(""); }
      },
      log(projectPath, count = 10) {
        requirePermission("git.read", "git.log");
        const pp = projectPath || [...knownProjectPaths][0];
        if (!pp) return Promise.resolve([]);
        try {
          const raw = execFileSync("git", ["log", `--max-count=${count}`, "--format=%H|||%s|||%an|||%aI"], { cwd: pp, encoding: "utf-8", timeout: 10000 });
          return Promise.resolve(raw.trim().split("\n").filter(Boolean).map(line => {
            const [hash, message, author, date] = line.split("|||");
            return { hash, message, author, date };
          }));
        } catch { return Promise.resolve([]); }
      },
      checkpoint(projectPath, message) {
        requirePermission("git.write", "git.checkpoint");
        const pp = projectPath || [...knownProjectPaths][0];
        if (!pp) return Promise.resolve({ success: false, message: "No project path" });
        return Promise.resolve(gitCheckpoint(pp, message));
      },
    },
  };

  return api;
}

class PluginHost {
  constructor() {
    this.plugins = new Map();       // id → { manifest, state, context, module, errors }
    this.commands = new Map();      // commandId → { pluginId, title, handler }
    this.detectors = new Map();     // detectorId → { pluginId, callback, priority }
    this.panels = new Map();        // panelId → { pluginId, title, html, icon, location }
    this.statusListeners = [];      // [{ pluginId, callback }]
    this.terminalListeners = [];    // [{ pluginId, callback }]
    this.expansionListeners = [];   // [{ pluginId, callback }]
    this.tabListeners = { created: [], closed: [], activated: [] };
    this.settingListeners = new Map(); // settingId → [{ pluginId, callback }]
    this.projectListeners = [];
    this.errorCounts = new Map();   // pluginId → { count, firstError }
    this.watcher = null;
  }

  async init() {
    // Ensure plugin directories exist
    try { fs.mkdirSync(PLUGINS_DIR, { recursive: true }); } catch { /* ok */ }
    try { fs.mkdirSync(PLUGIN_DATA_DIR, { recursive: true }); } catch { /* ok */ }

    // Discover and validate
    await this.discover();

    // Activate enabled plugins
    for (const [id, plugin] of this.plugins) {
      if (plugin.state === "validated") {
        const pluginConfig = settings.plugins && settings.plugins[id];
        if (pluginConfig && pluginConfig.enabled) {
          await this.activate(id);
        }
      }
    }

    // Watch for new plugins
    try {
      this.watcher = fs.watch(PLUGINS_DIR, { persistent: false }, () => {
        // Debounce: re-discover after a short delay
        if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
        this._rediscoverTimer = setTimeout(() => this.discover(), 1000);
      });
    } catch (err) {
      console.log("[wotch:plugins] Watch failed:", err.message);
    }
    console.log(`[wotch:plugins] Initialized, ${this.plugins.size} plugins discovered`);
  }

  async discover() {
    let dirs;
    try {
      dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch { dirs = []; }

    for (const dir of dirs) {
      if (this.plugins.has(dir.name)) continue; // Already known
      const manifestPath = path.join(PLUGINS_DIR, dir.name, "manifest.json");
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const errors = validateManifest(raw, dir.name);
        if (errors.length > 0) {
          console.warn(`[wotch:plugins] Invalid manifest for '${dir.name}':`, errors);
          this.plugins.set(dir.name, { manifest: raw, state: "invalid", context: null, module: null, errors });
        } else {
          // Check entry point files exist
          const pluginDir = path.join(PLUGINS_DIR, dir.name);
          if (raw.main && !fs.existsSync(path.join(pluginDir, raw.main))) {
            console.warn(`[wotch:plugins] '${dir.name}': main file '${raw.main}' not found`);
            this.plugins.set(dir.name, { manifest: raw, state: "invalid", context: null, module: null, errors: [`Main file '${raw.main}' not found`] });
            continue;
          }
          if (raw.renderer && !fs.existsSync(path.join(pluginDir, raw.renderer))) {
            console.warn(`[wotch:plugins] '${dir.name}': renderer file '${raw.renderer}' not found`);
            this.plugins.set(dir.name, { manifest: raw, state: "invalid", context: null, module: null, errors: [`Renderer file '${raw.renderer}' not found`] });
            continue;
          }
          this.plugins.set(dir.name, { manifest: raw, state: "validated", context: null, module: null, errors: [] });
          console.log(`[wotch:plugins] Discovered: ${dir.name} v${raw.version}`);
        }
      } catch (err) {
        if (fs.existsSync(manifestPath)) {
          console.warn(`[wotch:plugins] Failed to parse manifest for '${dir.name}':`, err.message);
          this.plugins.set(dir.name, { manifest: null, state: "invalid", context: null, module: null, errors: [err.message] });
        }
        // No manifest.json = skip silently
      }
    }
  }

  async activate(id) {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.state === "activated") return;
    if (plugin.state === "invalid") { console.warn(`[wotch:plugins] Cannot activate invalid plugin: ${id}`); return; }

    const manifest = plugin.manifest;
    const pluginDir = path.join(PLUGINS_DIR, id);

    // Get granted permissions
    const pluginConfig = settings.plugins && settings.plugins[id];
    const grantedPermissions = new Set();
    if (pluginConfig && pluginConfig.permissions) {
      for (const [perm, state] of Object.entries(pluginConfig.permissions)) {
        if (state === "granted") grantedPermissions.add(perm);
      }
    }

    // Main-process activation via vm context
    if (manifest.main) {
      try {
        const api = createPluginApi(id, manifest, grantedPermissions, this);
        const scopedConsole = createScopedConsole(id);

        const sandbox = {
          console: scopedConsole,
          setTimeout, setInterval, clearTimeout, clearInterval,
          Promise, JSON, Math, Date,
          Map, Set, WeakMap, WeakSet,
          Array, Object, String, Number, Boolean,
          Error, TypeError, RangeError, SyntaxError, ReferenceError,
          RegExp, Symbol, Proxy, Reflect,
          URL, URLSearchParams,
          TextEncoder, TextDecoder,
          atob, btoa,
          wotch: api,
          module: { exports: {} },
          exports: {},
        };

        const context = vm.createContext(sandbox, {
          name: `plugin:${id}`,
          codeGeneration: { strings: false, wasm: false },
        });

        const code = fs.readFileSync(path.join(pluginDir, manifest.main), "utf-8");
        vm.runInContext(code, context, { filename: manifest.main, timeout: PLUGIN_LIFECYCLE_TIMEOUT });

        const pluginModule = context.module.exports || context.exports;
        plugin.context = context;
        plugin.module = pluginModule;

        // Call activate with a 5s timeout
        if (typeof pluginModule.activate === "function") {
          await Promise.race([
            Promise.resolve(pluginModule.activate({
              pluginPath: pluginDir,
              manifest,
              storage: this._createStorage(id),
              subscriptions: [],
            })),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Activation timed out")), PLUGIN_LIFECYCLE_TIMEOUT)),
          ]);
        }
      } catch (err) {
        console.error(`[wotch:plugins] Failed to activate '${id}':`, err.message);
        plugin.state = "error";
        plugin.errors = [err.message];
        return;
      }
    }

    // Register theme contributions (declarative, no code needed)
    if (manifest.contributes && manifest.contributes.themes) {
      for (const theme of manifest.contributes.themes) {
        this.registerTheme(id, theme);
      }
    }

    plugin.state = "activated";
    this._savePluginEnabled(id, true);
    this.errorCounts.set(id, { count: 0, firstError: 0 });
    console.log(`[wotch:plugins] Activated: ${id}`);

    // Notify renderer of plugin activation
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-status-update", this.getPluginList());
    }
  }

  async deactivate(id) {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.state !== "activated") return;

    // Call deactivate with timeout
    if (plugin.module && typeof plugin.module.deactivate === "function") {
      try {
        await Promise.race([
          Promise.resolve(plugin.module.deactivate()),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Deactivation timed out")), PLUGIN_LIFECYCLE_TIMEOUT)),
        ]);
      } catch (err) {
        console.warn(`[wotch:plugins] Deactivation error for '${id}':`, err.message);
      }
    }

    // Remove all contributions
    for (const [cmdId, cmd] of [...this.commands]) {
      if (cmd.pluginId === id) this.commands.delete(cmdId);
    }
    for (const [detId, det] of [...this.detectors]) {
      if (det.pluginId === id) this.detectors.delete(detId);
    }
    for (const [panelId, panel] of [...this.panels]) {
      if (panel.pluginId === id) this.panels.delete(panelId);
    }
    this.statusListeners = this.statusListeners.filter(l => l.pluginId !== id);
    this.terminalListeners = this.terminalListeners.filter(l => l.pluginId !== id);
    this.expansionListeners = this.expansionListeners.filter(l => l.pluginId !== id);
    for (const key of ["created", "closed", "activated"]) {
      this.tabListeners[key] = this.tabListeners[key].filter(l => l.pluginId !== id);
    }
    for (const [settingId, listeners] of this.settingListeners) {
      this.settingListeners.set(settingId, listeners.filter(l => l.pluginId !== id));
    }
    this.projectListeners = this.projectListeners.filter(l => l.pluginId !== id);

    plugin.context = null;
    plugin.module = null;
    plugin.state = "deactivated";
    this._savePluginEnabled(id, false);
    console.log(`[wotch:plugins] Deactivated: ${id}`);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-status-update", this.getPluginList());
    }
  }

  async deactivateAll() {
    for (const [id, plugin] of this.plugins) {
      if (plugin.state === "activated") {
        await this.deactivate(id);
      }
    }
  }

  getPluginList() {
    const list = [];
    for (const [id, plugin] of this.plugins) {
      const pluginConfig = settings.plugins && settings.plugins[id];
      list.push({
        id,
        displayName: plugin.manifest ? plugin.manifest.displayName : id,
        description: plugin.manifest ? plugin.manifest.description : "",
        version: plugin.manifest ? plugin.manifest.version : "?",
        state: plugin.state,
        errors: plugin.errors,
        permissions: plugin.manifest ? (plugin.manifest.permissions || []) : [],
        grantedPermissions: pluginConfig ? pluginConfig.permissions || {} : {},
        enabled: pluginConfig ? !!pluginConfig.enabled : false,
        contributes: plugin.manifest ? (plugin.manifest.contributes || {}) : {},
      });
    }
    return list;
  }

  // ── Command registration ──
  registerCommand(pluginId, cmd) {
    this.commands.set(cmd.id, { pluginId, title: cmd.title, handler: cmd.handler });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-command-registered", { id: cmd.id, title: cmd.title, pluginId });
    }
  }

  unregisterCommand(pluginId, commandId) {
    const cmd = this.commands.get(commandId);
    if (cmd && cmd.pluginId === pluginId) this.commands.delete(commandId);
  }

  async executeCommand(commandId) {
    const cmd = this.commands.get(commandId);
    if (!cmd) throw new Error(`Unknown command: ${commandId}`);
    try {
      await Promise.resolve(cmd.handler());
    } catch (err) {
      this._handlePluginError(cmd.pluginId, err);
    }
  }

  listCommands() {
    return [...this.commands.entries()].map(([id, cmd]) => id);
  }

  // ── Status detector registration ──
  registerDetector(pluginId, detectorId, callback) {
    const manifest = this.plugins.get(pluginId)?.manifest;
    const declared = manifest?.contributes?.statusDetectors?.find(d => d.id === detectorId);
    const priority = declared ? (declared.priority || 50) : 50;
    this.detectors.set(detectorId, { pluginId, callback, priority });
  }

  unregisterDetector(pluginId, detectorId) {
    const det = this.detectors.get(detectorId);
    if (det && det.pluginId === pluginId) this.detectors.delete(detectorId);
  }

  feedTerminalData(tabId, rawData, cleanData) {
    // Feed plugin status detectors
    for (const [detId, det] of this.detectors) {
      try {
        const result = det.callback({ tabId, rawData, cleanData });
        if (result && result.state) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("plugin-status-update", {
              detectorId: detId, pluginId: det.pluginId,
              tabId, state: result.state, description: result.description || "",
            });
          }
        }
      } catch (err) {
        this._handlePluginError(det.pluginId, err);
      }
    }

    // Feed terminal data listeners
    for (const listener of this.terminalListeners) {
      try {
        listener.callback({ tabId, data: rawData });
      } catch (err) {
        this._handlePluginError(listener.pluginId, err);
      }
    }
  }

  // ── Panel registration ──
  registerPanel(pluginId, panel) {
    this.panels.set(panel.id, { pluginId, title: panel.title, html: panel.html || "", icon: panel.icon, location: panel.location || "sidebar" });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-panel-registered", {
        id: panel.id, pluginId, title: panel.title, html: panel.html || "", icon: panel.icon, location: panel.location || "sidebar",
      });
    }
  }

  unregisterPanel(pluginId, panelId) {
    const panel = this.panels.get(panelId);
    if (panel && panel.pluginId === pluginId) this.panels.delete(panelId);
  }

  updatePanel(pluginId, panelId, html) {
    const panel = this.panels.get(panelId);
    if (panel && panel.pluginId === pluginId) {
      panel.html = html;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("plugin-panel-registered", { id: panelId, pluginId, title: panel.title, html, icon: panel.icon, location: panel.location });
      }
    }
  }

  postPanelMessage(pluginId, panelId, data) {
    // Panel messaging handled via renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-panel-message", { panelId, pluginId, data });
    }
  }

  setPanelVisible(pluginId, panelId, visible) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-panel-visible", { panelId, pluginId, visible });
    }
  }

  // ── Theme registration ──
  registerTheme(pluginId, theme) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-theme-registered", { id: theme.id, name: theme.name, colors: theme.colors, pluginId });
    }
  }

  // ── Notification ──
  showNotification(pluginId, options) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-notification", { pluginId, message: options.message, type: options.type || "info", duration: options.duration || 3000 });
    }
  }

  // ── Listeners ──
  addStatusListener(pluginId, callback) { this.statusListeners.push({ pluginId, callback }); }
  removeStatusListener(pluginId, callback) { this.statusListeners = this.statusListeners.filter(l => !(l.pluginId === pluginId && l.callback === callback)); }
  addTerminalListener(pluginId, callback) { this.terminalListeners.push({ pluginId, callback }); }
  removeTerminalListener(pluginId, callback) { this.terminalListeners = this.terminalListeners.filter(l => !(l.pluginId === pluginId && l.callback === callback)); }
  addExpansionListener(pluginId, callback) { this.expansionListeners.push({ pluginId, callback }); }
  removeExpansionListener(pluginId, callback) { this.expansionListeners = this.expansionListeners.filter(l => !(l.pluginId === pluginId && l.callback === callback)); }
  addTabListener(pluginId, event, callback) { this.tabListeners[event].push({ pluginId, callback }); }
  removeTabListener(pluginId, event, callback) { this.tabListeners[event] = this.tabListeners[event].filter(l => !(l.pluginId === pluginId && l.callback === callback)); }
  addSettingListener(pluginId, settingId, callback) {
    if (!this.settingListeners.has(settingId)) this.settingListeners.set(settingId, []);
    this.settingListeners.get(settingId).push({ pluginId, callback });
  }
  removeSettingListener(pluginId, settingId, callback) {
    if (this.settingListeners.has(settingId)) {
      this.settingListeners.set(settingId, this.settingListeners.get(settingId).filter(l => !(l.pluginId === pluginId && l.callback === callback)));
    }
  }
  addProjectListener(pluginId, callback) { this.projectListeners.push({ pluginId, callback }); }
  removeProjectListener(pluginId, callback) { this.projectListeners = this.projectListeners.filter(l => !(l.pluginId === pluginId && l.callback === callback)); }

  emitStatusChanged(status) {
    for (const l of this.statusListeners) {
      try { l.callback(status); } catch (err) { this._handlePluginError(l.pluginId, err); }
    }
  }

  emitExpansionChanged(expanded) {
    for (const l of this.expansionListeners) {
      try { l.callback(expanded); } catch (err) { this._handlePluginError(l.pluginId, err); }
    }
  }

  emitTabEvent(event, data) {
    for (const l of this.tabListeners[event] || []) {
      try { l.callback(data); } catch (err) { this._handlePluginError(l.pluginId, err); }
    }
  }

  emitSettingChanged(pluginId, settingId, oldValue, newValue) {
    const listeners = this.settingListeners.get(settingId) || [];
    for (const l of listeners) {
      try { l.callback({ id: settingId, oldValue, newValue }); } catch (err) { this._handlePluginError(l.pluginId, err); }
    }
  }

  getAllStatuses() {
    const statuses = [];
    for (const [tabId, tab] of claudeStatus.tabs) {
      statuses.push({ tabId, state: tab.state, description: tab.description });
    }
    return statuses;
  }

  getTabStatus(tabId) {
    const tab = claudeStatus.tabs.get(tabId);
    return tab ? { tabId, state: tab.state, description: tab.description } : null;
  }

  // ── Plugin settings persistence ──
  _savePluginEnabled(id, enabled) {
    if (!settings.plugins) settings.plugins = {};
    if (!settings.plugins[id]) settings.plugins[id] = {};
    settings.plugins[id].enabled = enabled;
    saveSettings(settings);
  }

  _createStorage(pluginId) {
    const storageDir = path.join(PLUGIN_DATA_DIR, pluginId);
    const storageFile = path.join(storageDir, "storage.json");
    let cache = null;

    const load = () => {
      if (cache) return cache;
      try { cache = JSON.parse(fs.readFileSync(storageFile, "utf-8")); }
      catch { cache = {}; }
      return cache;
    };

    const save = () => {
      try {
        fs.mkdirSync(storageDir, { recursive: true });
        fs.writeFileSync(storageFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
      } catch (err) { console.error(`[wotch:plugins] Storage save failed for ${pluginId}:`, err.message); }
    };

    return {
      get: (key) => Promise.resolve(load()[key]),
      set: (key, value) => { load()[key] = value; save(); return Promise.resolve(); },
      delete: (key) => { delete load()[key]; save(); return Promise.resolve(); },
      keys: () => Promise.resolve(Object.keys(load())),
    };
  }

  // ── Error handling ──
  _handlePluginError(pluginId, err) {
    console.error(`[wotch:plugin:${pluginId}] Error:`, err.message || err);
    const counts = this.errorCounts.get(pluginId) || { count: 0, firstError: Date.now() };
    counts.count++;
    if (counts.count === 1) counts.firstError = Date.now();

    // Auto-deactivate after 10 errors in 60 seconds
    if (counts.count >= 10 && (Date.now() - counts.firstError) < 60000) {
      console.error(`[wotch:plugins] Auto-deactivating '${pluginId}' after ${counts.count} errors`);
      this.deactivate(pluginId);
      this.showNotification(pluginId, { message: `Plugin "${pluginId}" was disabled due to repeated errors`, type: "error" });
    }
    this.errorCounts.set(pluginId, counts);
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
  }
}

const pluginHost = new PluginHost();

// ── Agent SDK Integration ──────────────────────────────────────────

const AGENTS_DIR = path.join(os.homedir(), ".wotch", "agents");
const AGENT_LOGS_DIR = path.join(os.homedir(), ".wotch", "agent-logs");
const AGENT_TRUST_FILE = path.join(os.homedir(), ".wotch", "agent-trust.json");
const BUILTIN_AGENTS_DIR = path.join(__dirname, "agents");

const MAX_AGENT_DEPTH = 3; // Maximum nesting depth for sub-agent spawning

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-[rf]+\s+)?\//, /\bgit\s+push\s+--force/, /\bgit\s+reset\s+--hard/,
  /\bsudo\b/, /\bchmod\s+777\b/, /\bcurl\b.*\|\s*sh/, /\bwget\b.*\|\s*sh/,
  /\bdd\s+if=/, /\bmkfs\b/, />\s*\/dev\//, /\brm\s+-rf\s+\./,
];

const TOOL_DANGER_LEVELS = {
  "Shell.execute": "write", "Shell.readVisibleTerminal": "read",
  "FileSystem.readFile": "read", "FileSystem.writeFile": "write",
  "FileSystem.listFiles": "read", "FileSystem.searchFiles": "read",
  "FileSystem.deleteFile": "dangerous",
  "Git.status": "safe", "Git.diff": "read", "Git.log": "read",
  "Git.checkpoint": "write", "Git.branchInfo": "safe",
  "Terminal.readBuffer": "read", "Terminal.detectPattern": "read",
  "Project.list": "safe", "Project.getInfo": "safe",
  "Wotch.getStatus": "safe", "Wotch.showNotification": "safe",
  "Agent.spawn": "write",
};

function loadAgentTrust() {
  try {
    if (fs.existsSync(AGENT_TRUST_FILE)) return JSON.parse(fs.readFileSync(AGENT_TRUST_FILE, "utf-8"));
  } catch { /* fallback */ }
  return {};
}

function saveAgentTrust(trust) {
  try {
    fs.mkdirSync(path.dirname(AGENT_TRUST_FILE), { recursive: true });
    fs.writeFileSync(AGENT_TRUST_FILE, JSON.stringify(trust, null, 2), { mode: 0o600 });
  } catch (err) { console.error("[wotch:agents] Failed to save trust:", err.message); }
}

function parseAgentYaml(content) {
  // Simple YAML parser for agent definitions (handles the subset we need)
  const result = {};
  let currentKey = null;
  let multilineValue = "";
  let inMultiline = false;
  let indent = 0;
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (inMultiline) {
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent > indent || trimmed === "") {
        multilineValue += (multilineValue ? "\n" : "") + line.slice(indent + 2);
        continue;
      } else {
        result[currentKey] = multilineValue;
        inMultiline = false;
      }
    }

    if (trimmed.startsWith("#") || trimmed === "") continue;

    const match = trimmed.match(/^(\w+)\s*:\s*(.*)/);
    if (match) {
      const [, key, rawVal] = match;
      const val = rawVal.trim();

      if (val === "|" || val === ">") {
        currentKey = key;
        multilineValue = "";
        inMultiline = true;
        indent = line.length - trimmed.length;
        continue;
      }

      if (val.startsWith("[")) {
        // Inline array
        try { result[key] = JSON.parse(val); } catch { result[key] = []; }
      } else if (val.startsWith("-") || val === "") {
        // Block array — collect items
        const items = [];
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine.startsWith("- ")) {
            const itemContent = nextLine.slice(2).trim();
            // Check if it's a simple value or an object
            if (itemContent.includes(":")) {
              const obj = {};
              const parts = itemContent.split(/,\s*/);
              for (const part of parts) {
                const [k, ...v] = part.split(":");
                if (k && v.length) obj[k.trim()] = v.join(":").trim().replace(/^["']|["']$/g, "");
              }
              // Check subsequent indented lines for same object
              for (let k = j + 1; k < lines.length; k++) {
                const subLine = lines[k];
                const subTrimmed = subLine.trim();
                if (subTrimmed && !subTrimmed.startsWith("-") && subTrimmed.includes(":") && (subLine.length - subTrimmed.length) > (lines[j].length - lines[j].trim().length)) {
                  const [sk, ...sv] = subTrimmed.split(":");
                  if (sk && sv.length) obj[sk.trim()] = sv.join(":").trim().replace(/^["']|["']$/g, "");
                  j = k;
                } else break;
              }
              items.push(obj);
            } else {
              items.push(itemContent.replace(/^["']|["']$/g, ""));
            }
          } else if (nextLine === "" || !nextLine.startsWith(" ")) {
            break;
          }
          i = j;
        }
        if (items.length > 0) result[key] = items;
        else if (val !== "") result[key] = val;
      } else if (val === "true") result[key] = true;
      else if (val === "false") result[key] = false;
      else if (/^\d+$/.test(val)) result[key] = parseInt(val, 10);
      else if (/^\d+\.\d+$/.test(val)) result[key] = parseFloat(val);
      else result[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  if (inMultiline) result[currentKey] = multilineValue;
  return result;
}

function validateAgentDef(def) {
  const errors = [];
  if (!def.name || typeof def.name !== "string") errors.push("Missing 'name'");
  if (!def.description) errors.push("Missing 'description'");
  if (!def.systemPrompt) errors.push("Missing 'systemPrompt'");
  if (!def.tools || !Array.isArray(def.tools) || def.tools.length === 0) errors.push("Missing or empty 'tools'");
  if (def.maxTurns && (def.maxTurns < 1 || def.maxTurns > 50)) errors.push("maxTurns must be 1-50");
  if (def.approvalMode && !["suggest-only", "ask-first", "auto-execute"].includes(def.approvalMode)) {
    errors.push("Invalid approvalMode");
  }
  return errors;
}

function renderSystemPrompt(template, context) {
  return template
    .replace(/\{\{projectName\}\}/g, context.projectName || "unknown")
    .replace(/\{\{projectPath\}\}/g, context.projectPath || "")
    .replace(/\{\{branch\}\}/g, context.branch || "main")
    .replace(/\{\{platform\}\}/g, IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux")
    .replace(/\{\{date\}\}/g, new Date().toISOString().split("T")[0]);
}

// ── Agent Tool Implementations ──
function createAgentTools(context) {
  const projectPath = context.projectPath || "";
  function ensureInProject(p) {
    const resolved = path.resolve(projectPath, p);
    if (!resolved.startsWith(path.resolve(projectPath))) throw new Error("Path outside project directory");
    return resolved;
  }

  return {
    "Shell.execute": async (input) => {
      const { command, cwd, timeoutMs = 30000 } = input;
      const workDir = cwd ? ensureInProject(cwd) : projectPath;
      return new Promise((resolve) => {
        let stdout = "";
        let timedOut = false;
        const startTime = Date.now();
        const shell = IS_WIN ? "cmd.exe" : (process.env.SHELL || "/bin/bash");
        const shellFlag = IS_WIN ? "/c" : "-c";
        const proc = pty.spawn(shell, [shellFlag, command], {
          name: "xterm-256color", cols: 120, rows: 40, cwd: workDir,
          env: { ...process.env, TERM: "xterm-256color" },
        });
        const timer = setTimeout(() => { timedOut = true; proc.kill(); }, Math.min(timeoutMs, 120000));
        proc.onData((data) => {
          stdout += claudeStatus.stripAnsi(data);
          if (stdout.length > 102400) { stdout = stdout.slice(0, 102400) + "\n[truncated]"; proc.kill(); }
        });
        proc.onExit(({ exitCode }) => {
          clearTimeout(timer);
          resolve({ exitCode: exitCode || 0, stdout, stderr: "", timedOut, durationMs: Date.now() - startTime });
        });
      });
    },

    "Shell.readVisibleTerminal": async (input) => {
      const tabId = input.tabId || [...ptyProcesses.keys()][0];
      return { content: `(terminal buffer for ${tabId})` };
    },

    "FileSystem.readFile": async (input) => {
      const filePath = ensureInProject(input.path);
      const content = await fs.promises.readFile(filePath, "utf-8");
      if (content.length > 1048576) return { content: content.slice(0, 1048576) + "\n[truncated at 1MB]" };
      return { content };
    },

    "FileSystem.writeFile": async (input) => {
      const filePath = ensureInProject(input.path);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, input.content, { mode: 0o644 });
      return { success: true, path: input.path };
    },

    "FileSystem.listFiles": async (input) => {
      const dirPath = ensureInProject(input.path || ".");
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return { files: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })) };
    },

    "FileSystem.searchFiles": async (input) => {
      const searchDir = ensureInProject(input.path || ".");
      try {
        const result = execFileSync("grep", ["-rn", "--include=*.{js,ts,py,java,go,rs,c,cpp,h,yaml,yml,json,md}", "-l", input.pattern, searchDir], {
          encoding: "utf-8", timeout: 15000, maxBuffer: 1048576,
        });
        return { files: result.trim().split("\n").filter(Boolean).slice(0, 50) };
      } catch { return { files: [] }; }
    },

    "FileSystem.deleteFile": async (input) => {
      const filePath = ensureInProject(input.path);
      await fs.promises.unlink(filePath);
      return { success: true, path: input.path };
    },

    "Git.status": async () => {
      if (!projectPath) return { branch: "", changedFiles: 0, isGitRepo: false };
      return gitGetStatus(projectPath);
    },

    "Git.diff": async (input) => {
      try {
        const args = ["diff"];
        if (input?.mode === "staged") args.push("--cached");
        const diff = execFileSync("git", args, { cwd: projectPath, encoding: "utf-8", timeout: 10000, maxBuffer: 1048576 }) || "";
        return { diff };
      } catch (err) { return { diff: `Error: ${err.message}` }; }
    },

    "Git.log": async (input) => {
      try {
        const count = input?.count || 10;
        const raw = execFileSync("git", ["log", `--max-count=${count}`, "--format=%H|||%s|||%an|||%aI"], {
          cwd: projectPath, encoding: "utf-8", timeout: 10000,
        });
        return { commits: raw.trim().split("\n").filter(Boolean).map(l => {
          const [hash, message, author, date] = l.split("|||");
          return { hash, message, author, date };
        })};
      } catch { return { commits: [] }; }
    },

    "Git.checkpoint": async (input) => {
      return gitCheckpoint(projectPath, input?.message);
    },

    "Git.branchInfo": async () => {
      try {
        const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectPath, encoding: "utf-8", timeout: 5000 }).trim();
        return { branch };
      } catch { return { branch: "" }; }
    },

    "Terminal.readBuffer": async (input) => {
      // Request buffer from renderer
      if (!mainWindow || mainWindow.isDestroyed()) return { content: "(window not available)" };
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ content: "(timeout)" }), 3000);
        const handler = (_e, data) => { clearTimeout(timeout); ipcMain.removeHandler("_agent-terminal-buffer-response"); resolve({ content: data.buffer || "" }); };
        ipcMain.handleOnce("_agent-terminal-buffer-response", handler);
        mainWindow.webContents.send("terminal-buffer-read", { lines: input?.lines || 200, requestId: "agent" });
      });
    },

    "Terminal.detectPattern": async (input) => {
      return { matched: false, message: "Pattern detection requires active monitoring (not implemented in v1)" };
    },

    "Project.list": async () => {
      return { projects: [...knownProjectPaths].map(p => ({ path: p, name: path.basename(p) })) };
    },

    "Project.getInfo": async () => {
      const pp = projectPath || [...knownProjectPaths][0] || "";
      return { path: pp, name: path.basename(pp), platform: IS_WIN ? "win32" : IS_MAC ? "darwin" : "linux" };
    },

    "Wotch.getStatus": async () => {
      const aggregate = claudeStatus.getAggregateStatus();
      return { state: aggregate.state, description: aggregate.description };
    },

    "Wotch.showNotification": async (input) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("plugin-notification", { pluginId: "agent", message: input.message, type: input.type || "info", duration: 3000 });
      }
      return { success: true };
    },

    "Agent.spawn": async (input) => {
      // Sub-agent spawning — delegates to agentManager with parent tracking
      const { agentId, task: subTask } = input;
      if (!agentId) throw new Error("agentId is required");
      if (!subTask) throw new Error("task is required");
      if (agentId === context._currentAgentId) throw new Error("Agent cannot spawn itself");
      const depth = (context._agentDepth || 0) + 1;
      if (depth > MAX_AGENT_DEPTH) throw new Error(`Maximum agent nesting depth (${MAX_AGENT_DEPTH}) exceeded`);
      const result = await agentManager.startAgent(agentId, {
        task: subTask,
        projectPath: context.projectPath,
        _parentRunId: context._currentRunId,
        _agentDepth: depth,
      });
      return { runId: result.runId, agentId, status: "started" };
    },
  };
}

function getToolSchemas() {
  return [
    { name: "Shell.execute", description: "Execute a shell command", input_schema: { type: "object", properties: { command: { type: "string", description: "Shell command to execute" }, cwd: { type: "string", description: "Working directory (relative to project)" }, timeoutMs: { type: "number", description: "Timeout in ms (default 30000, max 120000)" } }, required: ["command"] } },
    { name: "FileSystem.readFile", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string", description: "File path relative to project root" } }, required: ["path"] } },
    { name: "FileSystem.writeFile", description: "Write content to a file", input_schema: { type: "object", properties: { path: { type: "string", description: "File path relative to project root" }, content: { type: "string", description: "File content" } }, required: ["path", "content"] } },
    { name: "FileSystem.listFiles", description: "List directory contents", input_schema: { type: "object", properties: { path: { type: "string", description: "Directory path (default: project root)" } } } },
    { name: "FileSystem.searchFiles", description: "Search file contents with regex", input_schema: { type: "object", properties: { pattern: { type: "string", description: "Search pattern (regex)" }, path: { type: "string", description: "Directory to search" } }, required: ["pattern"] } },
    { name: "FileSystem.deleteFile", description: "Delete a file (dangerous)", input_schema: { type: "object", properties: { path: { type: "string", description: "File path to delete" } }, required: ["path"] } },
    { name: "Git.status", description: "Get git repository status", input_schema: { type: "object", properties: {} } },
    { name: "Git.diff", description: "Get git diff", input_schema: { type: "object", properties: { mode: { type: "string", enum: ["staged", "unstaged", "all"], description: "Diff mode" } } } },
    { name: "Git.log", description: "Get recent commit log", input_schema: { type: "object", properties: { count: { type: "number", description: "Number of commits (default 10)" } } } },
    { name: "Git.checkpoint", description: "Create a Wotch checkpoint", input_schema: { type: "object", properties: { message: { type: "string", description: "Checkpoint message" } } } },
    { name: "Git.branchInfo", description: "Get current branch name", input_schema: { type: "object", properties: {} } },
    { name: "Terminal.readBuffer", description: "Read recent terminal output", input_schema: { type: "object", properties: { lines: { type: "number", description: "Lines to read (default 200, max 500)" } } } },
    { name: "Terminal.detectPattern", description: "Wait for pattern in terminal output", input_schema: { type: "object", properties: { pattern: { type: "string", description: "Regex pattern to detect" }, timeoutMs: { type: "number", description: "Timeout in ms" } }, required: ["pattern"] } },
    { name: "Project.list", description: "List all detected projects", input_schema: { type: "object", properties: {} } },
    { name: "Project.getInfo", description: "Get current project information", input_schema: { type: "object", properties: {} } },
    { name: "Wotch.getStatus", description: "Get Claude Code status", input_schema: { type: "object", properties: {} } },
    { name: "Wotch.showNotification", description: "Show a notification", input_schema: { type: "object", properties: { message: { type: "string", description: "Notification message" }, type: { type: "string", enum: ["info", "success", "error"] } }, required: ["message"] } },
    { name: "Agent.spawn", description: "Spawn a sub-agent to handle a subtask", input_schema: { type: "object", properties: { agentId: { type: "string", description: "Agent ID to spawn" }, task: { type: "string", description: "Task description for the sub-agent" } }, required: ["agentId", "task"] } },
  ];
}

class AgentRuntime {
  constructor(agentDef, apiKey, tools, trustMode, onEvent, opts = {}) {
    this.agent = agentDef;
    this.apiKey = apiKey;
    this.tools = tools;
    this.trustMode = trustMode;
    this.onEvent = onEvent;
    this.runId = crypto.randomUUID();
    this.messages = [];
    this.iteration = 0;
    this.cancelled = false;
    this.state = "idle";
    this.pendingApprovals = new Map();
    this.logEntries = [];
    this.parentRunId = opts.parentRunId || null;
    this.depth = opts.depth || 0;
    this.childRunIds = [];
  }

  async run(task, context) {
    this.state = "running";
    const systemPrompt = renderSystemPrompt(this.agent.systemPrompt, context);
    this.messages = [{ role: "user", content: task }];
    const maxTurns = this.agent.maxTurns || 10;

    this.onEvent({ runId: this.runId, type: "started", data: { agentId: this.agent.name, agentName: this.agent.displayName || this.agent.name, context } });
    this._log("agent-start", { agentId: this.agent.name, task });

    // Filter tool schemas for this agent
    const allSchemas = getToolSchemas();
    const agentToolNames = new Set();
    for (const t of (this.agent.tools || [])) {
      if (t.endsWith(".*")) {
        const category = t.slice(0, -2);
        for (const s of allSchemas) { if (s.name.startsWith(category + ".")) agentToolNames.add(s.name); }
      } else {
        agentToolNames.add(t);
      }
    }
    const toolDefs = allSchemas.filter(s => agentToolNames.has(s.name));

    try {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: this.apiKey });

      while (this.iteration < maxTurns && !this.cancelled) {
        this.iteration++;
        this.onEvent({ runId: this.runId, type: "reasoning", data: { text: `Turn ${this.iteration}/${maxTurns}...` } });

        const response = await client.messages.create({
          model: this.agent.model || "claude-sonnet-4-6-20250514",
          system: systemPrompt,
          messages: this.messages,
          tools: toolDefs,
          max_tokens: 4096,
        });

        this.messages.push({ role: "assistant", content: response.content });

        // Extract text and tool_use blocks
        const textBlocks = response.content.filter(b => b.type === "text");
        const toolUses = response.content.filter(b => b.type === "tool_use");

        // Stream reasoning text
        for (const block of textBlocks) {
          this.onEvent({ runId: this.runId, type: "reasoning", data: { text: block.text } });
        }

        if (toolUses.length === 0) {
          // Agent is done
          const resultText = textBlocks.map(b => b.text).join("");
          this.state = "completed";
          this.onEvent({ runId: this.runId, type: "completed", data: { summary: resultText, turnsUsed: this.iteration } });
          this._log("agent-complete", { turnsUsed: this.iteration });
          this._flushLog();
          return resultText;
        }

        // Execute tool calls
        const toolResults = [];
        for (const toolUse of toolUses) {
          if (this.cancelled) break;

          this.onEvent({ runId: this.runId, type: "tool-call", data: { tool: toolUse.name, input: toolUse.input } });

          // Check approval
          const needsApproval = this._needsApproval(toolUse.name, toolUse.input);
          if (needsApproval) {
            this.state = "waiting-approval";
            const actionId = crypto.randomUUID();
            const decision = await this._requestApproval(actionId, toolUse.name, toolUse.input);

            if (decision === "reject" || decision === "stop") {
              this._log("approval-response", { actionId, decision });
              if (decision === "stop") { this.cancelled = true; break; }
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User rejected this action", is_error: true });
              this.state = "running";
              continue;
            }
            this.state = "running";
            this._log("approval-response", { actionId, decision: "approve" });
          }

          // Execute the tool
          const startTime = Date.now();
          try {
            const toolFn = this.tools[toolUse.name];
            if (!toolFn) throw new Error(`Unknown tool: ${toolUse.name}`);
            const result = await toolFn(toolUse.input);
            const output = typeof result === "string" ? result : JSON.stringify(result);
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: output });
            // Sanitize input before sending to renderer — strip large content and potential secrets
            const safeInput = { ...toolUse.input };
            if (safeInput.content && safeInput.content.length > 500) safeInput.content = safeInput.content.slice(0, 500) + "...[truncated]";
            if (safeInput.password) safeInput.password = "***";
            if (safeInput.apiKey) safeInput.apiKey = "***";
            if (safeInput.token) safeInput.token = "***";
            this.onEvent({ runId: this.runId, type: "tool-result", data: { tool: toolUse.name, input: safeInput, output, durationMs: Date.now() - startTime } });
            this._log("tool-call", { tool: toolUse.name, input: toolUse.input, output: output.slice(0, 500), durationMs: Date.now() - startTime });
          } catch (err) {
            const errMsg = `Error: ${err.message}`;
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: errMsg, is_error: true });
            this.onEvent({ runId: this.runId, type: "error", data: { message: err.message } });
            this._log("error", { tool: toolUse.name, error: err.message });
          }
        }

        if (this.cancelled) break;
        this.messages.push({ role: "user", content: toolResults });
      }
    } catch (err) {
      this.state = "failed";
      this.onEvent({ runId: this.runId, type: "error", data: { message: err.message } });
      this._log("error", { error: err.message });
      this._flushLog();
      return `Agent failed: ${err.message}`;
    }

    if (this.cancelled) {
      this.state = "stopped";
      this.onEvent({ runId: this.runId, type: "stopped", data: { reason: "cancelled" } });
      this._log("agent-stop", { reason: "cancelled" });
    } else {
      this.state = "completed";
      this.onEvent({ runId: this.runId, type: "completed", data: { summary: "Reached maximum iterations", turnsUsed: this.iteration } });
      this._log("agent-complete", { turnsUsed: this.iteration, reason: "max-turns" });
    }
    this._flushLog();
    return this.cancelled ? "Agent stopped" : "Agent reached maximum iterations";
  }

  stop() {
    this.cancelled = true;
    // Resolve any pending approvals as rejected
    for (const [, resolver] of this.pendingApprovals) {
      resolver("stop");
    }
    this.pendingApprovals.clear();
    // Stop child agents recursively (regardless of state)
    for (const childRunId of this.childRunIds) {
      const childRuntime = agentManager.runs.get(childRunId);
      if (childRuntime) childRuntime.stop();
    }
  }

  _needsApproval(toolName, toolInput) {
    const dangerLevel = TOOL_DANGER_LEVELS[toolName] || "write";

    // Dangerous actions always need approval
    if (dangerLevel === "dangerous") return true;

    // Check for dangerous command patterns in Shell.execute
    if (toolName === "Shell.execute" && toolInput.command) {
      for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
        if (pattern.test(toolInput.command)) return true;
      }
    }

    // Approval based on trust mode
    switch (this.trustMode) {
      case "suggest-only": return true; // Everything needs approval
      case "ask-first": return dangerLevel === "write" || dangerLevel === "dangerous";
      case "auto-execute": return dangerLevel === "dangerous";
      default: return true;
    }
  }

  async _requestApproval(actionId, toolName, toolInput) {
    this.onEvent({
      runId: this.runId, type: "approval-waiting",
      data: { actionId, tool: toolName, input: toolInput },
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-approval-request", {
        runId: this.runId, actionId, agentName: this.agent.displayName || this.agent.name,
        tool: toolName, input: toolInput,
      });
    }
    return new Promise((resolve) => {
      this.pendingApprovals.set(actionId, resolve);
      // Timeout: auto-reject after approval timeout
      setTimeout(() => {
        if (this.pendingApprovals.has(actionId)) {
          this.pendingApprovals.delete(actionId);
          resolve("reject");
        }
      }, settings.agentSettings?.approvalTimeoutMs || 300000);
    });
  }

  resolveApproval(actionId, decision) {
    const resolver = this.pendingApprovals.get(actionId);
    if (resolver) {
      this.pendingApprovals.delete(actionId);
      resolver(decision);
    }
  }

  _log(type, data) {
    this.logEntries.push({ timestamp: new Date().toISOString(), runId: this.runId, agentId: this.agent.name, type, ...data });
  }

  _flushLog() {
    try {
      const logDir = path.join(AGENT_LOGS_DIR, this.agent.name);
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `${this.runId}.jsonl`);
      const content = this.logEntries.map(e => JSON.stringify(e)).join("\n") + "\n";
      fs.writeFileSync(logFile, content, { mode: 0o600 });
    } catch (err) {
      console.error("[wotch:agents] Failed to flush log:", err.message);
    }
  }
}

class AgentManager {
  constructor() {
    this.agents = new Map();     // agentId → agent definition
    this.runs = new Map();       // runId → AgentRuntime
    this.trust = loadAgentTrust();
    this.watcher = null;
    this.triggerDebounce = new Map(); // agentId → lastTriggerTime
  }

  async init() {
    try { fs.mkdirSync(AGENTS_DIR, { recursive: true }); } catch { /* ok */ }
    try { fs.mkdirSync(AGENT_LOGS_DIR, { recursive: true }); } catch { /* ok */ }

    // Discover agents
    this._discoverAgents();

    // Watch for changes
    try {
      this.watcher = fs.watch(AGENTS_DIR, { persistent: false }, () => {
        if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
        this._rediscoverTimer = setTimeout(() => {
          this._discoverAgents();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("agent-list-changed", { agents: this.getAgentList() });
          }
        }, 1000);
      });
    } catch { /* ok */ }

    // Prune old logs on startup
    this._pruneLogs();

    console.log(`[wotch:agents] Initialized, ${this.agents.size} agents discovered`);
  }

  _discoverAgents() {
    // Built-in agents (from src/agents/)
    this._scanDir(BUILTIN_AGENTS_DIR, "built-in");
    // User agents (from ~/.wotch/agents/)
    this._scanDir(AGENTS_DIR, "user");
  }

  _scanDir(dir, source) {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"));
      for (const file of files) {
        try {
          const filePath = path.join(dir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          let def;
          if (file.endsWith(".json")) {
            def = JSON.parse(content);
          } else {
            def = parseAgentYaml(content);
          }
          const errors = validateAgentDef(def);
          if (errors.length > 0) {
            console.warn(`[wotch:agents] Invalid agent '${file}':`, errors);
            continue;
          }
          def._source = source;
          def._filePath = filePath;
          // User agents override built-in with same name
          if (source === "user" || !this.agents.has(def.name)) {
            this.agents.set(def.name, def);
            console.log(`[wotch:agents] Discovered: ${def.name} (${source})`);
          }
        } catch (err) {
          console.warn(`[wotch:agents] Failed to parse '${file}':`, err.message);
        }
      }
    } catch { /* dir doesn't exist yet */ }
  }

  getAgentList() {
    const list = [];
    for (const [id, def] of this.agents) {
      const trustInfo = this.trust[id] || {};
      list.push({
        id, displayName: def.displayName || def.name, description: def.description,
        version: def.version || "1.0.0", model: def.model || "claude-sonnet-4-6-20250514",
        tools: def.tools || [], triggers: def.triggers || [{ type: "manual" }],
        approvalMode: trustInfo.mode || def.approvalMode || settings.agentSettings?.defaultApprovalMode || "ask-first",
        source: def._source, maxTurns: def.maxTurns || 10,
        runCount: trustInfo.runCount || 0,
      });
    }
    return list;
  }

  async startAgent(agentId, context = {}) {
    if (!settings.agentSettings?.enabled) throw new Error("Agent system is disabled");

    const def = this.agents.get(agentId);
    if (!def) throw new Error(`Unknown agent: ${agentId}`);

    // Check concurrent limit
    const running = [...this.runs.values()].filter(r => r.state === "running" || r.state === "waiting-approval");
    if (running.length >= (settings.agentSettings?.maxConcurrentAgents || 3)) {
      throw new Error("Maximum concurrent agents reached");
    }

    // Get API key from credential manager
    const apiKey = credentialManager.getKey();
    if (!apiKey) throw new Error("No API key configured. Set your Anthropic API key in Settings > Claude API.");

    // Get project context
    const projectPath = context.projectPath || [...knownProjectPaths][0] || "";
    const agentContext = {
      projectPath,
      projectName: projectPath ? path.basename(projectPath) : "unknown",
      branch: "",
    };
    try {
      agentContext.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectPath, encoding: "utf-8", timeout: 5000 }).trim();
    } catch { /* ok */ }

    // Track depth and parent info for sub-agent spawning
    const parentRunId = context._parentRunId || null;
    const agentDepth = context._agentDepth || 0;

    // Create tools — pass depth and runId into context for Agent.spawn
    const toolContext = { ...agentContext, _agentDepth: agentDepth };
    const tools = createAgentTools(toolContext);

    // Get trust mode
    const trustInfo = this.trust[agentId] || {};
    const trustMode = trustInfo.mode || def.approvalMode || settings.agentSettings?.defaultApprovalMode || "ask-first";

    // Create runtime
    const runtime = new AgentRuntime(def, apiKey, tools, trustMode, (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("agent-event", { ...event, timestamp: Date.now(), parentRunId, depth: agentDepth });
      }
    }, { parentRunId, depth: agentDepth });

    // Set runId into tool context so Agent.spawn can track parent
    toolContext._currentRunId = runtime.runId;
    toolContext._currentAgentId = agentId;

    // Add to runs map first, then register parent-child
    // (ensures child is findable when parent.stop() cascades)
    this.runs.set(runtime.runId, runtime);
    if (parentRunId) {
      const parentRuntime = this.runs.get(parentRunId);
      if (parentRuntime) parentRuntime.childRunIds.push(runtime.runId);
    }

    // Update trust run count
    if (!this.trust[agentId]) this.trust[agentId] = { mode: trustMode, runCount: 0, rejectionCount: 0, emergencyStopCount: 0 };
    this.trust[agentId].runCount++;
    this.trust[agentId].lastRun = new Date().toISOString();
    saveAgentTrust(this.trust);

    // Run async (don't await — it runs in the background)
    const task = context.task || "Please help with this task.";
    runtime.run(task, agentContext).catch(err => {
      console.error(`[wotch:agents] Agent '${agentId}' failed:`, err.message);
    }).finally(() => {
      // Clean up after completion
      setTimeout(() => this.runs.delete(runtime.runId), 60000); // Keep for 1 min after done
    });

    return { runId: runtime.runId };
  }

  async stopAgent(runId) {
    const runtime = this.runs.get(runId);
    if (!runtime) return { success: false };
    runtime.stop();
    return { success: true };
  }

  async emergencyStopAll() {
    for (const [, runtime] of this.runs) {
      runtime.stop();
    }
    // Demote trust for all running agents
    for (const [, runtime] of this.runs) {
      const agentId = runtime.agent.name;
      if (this.trust[agentId]) {
        const current = this.trust[agentId].mode;
        if (current === "auto-execute") this.trust[agentId].mode = "ask-first";
        else if (current === "ask-first") this.trust[agentId].mode = "suggest-only";
        this.trust[agentId].emergencyStopCount = (this.trust[agentId].emergencyStopCount || 0) + 1;
      }
    }
    saveAgentTrust(this.trust);
    return { success: true };
  }

  approveAction(runId, actionId, decision) {
    const runtime = this.runs.get(runId);
    if (!runtime) return { success: false };
    runtime.resolveApproval(actionId, decision);
    return { success: true };
  }

  getRunningAgents() {
    const list = [];
    for (const [runId, runtime] of this.runs) {
      list.push({
        runId, agentId: runtime.agent.name, agentName: runtime.agent.displayName || runtime.agent.name,
        state: runtime.state, iteration: runtime.iteration, maxTurns: runtime.agent.maxTurns || 10,
        parentRunId: runtime.parentRunId, depth: runtime.depth, childRunIds: runtime.childRunIds,
      });
    }
    return list;
  }

  checkTriggers(tabId, terminalCleanData) {
    if (!settings.agentSettings?.autoTriggerEnabled) return;
    for (const [agentId, def] of this.agents) {
      if (!def.triggers) continue;
      for (const trigger of def.triggers) {
        if (trigger.type === "onError" || (trigger.type === "onStatusChange" && trigger.to === "error")) {
          // Check debounce
          const lastTrigger = this.triggerDebounce.get(agentId) || 0;
          const debounceMs = trigger.debounceMs || 5000;
          if (Date.now() - lastTrigger < debounceMs) continue;

          // Check if terminal has error patterns
          const hasError = /error|Error|ERROR|FAIL|fail|Exception|exception|Traceback|panic/.test(terminalCleanData);
          if (hasError) {
            this.triggerDebounce.set(agentId, Date.now());
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("agent-suggestion", {
                agentId, agentName: def.displayName || def.name,
                trigger: trigger.type === "onError" ? "Terminal error detected" : `Status changed to ${trigger.to}`,
                tabId,
              });
            }
          }
        }
      }
    }
  }

  _pruneLogs() {
    try {
      const maxAge = (settings.agentSettings?.logRetentionDays || 30) * 86400000;
      const now = Date.now();
      const agentDirs = fs.readdirSync(AGENT_LOGS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
      for (const dir of agentDirs) {
        const logDir = path.join(AGENT_LOGS_DIR, dir.name);
        const files = fs.readdirSync(logDir);
        for (const file of files) {
          const filePath = path.join(logDir, file);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) fs.unlinkSync(filePath);
        }
      }
    } catch { /* ok */ }
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this._rediscoverTimer) clearTimeout(this._rediscoverTimer);
    for (const [, runtime] of this.runs) runtime.stop();
  }
}

const agentManager = new AgentManager();

// ── IDE Bridge Server ──────────────────────────────────────────────
// Implements the Claude Code IDE bridge protocol: writes a lockfile to
// ~/.claude/ide/[PORT].lock and runs a WebSocket server that speaks
// MCP JSON-RPC 2.0, enabling Claude Code to discover and call Wotch tools.
const WebSocket = require("ws");
const IDE_LOCKFILE_DIR = path.join(os.homedir(), ".claude", "ide");
const BRIDGE_DEFAULT_PORT = 19521;

class BridgeServer {
  constructor() {
    this.wss = null;
    this.port = settings.integrationBridgePort || BRIDGE_DEFAULT_PORT;
    this.enabled = settings.integrationBridgeEnabled !== false;
    this.authToken = crypto.randomBytes(24).toString("base64url");
    this.lockfilePath = null;
    this.clients = new Set();
    this.mcpHandlers = null; // set via start()
    this._requestId = 0;
  }

  async start(mcpHandlers) {
    this.mcpHandlers = mcpHandlers;
    if (!this.enabled) {
      console.log("[wotch:bridge] Bridge disabled in settings");
      return;
    }

    // Try port range: BRIDGE_DEFAULT_PORT to +9
    let bound = false;
    for (let p = this.port; p < this.port + 10; p++) {
      try {
        await this._listen(p);
        this.port = p;
        bound = true;
        break;
      } catch (err) {
        if (err.code === "EADDRINUSE") continue;
        throw err;
      }
    }
    if (!bound) {
      console.error("[wotch:bridge] Could not find available port in range");
      return;
    }

    this._writeLockfile();
    console.log(`[wotch:bridge] Started on ws://127.0.0.1:${this.port} (lockfile: ${this.lockfilePath})`);
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocket.Server({
        host: "127.0.0.1", // INV-SEC-019: localhost only
        port,
        handleProtocols: (protocols) => {
          if (protocols.has("mcp")) return "mcp";
          return false;
        },
        verifyClient: (info, cb) => {
          // Validate auth token from header
          const token = info.req.headers["x-claude-code-ide-authorization"];
          if (token && token !== this.authToken) {
            cb(false, 403, "Invalid auth token");
            return;
          }
          // Validate Host header (DNS rebinding protection)
          const host = (info.req.headers.host || "").replace(/:\d+$/, "");
          if (!["localhost", "127.0.0.1", "[::1]", ""].includes(host)) {
            cb(false, 403, "Invalid Host header");
            return;
          }
          cb(true);
        },
      });

      wss.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          wss.close();
          reject(err);
        }
      });

      wss.on("listening", () => {
        this.wss = wss;
        this._setupServer();
        resolve();
      });
    });
  }

  _setupServer() {
    this.wss.on("connection", (ws, req) => {
      this.clients.add(ws);
      console.log(`[wotch:bridge] Client connected (${this.clients.size} total)`);

      ws.on("message", async (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          ws.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
          return;
        }

        // JSON-RPC 2.0 notification (no id) — fire and forget
        if (msg.id === undefined || msg.id === null) {
          this._handleNotification(msg);
          return;
        }

        // JSON-RPC 2.0 request
        try {
          const result = await this._handleRequest(msg);
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        } catch (err) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0", id: msg.id,
            error: { code: err.code || -32603, message: err.message },
          }));
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`[wotch:bridge] Client disconnected (${this.clients.size} remaining)`);
      });

      ws.on("error", (err) => {
        console.error("[wotch:bridge] WebSocket error:", err.message);
        this.clients.delete(ws);
      });
    });
  }

  _handleNotification(msg) {
    if (msg.method === "ide_connected") {
      console.log(`[wotch:bridge] Claude Code connected (PID: ${msg.params?.pid || "?"})`);
      // Notify renderer that Claude Code is connected via bridge
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("bridge-connection", { connected: true, pid: msg.params?.pid });
      }
    }
  }

  async _handleRequest(msg) {
    switch (msg.method) {
      case "initialize":
        return {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          serverInfo: { name: "wotch", version: app.getVersion() },
          capabilities: { tools: {} },
        };

      case "tools/list":
        return { tools: this._getToolDefinitions() };

      case "tools/call":
        return this._executeTool(msg.params?.name, msg.params?.arguments || {});

      case "resources/list":
        return { resources: [] };

      case "resources/read":
        throw { code: -32601, message: "No resources available" };

      case "prompts/list":
        return { prompts: [] };

      case "prompts/get":
        throw { code: -32601, message: "No prompts available" };

      default:
        throw { code: -32601, message: `Method not found: ${msg.method}` };
    }
  }

  _getToolDefinitions() {
    return [
      {
        name: "wotch_checkpoint",
        description: "Create a Wotch git checkpoint (safe, additive-only commit)",
        inputSchema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Checkpoint message" },
          },
        },
      },
      {
        name: "wotch_git_status",
        description: "Get git repository status (branch, changed files count, checkpoint count)",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "wotch_git_diff",
        description: "Get unified diff of current changes since last checkpoint",
        inputSchema: {
          type: "object",
          properties: {
            contextLines: { type: "number", description: "Context lines in diff (default 3)" },
          },
        },
      },
      {
        name: "wotch_project_info",
        description: "Get active project path and name",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "wotch_terminal_buffer",
        description: "Read recent terminal output (ANSI-stripped)",
        inputSchema: {
          type: "object",
          properties: {
            lines: { type: "number", description: "Number of lines to read (default 50, max 500)" },
            tabId: { type: "string", description: "Tab ID (default: active tab)" },
          },
        },
      },
      {
        name: "wotch_notify",
        description: "Show a desktop notification to the user",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Notification title" },
            body: { type: "string", description: "Notification body" },
          },
          required: ["body"],
        },
      },
      {
        name: "wotch_list_tabs",
        description: "List all open terminal tabs with IDs and Claude Code status",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "wotch_tab_status",
        description: "Get Claude Code status for a specific terminal tab",
        inputSchema: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "Tab ID" },
          },
          required: ["tabId"],
        },
      },
    ];
  }

  async _executeTool(name, args) {
    if (!this.mcpHandlers) throw { code: -32603, message: "Bridge not initialized" };

    switch (name) {
      case "wotch_checkpoint":
        return { content: [{ type: "text", text: JSON.stringify(await this.mcpHandlers.gitCheckpoint(args)) }] };
      case "wotch_git_status": {
        const status = await this.mcpHandlers.gitGetStatus();
        return { content: [{ type: "text", text: JSON.stringify(status) }] };
      }
      case "wotch_git_diff": {
        const diff = await this.mcpHandlers.gitGetDiff(args);
        return { content: [{ type: "text", text: typeof diff === "string" ? diff : JSON.stringify(diff) }] };
      }
      case "wotch_project_info": {
        const info = await this.mcpHandlers.getProjectInfo();
        return { content: [{ type: "text", text: JSON.stringify(info) }] };
      }
      case "wotch_terminal_buffer": {
        const buffer = await this.mcpHandlers.terminalBuffer(args);
        return { content: [{ type: "text", text: typeof buffer === "string" ? buffer : JSON.stringify(buffer) }] };
      }
      case "wotch_notify":
        await this.mcpHandlers.notify(args);
        return { content: [{ type: "text", text: "Notification sent" }] };
      case "wotch_list_tabs": {
        const tabs = await this.mcpHandlers.listTabs();
        return { content: [{ type: "text", text: JSON.stringify(tabs) }] };
      }
      case "wotch_tab_status": {
        const tabStatus = await this.mcpHandlers.tabStatus(args);
        return { content: [{ type: "text", text: JSON.stringify(tabStatus) }] };
      }
      default:
        throw { code: -32601, message: `Unknown tool: ${name}` };
    }
  }

  _writeLockfile() {
    try {
      fs.mkdirSync(IDE_LOCKFILE_DIR, { recursive: true });
      this.lockfilePath = path.join(IDE_LOCKFILE_DIR, `${this.port}.lock`);
      const lockData = {
        workspaceFolders: [...knownProjectPaths],
        pid: process.pid,
        ideName: "Wotch",
        transport: "ws",
        runningInWindows: IS_WIN,
        authToken: this.authToken,
      };
      fs.writeFileSync(this.lockfilePath, JSON.stringify(lockData, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error("[wotch:bridge] Failed to write lockfile:", err.message);
    }
  }

  updateWorkspaceFolders() {
    // Re-write lockfile when known projects change
    if (this.lockfilePath && this.wss) this._writeLockfile();
  }

  _removeLockfile() {
    if (this.lockfilePath) {
      try { fs.unlinkSync(this.lockfilePath); } catch { /* already gone */ }
      this.lockfilePath = null;
    }
  }

  // Broadcast a notification to all connected Claude Code clients
  broadcast(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: !!this.wss,
      port: this.port,
      clients: this.clients.size,
      lockfilePath: this.lockfilePath,
    };
  }

  async stop() {
    this._removeLockfile();
    for (const ws of this.clients) ws.close(1000, "Shutting down");
    this.clients.clear();
    if (this.wss) {
      return new Promise((resolve) => {
        this.wss.close(() => {
          this.wss = null;
          console.log("[wotch:bridge] Stopped");
          resolve();
        });
      });
    }
  }
}

const bridgeServer = new BridgeServer();

// ── Integration Manager ────────────────────────────────────────────
const integrationManager = ClaudeIntegrationManager
  ? new ClaudeIntegrationManager({
      hooksEnabled: settings.integrationHooksEnabled,
      hooksPort: settings.integrationHooksPort,
      mcpEnabled: settings.integrationMcpEnabled,
      mcpIpcPort: settings.integrationMcpIpcPort,
      autoConfigureHooks: settings.integrationAutoConfigureHooks,
      autoRegisterMCP: settings.integrationAutoRegisterMCP,
    })
  : new (require("events").EventEmitter)(); // stub if module missing
if (!ClaudeIntegrationManager) {
  // Stub methods so callers don't crash
  integrationManager.getAggregateStatus = () => ({ state: "idle", description: "" });
  integrationManager.getStatus = () => ({ state: "idle", description: "" });
  integrationManager.getIntegrationStatus = () => ({ hooks: { active: false }, mcp: { registered: false } });
  integrationManager.statusDetector = { tabs: new Map() };
  integrationManager.feedRegex = () => {};
  integrationManager.addTab = () => {};
  integrationManager.removeTab = () => {};
  integrationManager.configureClaudeHooks = () => 0;
  integrationManager.registerMCPServer = () => false;
  integrationManager.start = async () => {};
  integrationManager.stop = async () => {};
}

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
  if (!ApiServer) { console.warn("[wotch] API server module not available"); return; }
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
  bridgeServer.updateWorkspaceFolders();
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
  "hoverPadding", "hoverEnabled", "collapseDelay", "mousePollingMs", "defaultShell",
  "startExpanded", "pinned", "theme", "autoLaunchClaude", "launchCommand",
  "displayIndex", "position",
  "integrationHooksEnabled", "integrationMcpEnabled",
  "integrationAutoConfigureHooks", "integrationAutoRegisterMCP",
  "integrationBridgeEnabled", "integrationBridgePort",
  "apiEnabled", "apiPort",
  "apiBudgetMonthly", "chatDefaultModel", "lastTabCwds",
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
  const preservedPlugins = settings.plugins;
  settings = { ...DEFAULT_SETTINGS };
  settings.sshProfiles = preservedProfiles;
  settings.plugins = preservedPlugins;
  saveSettings(settings);
  isPinned = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
    mainWindow.webContents.send("pin-state", false);
    mainWindow.webContents.send("position-changed", settings.position || "top");
  }
  return { ...settings };
});

// ── Plugin IPC handlers ──────────────────────────────────────────
ipcMain.handle("plugin-list", () => pluginHost.getPluginList());

ipcMain.handle("plugin-enable", async (_event, { pluginId }) => {
  await pluginHost.activate(pluginId);
  return pluginHost.getPluginList();
});

ipcMain.handle("plugin-disable", async (_event, { pluginId }) => {
  await pluginHost.deactivate(pluginId);
  return pluginHost.getPluginList();
});

ipcMain.handle("plugin-execute-command", async (_event, { commandId }) => {
  await pluginHost.executeCommand(commandId);
});

ipcMain.handle("plugin-get-settings", (_event, { pluginId }) => {
  const plugin = pluginHost.plugins.get(pluginId);
  if (!plugin || !plugin.manifest) return [];
  const declaredSettings = plugin.manifest.contributes?.settings || [];
  const stored = (settings.plugins?.[pluginId]?.settings) || {};
  return declaredSettings.map(s => ({
    ...s,
    value: s.id in stored ? stored[s.id] : s.default,
  }));
});

ipcMain.handle("plugin-save-setting", (_event, { pluginId, settingId, value }) => {
  if (!settings.plugins) settings.plugins = {};
  if (!settings.plugins[pluginId]) settings.plugins[pluginId] = {};
  if (!settings.plugins[pluginId].settings) settings.plugins[pluginId].settings = {};
  settings.plugins[pluginId].settings[settingId] = value;
  saveSettings(settings);
});

ipcMain.handle("plugin-get-permissions", (_event, { pluginId }) => {
  const plugin = pluginHost.plugins.get(pluginId);
  if (!plugin || !plugin.manifest) return { requested: [], granted: {} };
  return {
    requested: plugin.manifest.permissions || [],
    granted: settings.plugins?.[pluginId]?.permissions || {},
  };
});

ipcMain.handle("plugin-grant-permission", (_event, { pluginId, permission }) => {
  if (!settings.plugins) settings.plugins = {};
  if (!settings.plugins[pluginId]) settings.plugins[pluginId] = {};
  if (!settings.plugins[pluginId].permissions) settings.plugins[pluginId].permissions = {};
  settings.plugins[pluginId].permissions[permission] = "granted";
  saveSettings(settings);
  return settings.plugins[pluginId].permissions;
});

ipcMain.handle("plugin-revoke-permission", async (_event, { pluginId, permission }) => {
  if (!settings.plugins) settings.plugins = {};
  if (!settings.plugins[pluginId]) settings.plugins[pluginId] = {};
  if (!settings.plugins[pluginId].permissions) settings.plugins[pluginId].permissions = {};
  settings.plugins[pluginId].permissions[permission] = "denied";
  saveSettings(settings);
  // Deactivate and reactivate to apply new permission set
  const plugin = pluginHost.plugins.get(pluginId);
  if (plugin && plugin.state === "activated") {
    await pluginHost.deactivate(pluginId);
    await pluginHost.activate(pluginId);
  }
  return settings.plugins[pluginId].permissions;
});

// ── Agent IPC handlers ──────────────────────────────────────────
ipcMain.handle("agent-list", () => agentManager.getAgentList());
ipcMain.handle("agent-start", async (_event, { agentId, context }) => agentManager.startAgent(agentId, context));
ipcMain.handle("agent-stop", async (_event, { runId }) => agentManager.stopAgent(runId));
ipcMain.handle("agent-approve", (_event, { runId, actionId, decision }) => agentManager.approveAction(runId, actionId, decision || "approve"));
ipcMain.handle("agent-reject", (_event, { runId, actionId, reason }) => agentManager.approveAction(runId, actionId, "reject"));
ipcMain.handle("agent-runs", () => agentManager.getRunningAgents());
ipcMain.handle("agent-get-trust", (_event, { agentId }) => {
  const trust = agentManager.trust[agentId] || {};
  return { mode: trust.mode || "ask-first", runCount: trust.runCount || 0, rejectionCount: trust.rejectionCount || 0 };
});
ipcMain.handle("agent-set-trust", (_event, { agentId, mode }) => {
  if (!agentManager.trust[agentId]) agentManager.trust[agentId] = { runCount: 0, rejectionCount: 0, emergencyStopCount: 0 };
  agentManager.trust[agentId].mode = mode;
  saveAgentTrust(agentManager.trust);
  return { success: true };
});
ipcMain.handle("agent-tree", () => {
  const runs = agentManager.getRunningAgents();
  // Build tree: root nodes are those with no parent
  const roots = runs.filter(r => !r.parentRunId);
  function buildNode(run) {
    const children = runs.filter(r => r.parentRunId === run.runId);
    return { ...run, children: children.map(buildNode) };
  }
  return roots.map(buildNode);
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

// ── IDE Bridge IPC handlers ──────────────────────────────────────────
ipcMain.handle("bridge-status", () => bridgeServer.getStatus());
ipcMain.handle("bridge-restart", async () => {
  await bridgeServer.stop();
  bridgeServer.port = settings.integrationBridgePort || BRIDGE_DEFAULT_PORT;
  bridgeServer.enabled = settings.integrationBridgeEnabled !== false;
  // mcpHandlers was set during initial start — reuse it
  await bridgeServer.start(bridgeServer.mcpHandlers);
  return bridgeServer.getStatus();
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
  const display = getTargetDisplay();
  const wa = display.workArea;

  if (pos === "left" || pos === "right") {
    const clamped = Math.max(400, Math.min(1200, size));
    settings.expandedWidth = clamped;
  } else {
    // Centered resize: grow symmetrically from vertical center
    const oldHeight = settings.expandedHeight;
    const clamped = Math.max(200, Math.min(900, size));
    settings.expandedHeight = clamped;
  }

  const bounds = getExpandedBounds();

  // For "top" position, center the panel vertically around the current midpoint
  if (pos === "top") {
    const yOffset = getTopOffset();
    const topEdge = display.bounds.y + yOffset;
    const currentBounds = mainWindow.getBounds();
    const currentMid = currentBounds.y + Math.round(currentBounds.height / 2);
    bounds.y = Math.max(topEdge, currentMid - Math.round(bounds.height / 2));
    // Clamp bottom to work area
    if (bounds.y + bounds.height > wa.y + wa.height) {
      bounds.y = wa.y + wa.height - bounds.height;
    }
  }

  mainWindow.setBounds(bounds, false);
  saveSettings(settings);
});

// ── SSH IPC handlers ───────────────────────────────────────────────

ipcMain.handle("ssh-connect", async (_event, { tabId, profileId, password }) => {
  if (!SSHClient) throw new Error("SSH not available — install ssh2 module (npm install ssh2)");
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

  // ── Start Plugin System ──
  pluginHost.init().catch((err) => {
    console.error("[wotch] Plugin system failed to start:", err.message);
  });

  // ── Start Agent System ──
  agentManager.init().catch((err) => {
    console.error("[wotch] Agent system failed to start:", err.message);
  });

  // ── Start IDE Bridge ──
  bridgeServer.start(mcpHandlers).catch((err) => {
    console.error("[wotch] IDE Bridge failed to start:", err.message);
  });

  // If settings say start expanded or pinned, expand immediately
  if (settings.startExpanded || isPinned) {
    setTimeout(() => expand(), 300);
  }

  // Global hotkey: Ctrl/Cmd + ` (backtick)
  globalShortcut.register("CommandOrControl+`", toggle);

  // Agent emergency stop — global shortcut so it works even if window is not focused (INV-AGENT-006)
  globalShortcut.register("CommandOrControl+Shift+K", () => {
    agentManager.emergencyStopAll();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("plugin-notification", { pluginId: "system", message: "Emergency stop: all agents halted", type: "error", duration: 3000 });
    }
  });

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
  // Persist tab working directories for next launch
  const cwds = [...tabCwds.values()].filter(Boolean);
  if (cwds.length > 0) { settings.lastTabCwds = cwds; saveSettings(settings); }

  globalShortcut.unregisterAll();
  clearInterval(idleCheckInterval);
  if (apiServer) apiServer.stop().catch(() => {});
  integrationManager.stop().catch(() => {});
  bridgeServer.stop().catch(() => {});
  pluginHost.deactivateAll().catch(() => {});
  pluginHost.stop();
  agentManager.stop();
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
