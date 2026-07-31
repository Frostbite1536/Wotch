"use strict";

const crypto = require("crypto");
const path = require("path");

const SECRET_KEY = /(api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|credential|password|passwd|private[-_]?key|secret|session[-_]?token)/i;
const SECRET_ASSIGNMENT = /((?:--?|\/)(?:api[-_]?key|token|password|secret|authorization)|\b(?:api[-_]?key|access[-_]?token|password|secret|authorization))([=:\s]+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi;
const AUTH_HEADER = /(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi;
const URL_CREDENTIAL = /(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi;
const COMMON_SECRET = /\b(?:sk-ant-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g;

function byteSummary(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return {
    byteCount: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

class Redactor {
  constructor({ secrets = [], maxString = 4096 } = {}) {
    this.maxString = maxString;
    this.secrets = new Set();
    for (const secret of secrets) this.addSecret(secret);
  }

  addSecret(secret) {
    if (typeof secret === "string" && secret.length >= 4) this.secrets.add(secret);
  }

  variants(secret) {
    const values = new Set([secret]);
    try { values.add(encodeURIComponent(secret)); } catch { /* noop */ }
    values.add(Buffer.from(secret, "utf8").toString("base64"));
    values.add(Buffer.from(secret, "utf8").toString("base64url"));
    return values;
  }

  redactString(input, { maxString = this.maxString } = {}) {
    let value = String(input);
    for (const secret of this.secrets) {
      for (const variant of this.variants(secret)) value = value.split(variant).join("[REDACTED]");
    }
    value = value
      .replace(COMMON_SECRET, "[REDACTED]")
      .replace(SECRET_ASSIGNMENT, (_match, key, separator) => `${key}${separator}[REDACTED]`)
      .replace(AUTH_HEADER, "$1[REDACTED]")
      .replace(URL_CREDENTIAL, "$1[REDACTED]@");
    if (value.length > maxString) {
      const bytes = Buffer.byteLength(value);
      const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
      value = `${value.slice(0, maxString)}…[TRUNCATED ${bytes} bytes sha256:${hash}]`;
    }
    return value;
  }

  redact(value, key = "") {
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return SECRET_KEY.test(key) ? "[REDACTED]" : this.redactString(value);
    if (Buffer.isBuffer(value)) return `[BINARY ${value.length} bytes]`;
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (typeof value === "object") {
      const output = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        output[childKey] = SECRET_KEY.test(childKey) ? "[REDACTED]" : this.redact(childValue, childKey);
      }
      return output;
    }
    return this.redactString(value);
  }

  containsSecret(value) {
    const text = String(value || "");
    COMMON_SECRET.lastIndex = SECRET_ASSIGNMENT.lastIndex = AUTH_HEADER.lastIndex = 0;
    const shaped = COMMON_SECRET.test(text) || SECRET_ASSIGNMENT.test(text) || AUTH_HEADER.test(text);
    COMMON_SECRET.lastIndex = SECRET_ASSIGNMENT.lastIndex = AUTH_HEADER.lastIndex = 0;
    if (shaped) return true;
    for (const secret of this.secrets) {
      for (const variant of this.variants(secret)) if (text.includes(variant)) return true;
    }
    return false;
  }
}

function relativeAuditPath(projectPath, candidate) {
  if (!candidate) return undefined;
  if (!projectPath) return path.basename(candidate);
  const absolute = path.resolve(projectPath, candidate);
  const relative = path.relative(projectPath, absolute);
  return relative && !relative.startsWith("..") ? relative : path.basename(absolute);
}

function summarizeToolBoundary({ tool, input = {}, result, durationMs = 0, projectPath = "", redactor = new Redactor() }) {
  const summary = { tool, durationMs: Math.max(0, Math.round(durationMs)) };
  const candidatePath = input.path || input.filePath || input.cwd;
  if (candidatePath) summary.path = relativeAuditPath(projectPath, candidatePath);

  if (tool === "Shell.execute") {
    summary.commandPreview = redactor.redactString(input.command || "", { maxString: 500 });
    summary.exitStatus = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    summary.timedOut = Boolean(result?.timedOut);
    Object.assign(summary, byteSummary(`${result?.stdout || ""}${result?.stderr || ""}`));
  } else if (tool === "FileSystem.writeFile" || tool === "Memory.capture") {
    Object.assign(summary, byteSummary(input.content ?? input.fact ?? ""));
    summary.success = result?.success !== false;
  } else if (tool === "FileSystem.readFile") {
    Object.assign(summary, byteSummary(result?.content || ""));
  } else if (tool === "FileSystem.deleteFile") {
    summary.success = result?.success !== false;
  } else {
    Object.assign(summary, byteSummary(result));
    if (Number.isInteger(result?.exitCode)) summary.exitStatus = result.exitCode;
  }
  return redactor.redact(summary);
}

module.exports = { Redactor, byteSummary, summarizeToolBoundary };
