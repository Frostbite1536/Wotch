"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function normalizePlatformPath(value, platform = process.platform) {
  let normalized = path.resolve(String(value || ""));
  if (platform === "win32") normalized = normalized.replace(/\\/g, "/").toLowerCase();
  return normalized.replace(/[\\/]+$/, "") || path.parse(normalized).root;
}

function canonicalPathSync(value, { allowMissing = false, platform = process.platform } = {}) {
  const absolute = path.resolve(String(value || ""));
  if (!allowMissing || fs.existsSync(absolute)) {
    return normalizePlatformPath(fs.realpathSync.native(absolute), platform);
  }

  const missing = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`No existing parent for path: ${absolute}`);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalParent = fs.realpathSync.native(cursor);
  return normalizePlatformPath(path.join(canonicalParent, ...missing), platform);
}

function isContainedPath(root, candidate, { allowMissing = false, platform = process.platform } = {}) {
  const canonicalRoot = canonicalPathSync(root, { platform });
  const canonicalCandidate = canonicalPathSync(candidate, { allowMissing, platform });
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveContainedPath(root, candidate, options = {}) {
  const absolute = path.resolve(root, candidate || ".");
  if (!isContainedPath(root, absolute, options)) throw new Error("Path outside project directory");
  return absolute;
}

function scopeIdForProject(projectPath, options = {}) {
  if (!projectPath) return "no-project";
  const canonical = canonicalPathSync(projectPath, options);
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function atomicWriteFile(filePath, data, options = {}) {
  ensurePrivateDir(path.dirname(filePath));
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, data, { encoding: options.encoding || "utf8", mode: options.mode || 0o600 });
    fs.renameSync(temp, filePath);
  } finally {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function appendJsonLine(filePath, value) {
  ensurePrivateDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readJsonLines(filePath) {
  let body;
  try { body = fs.readFileSync(filePath, "utf8"); } catch { return []; }
  const lines = body.split("\n");
  const values = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line)); } catch { break; }
  }
  return values;
}

function validateFallbackKey(value) {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || "");
  if (key.length !== 32) throw new Error("Checkpoint fallback key must be exactly 32 bytes");
  return key;
}

function loadOrCreateFallbackKey(filePath) {
  if (!filePath) throw new Error("Checkpoint fallback key path is required");
  try {
    const key = validateFallbackKey(Buffer.from(fs.readFileSync(filePath, "utf8").trim(), "base64"));
    try { fs.chmodSync(filePath, 0o600); } catch (error) { if (process.platform !== "win32") throw error; }
    return key;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const key = crypto.randomBytes(32);
  atomicWriteFile(filePath, `${key.toString("base64")}\n`, { mode: 0o600 });
  return key;
}

class CheckpointCipher {
  constructor({ safeStorage = null, fallbackKey = null, fallbackKeyFile = null } = {}) {
    this.safeStorage = safeStorage;
    this.fallbackKey = fallbackKey ? validateFallbackKey(fallbackKey) : fallbackKeyFile ? loadOrCreateFallbackKey(fallbackKeyFile) : null;
  }

  encrypt(value) {
    const plaintext = JSON.stringify(value);
    if (this.safeStorage?.isEncryptionAvailable?.()) {
      return `safe:${this.safeStorage.encryptString(plaintext).toString("base64")}`;
    }
    if (!this.fallbackKey) throw new Error("OS encryption is unavailable and no installation fallback key is configured");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.fallbackKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `aes:${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
  }

  decrypt(encoded) {
    if (encoded.startsWith("safe:")) {
      if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error("OS encryption is unavailable");
      return JSON.parse(this.safeStorage.decryptString(Buffer.from(encoded.slice(5), "base64")));
    }
    if (!encoded.startsWith("aes:")) throw new Error("Unknown checkpoint format");
    if (!this.fallbackKey) throw new Error("Checkpoint fallback key is unavailable");
    const data = Buffer.from(encoded.slice(4), "base64");
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.fallbackKey, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext);
  }
}

module.exports = {
  CheckpointCipher,
  appendJsonLine,
  atomicWriteFile,
  atomicWriteJson,
  canonicalPathSync,
  ensurePrivateDir,
  isContainedPath,
  loadOrCreateFallbackKey,
  normalizePlatformPath,
  readJson,
  readJsonLines,
  resolveContainedPath,
  scopeIdForProject,
};
