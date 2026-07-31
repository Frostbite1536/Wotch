"use strict";

const fs = require("fs");
const path = require("path");
const { atomicWriteJson, canonicalPathSync, ensurePrivateDir, readJson, scopeIdForProject } = require("./storage");
const { policyRevision, validatePolicyRule } = require("./policy");

const TRUST_MODES = new Set(["suggest-only", "ask-first", "auto-execute"]);

class ProjectStore {
  constructor({ settingsDir, legacyTrustFile, now = () => new Date() } = {}) {
    this.settingsDir = settingsDir;
    this.projectsDir = path.join(settingsDir, "projects");
    this.globalPolicyFile = path.join(settingsDir, "agent-policy.json");
    this.legacyTrustFile = legacyTrustFile || path.join(settingsDir, "agent-trust.json");
    this.now = now;
    ensurePrivateDir(this.projectsDir);
  }

  scope(projectPath) {
    const scopeId = scopeIdForProject(projectPath || "");
    const dir = ensurePrivateDir(path.join(this.projectsDir, scopeId));
    const canonicalProjectPath = projectPath ? canonicalPathSync(projectPath) : "";
    if (canonicalProjectPath) {
      const metadataFile = path.join(dir, "project.json");
      const metadata = readJson(metadataFile, null);
      if (metadata?.canonicalPath !== canonicalProjectPath) atomicWriteJson(metadataFile, { canonicalPath: canonicalProjectPath });
    }
    return { scopeId, dir, projectPath: canonicalProjectPath };
  }

  listProjectPaths() {
    let scopes = [];
    try { scopes = fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return []; }
    return scopes.map((entry) => readJson(path.join(this.projectsDir, entry.name, "project.json"), null)?.canonicalPath)
      .filter((projectPath) => typeof projectPath === "string" && projectPath && fs.existsSync(projectPath));
  }

  migrateLegacyTrust() {
    const legacy = readJson(this.legacyTrustFile, null);
    if (!legacy || legacy._v2Migration) return false;
    const scope = this.scope("");
    const agents = {};
    for (const [agentId, value] of Object.entries(legacy)) {
      if (agentId.startsWith("_") || !value || typeof value !== "object") continue;
      agents[agentId] = {
        mode: TRUST_MODES.has(value.mode) ? value.mode : "ask-first",
        runCount: Number(value.runCount || 0), rejectionCount: Number(value.rejectionCount || 0),
        emergencyStopCount: Number(value.emergencyStopCount || 0), lastRun: value.lastRun || null,
      };
    }
    atomicWriteJson(path.join(scope.dir, "trust.json"), { version: 1, agents });
    atomicWriteJson(this.legacyTrustFile, { ...legacy, _v2Migration: { migratedAt: this.now().toISOString(), target: "projects/no-project/trust.json" } });
    return true;
  }

  getTrust(projectPath, agentId) {
    const scope = this.scope(projectPath);
    const document = readJson(path.join(scope.dir, "trust.json"), { version: 1, agents: {} });
    const record = document.agents?.[agentId];
    return { mode: record?.mode || "ask-first", configured: Boolean(record), runCount: Number(record?.runCount || 0), rejectionCount: Number(record?.rejectionCount || 0), emergencyStopCount: Number(record?.emergencyStopCount || 0), lastRun: record?.lastRun || null };
  }

  updateTrust(projectPath, agentId, patch) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(agentId || "")) throw new Error("Invalid agent id");
    if (patch.mode && !TRUST_MODES.has(patch.mode)) throw new Error("Invalid trust mode");
    const scope = this.scope(projectPath);
    const file = path.join(scope.dir, "trust.json");
    const document = readJson(file, { version: 1, agents: {} });
    const current = this.getTrust(projectPath, agentId);
    const next = { ...current, ...patch };
    document.agents = { ...(document.agents || {}), [agentId]: next };
    atomicWriteJson(file, document);
    return next;
  }

  incrementRun(projectPath, agentId) {
    const current = this.getTrust(projectPath, agentId);
    return this.updateTrust(projectPath, agentId, { runCount: current.runCount + 1, lastRun: this.now().toISOString() });
  }

  demoteTrust(projectPath, agentId) {
    const current = this.getTrust(projectPath, agentId);
    const mode = current.mode === "auto-execute" ? "ask-first" : current.mode === "ask-first" ? "suggest-only" : "suggest-only";
    return this.updateTrust(projectPath, agentId, { mode, emergencyStopCount: current.emergencyStopCount + 1 });
  }

  getPolicy(projectPath) {
    const scope = this.scope(projectPath);
    const repositoryFile = projectPath ? path.join(projectPath, ".wotch", "agent-policy.json") : null;
    const repositoryDocument = repositoryFile ? readJson(repositoryFile, { rules: [] }) : { rules: [] };
    const globalDocument = readJson(this.globalPolicyFile, { rules: [] });
    const projectFile = path.join(scope.dir, "policy.json");
    const projectDocument = readJson(projectFile, { rules: [], approvedEnv: [] });
    const repositoryRules = this._validateRules(repositoryDocument.rules, { repository: true });
    const userRules = this._validateRules(globalDocument.rules);
    const projectRules = this._validateRules(projectDocument.rules);
    const approvedEnv = Array.isArray(projectDocument.approvedEnv) ? projectDocument.approvedEnv.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) : [];
    const layers = { repositoryRules, userRules, projectRules, approvedEnv };
    return { ...layers, revision: policyRevision(layers), repositoryFile, repositoryReadOnly: true };
  }

  updateProjectPolicy(projectPath, { rules, approvedEnv }) {
    if (!projectPath) throw new Error("Project policy requires a project");
    const validated = this._validateRules(rules || []);
    const env = (approvedEnv || []).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (env.length !== (approvedEnv || []).length) throw new Error("Invalid approved environment variable name");
    const scope = this.scope(projectPath);
    atomicWriteJson(path.join(scope.dir, "policy.json"), { version: 1, rules: validated.map(({ regex, ...rule }) => rule), approvedEnv: [...new Set(env)] });
    return this.getPolicy(projectPath);
  }

  _validateRules(rules, options = {}) {
    if (!Array.isArray(rules)) throw new Error("Policy rules must be an array");
    return rules.map((rule) => validatePolicyRule(rule, options));
  }
}

module.exports = { ProjectStore, TRUST_MODES };
