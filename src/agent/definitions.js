"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { Cron } = require("croner");

const APPROVAL_MODES = new Set(["suggest-only", "ask-first", "auto-execute"]);
const WATCH_COMPARE_MODES = new Set(["output", "exit", "output-or-exit", "output-and-exit"]);

function triggerIdValid(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(id);
}

function validateTrigger(trigger, index) {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) throw new Error(`Trigger ${index + 1} must be an object`);
  const type = trigger.type;
  const legacy = ["manual", "onError", "onStatusChange", "onCheckpoint"];
  if (legacy.includes(type)) return { ...trigger, id: trigger.id || `legacy-${type}-${index}` };
  if (!triggerIdValid(trigger.id)) throw new Error(`Trigger ${index + 1} requires a stable id`);
  if (typeof trigger.task !== "string" || !trigger.task.trim()) throw new Error(`Trigger '${trigger.id}' requires a task`);

  if (type === "cron") {
    if (typeof trigger.schedule !== "string" || trigger.schedule.trim().split(/\s+/).length !== 5) throw new Error(`Cron trigger '${trigger.id}' requires a five-field schedule`);
    try {
      const probe = new Cron(trigger.schedule, { paused: true, timezone: trigger.timezone });
      probe.stop();
    } catch (error) { throw new Error(`Invalid cron trigger '${trigger.id}': ${error.message}`); }
    if (trigger.timezone && typeof trigger.timezone !== "string") throw new Error(`Cron trigger '${trigger.id}' has an invalid timezone`);
    return { type, id: trigger.id, schedule: trigger.schedule.trim(), ...(trigger.timezone ? { timezone: trigger.timezone } : {}), task: trigger.task.trim() };
  }

  if (type === "fileWatch") {
    const globs = Array.isArray(trigger.globs) ? trigger.globs : [];
    if (!globs.length || globs.some((glob) => typeof glob !== "string" || !glob.trim())) throw new Error(`File watch '${trigger.id}' requires globs`);
    const ignoredGlobs = Array.isArray(trigger.ignoredGlobs) ? trigger.ignoredGlobs : [];
    const debounceMs = trigger.debounceMs == null ? 1000 : Number(trigger.debounceMs);
    if (!Number.isInteger(debounceMs) || debounceMs < 100 || debounceMs > 60000) throw new Error(`File watch '${trigger.id}' debounceMs must be 100-60000`);
    return { type, id: trigger.id, globs, ignoredGlobs, debounceMs, task: trigger.task.trim() };
  }

  if (type === "commandWatch") {
    if (typeof trigger.command !== "string" || !trigger.command.trim() || trigger.command.length > 4096) throw new Error(`Command watch '${trigger.id}' requires a command`);
    const intervalSeconds = Number(trigger.intervalSeconds);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86400) throw new Error(`Command watch '${trigger.id}' intervalSeconds must be 60-86400`);
    const timeoutMs = trigger.timeoutMs == null ? 30000 : Number(trigger.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error(`Command watch '${trigger.id}' timeoutMs must be 1000-120000`);
    const compare = trigger.compare || "output-or-exit";
    if (!WATCH_COMPARE_MODES.has(compare)) throw new Error(`Command watch '${trigger.id}' comparison mode is invalid`);
    return { type, id: trigger.id, command: trigger.command.trim(), intervalSeconds, timeoutMs, compare, task: trigger.task.trim(), dialect: trigger.dialect };
  }
  throw new Error(`Trigger '${trigger.id}' has an unsupported type`);
}

function validateAgentDefinition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Agent definition must be an object");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(raw.name || "")) throw new Error("Missing or invalid 'name'");
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error("Missing 'description'");
  if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt.trim()) throw new Error("Missing 'systemPrompt'");
  if (!Array.isArray(raw.tools) || !raw.tools.length || raw.tools.some((tool) => typeof tool !== "string")) throw new Error("Missing or invalid 'tools'");
  const maxTurns = raw.maxTurns == null ? 10 : Number(raw.maxTurns);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) throw new Error("maxTurns must be 1-50");
  const maxTokenBudget = raw.maxTokenBudget == null ? 40000 : Number(raw.maxTokenBudget);
  if (!Number.isInteger(maxTokenBudget) || maxTokenBudget < 1 || maxTokenBudget > 2000000) throw new Error("maxTokenBudget must be 1-2000000");
  if (raw.approvalMode && !APPROVAL_MODES.has(raw.approvalMode)) throw new Error("Invalid approvalMode");
  const harness = raw.harness || "anthropic";
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(harness)) throw new Error("Invalid harness");
  const triggers = Array.isArray(raw.triggers) ? raw.triggers.map(validateTrigger) : [{ type: "manual", id: "manual" }];
  const ids = new Set();
  for (const trigger of triggers) {
    if (ids.has(trigger.id)) throw new Error(`Duplicate trigger id '${trigger.id}'`);
    ids.add(trigger.id);
  }
  return { ...raw, harness, maxTurns, maxTokenBudget, triggers };
}

function parseDefinition(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const parsed = filePath.endsWith(".json") ? JSON.parse(content) : YAML.parse(content);
  return validateAgentDefinition(parsed);
}

class AgentDefinitionStore {
  constructor({ bundledDir, userDir, logger = console } = {}) {
    this.bundledDir = bundledDir;
    this.userDir = userDir;
    this.logger = logger;
    this.agents = new Map();
  }

  discover(projectPath = "") {
    const next = new Map();
    const layers = [
      [this.bundledDir, "bundled"],
      [this.userDir, "user"],
      [projectPath ? path.join(projectPath, ".wotch", "agents") : null, "project"],
    ];
    for (const [dir, source] of layers) this._scanDirectory(dir, source, next);
    this.agents = next;
    return next;
  }

  _scanDirectory(dir, source, target) {
    if (!dir) return;
    let files;
    try { files = fs.readdirSync(dir).filter((file) => /\.(?:ya?ml|json)$/i.test(file)).sort(); } catch { return; }
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const definition = parseDefinition(filePath);
        target.set(definition.name, { ...definition, _source: source, _filePath: filePath });
      } catch (error) {
        this.logger.warn?.(`[wotch:agents] Invalid definition '${filePath}': ${error.message}`);
      }
    }
  }

  get(agentId) { return this.agents.get(agentId); }
  list() { return [...this.agents.values()]; }
}

function renderSystemPrompt(template, context) {
  const platform = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  return String(template)
    .replace(/\{\{projectName\}\}/g, context.projectName || "unknown")
    .replace(/\{\{projectPath\}\}/g, context.projectPath || "")
    .replace(/\{\{branch\}\}/g, context.branch || "main")
    .replace(/\{\{platform\}\}/g, platform)
    .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
}

module.exports = { AgentDefinitionStore, parseDefinition, renderSystemPrompt, validateAgentDefinition, validateTrigger };
