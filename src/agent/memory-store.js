"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWriteJson, ensurePrivateDir, readJson } = require("./storage");

function tokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9_]{2,}/g) || []);
}

function overlapScore(queryTokens, fact) {
  const factTokens = tokens(fact);
  let score = 0;
  for (const token of queryTokens) if (factTokens.has(token)) score++;
  return score;
}

class ProjectMemoryStore {
  constructor({ projectStore, redactor, now = () => new Date(), maxFacts = 300, maxRevisions = 50 } = {}) {
    this.projectStore = projectStore;
    this.redactor = redactor;
    this.now = now;
    this.maxFacts = maxFacts;
    this.maxRevisions = maxRevisions;
  }

  _paths(projectPath) {
    const scope = this.projectStore.scope(projectPath);
    return { scope, snapshot: path.join(scope.dir, "memory.json"), revisions: ensurePrivateDir(path.join(scope.dir, "memory-revisions")) };
  }

  _load(projectPath) {
    const { snapshot } = this._paths(projectPath);
    return readJson(snapshot, { version: 0, enabled: false, updatedAt: null, facts: [] });
  }

  status(projectPath) {
    const snapshot = this._load(projectPath);
    return { enabled: Boolean(snapshot.enabled), version: snapshot.version, factCount: snapshot.facts.length, updatedAt: snapshot.updatedAt };
  }

  enable(projectPath, enabled) {
    if (!projectPath) throw new Error("Project memory requires a project");
    const current = this._load(projectPath);
    return this._commit(projectPath, { ...current, enabled: Boolean(enabled) }, current.version);
  }

  list(projectPath, query = "") {
    const snapshot = this._load(projectPath);
    const queryTokens = tokens(query);
    return snapshot.facts
      .map((fact) => ({ ...fact, _score: queryTokens.size ? overlapScore(queryTokens, fact.fact) : 0 }))
      .filter((fact) => !queryTokens.size || fact._score > 0 || fact.category?.toLowerCase().includes(String(query).toLowerCase()))
      .sort((a, b) => b._score - a._score || String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(({ _score, ...fact }) => fact);
  }

  recall(projectPath, query) {
    if (!this.status(projectPath).enabled) return [];
    let charCount = 0;
    const output = [];
    for (const fact of this.list(projectPath, query)) {
      if (output.length >= 20 || charCount + fact.fact.length > 8000) break;
      output.push(fact); charCount += fact.fact.length;
    }
    return output;
  }

  capture(projectPath, candidates, metadata = {}, { authorized = false } = {}) {
    const current = this._load(projectPath);
    if (!current.enabled && !authorized) throw new Error("Project memory is disabled");
    const existing = new Set(current.facts.map((fact) => fact.fact.trim().toLowerCase()));
    const added = [];
    for (const candidate of candidates || []) {
      const text = String(candidate?.fact || candidate || "").trim();
      if (!text || text.length > 500 || this.redactor.containsSecret(text) || text.includes("[REDACTED]")) continue;
      const normalized = text.toLowerCase();
      if (existing.has(normalized)) continue;
      existing.add(normalized);
      added.push({
        id: crypto.randomUUID(), fact: this.redactor.redactString(text, { maxString: 500 }),
        category: String(candidate?.category || metadata.category || "general").slice(0, 80),
        projectId: this.projectStore.scope(projectPath).scopeId, agentId: metadata.agentId || null,
        runId: metadata.runId || null, createdAt: this.now().toISOString(),
      });
    }
    const facts = [...current.facts, ...added].slice(-this.maxFacts);
    const snapshot = this._commit(projectPath, { ...current, facts }, current.version);
    return { added, snapshot };
  }

  delete(projectPath, factId) {
    const current = this._load(projectPath);
    const facts = current.facts.filter((fact) => fact.id !== factId);
    if (facts.length === current.facts.length) throw new Error("Memory fact not found");
    return this._commit(projectPath, { ...current, facts }, current.version);
  }

  history(projectPath) {
    const { revisions } = this._paths(projectPath);
    let files = [];
    try { files = fs.readdirSync(revisions).filter((file) => file.endsWith(".json")); } catch { return []; }
    return files.sort().reverse().map((file) => {
      const revision = readJson(path.join(revisions, file), null);
      return revision && { version: revision.version, updatedAt: revision.updatedAt, factCount: revision.facts.length };
    }).filter(Boolean);
  }

  restore(projectPath, version, expectedCurrentVersion) {
    const current = this._load(projectPath);
    if (current.version !== expectedCurrentVersion) throw new Error("Memory changed since revision history was loaded");
    const { revisions } = this._paths(projectPath);
    const revision = readJson(path.join(revisions, `${String(version).padStart(8, "0")}.json`), null);
    if (!revision) throw new Error("Memory revision not found");
    return this._commit(projectPath, { ...revision, version: current.version, enabled: current.enabled }, current.version);
  }

  _commit(projectPath, next, expectedVersion) {
    const { snapshot, revisions } = this._paths(projectPath);
    const current = this._load(projectPath);
    if (current.version !== expectedVersion) throw new Error("Concurrent memory update detected");
    const version = current.version + 1;
    const document = { ...next, version, updatedAt: this.now().toISOString() };
    atomicWriteJson(snapshot, document);
    atomicWriteJson(path.join(revisions, `${String(version).padStart(8, "0")}.json`), document);
    const files = fs.readdirSync(revisions).filter((file) => file.endsWith(".json")).sort();
    for (const file of files.slice(0, Math.max(0, files.length - this.maxRevisions))) fs.unlinkSync(path.join(revisions, file));
    return document;
  }
}

module.exports = { ProjectMemoryStore, overlapScore, tokens };
