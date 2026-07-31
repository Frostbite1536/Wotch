"use strict";

const fs = require("fs");
const path = require("path");
const { appendJsonLine, atomicWriteFile, atomicWriteJson, ensurePrivateDir, readJson, readJsonLines } = require("./storage");

const RUN_STATES = new Set(["queued", "running", "waiting_approval", "completed", "failed", "stopped", "interrupted"]);

class DurableRunStore {
  constructor({ projectsDir, redactor, cipher, now = () => new Date() } = {}) {
    this.projectsDir = projectsDir;
    this.redactor = redactor;
    this.cipher = cipher;
    this.now = now;
  }

  scopeDir(scopeId) { return path.join(this.projectsDir, scopeId); }
  runsDir(scopeId) { return path.join(this.scopeDir(scopeId), "runs"); }
  runDir(scopeId, runId) { return path.join(this.runsDir(scopeId), runId); }

  create(state, checkpoint) {
    if (!RUN_STATES.has(state.status)) throw new Error(`Invalid run status: ${state.status}`);
    const dir = ensurePrivateDir(this.runDir(state.scopeId, state.runId));
    const clean = this._safeState(state);
    atomicWriteJson(path.join(dir, "state.json"), clean);
    if (checkpoint) this.writeCheckpoint(state.scopeId, state.runId, checkpoint);
    this.appendEvent(state.scopeId, state.runId, { type: "queued", data: { status: state.status, agentId: state.agentId } });
    return clean;
  }

  read(scopeId, runId) { return readJson(path.join(this.runDir(scopeId, runId), "state.json")); }

  update(scopeId, runId, patch) {
    const current = this.read(scopeId, runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    const next = { ...current, ...patch, updatedAt: this.now().toISOString() };
    if (!RUN_STATES.has(next.status)) throw new Error(`Invalid run status: ${next.status}`);
    const clean = this._safeState(next);
    atomicWriteJson(path.join(this.runDir(scopeId, runId), "state.json"), clean);
    return clean;
  }

  appendEvent(scopeId, runId, event) {
    const entry = this.redactor.redact({ timestamp: this.now().toISOString(), runId, ...event });
    appendJsonLine(path.join(this.runDir(scopeId, runId), "events.jsonl"), entry);
    return entry;
  }

  events(scopeId, runId) { return readJsonLines(path.join(this.runDir(scopeId, runId), "events.jsonl")); }

  writeCheckpoint(scopeId, runId, checkpoint) {
    const encrypted = this.cipher.encrypt(checkpoint);
    atomicWriteFile(path.join(this.runDir(scopeId, runId), "checkpoint.enc"), encrypted);
  }

  readCheckpoint(scopeId, runId) {
    const encoded = fs.readFileSync(path.join(this.runDir(scopeId, runId), "checkpoint.enc"), "utf8");
    return this.cipher.decrypt(encoded);
  }

  deleteCheckpoint(scopeId, runId) {
    const file = path.join(this.runDir(scopeId, runId), "checkpoint.enc");
    try { fs.unlinkSync(file); } catch { /* already absent */ }
  }

  list({ scopeId, limit = 200 } = {}) {
    const scopes = scopeId ? [scopeId] : this._scopeIds();
    const states = [];
    for (const id of scopes) {
      let runs = [];
      try { runs = fs.readdirSync(this.runsDir(id), { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { continue; }
      for (const entry of runs) {
        const state = this.read(id, entry.name);
        if (state) states.push(state);
      }
    }
    return states.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  findByRunId(runId) { return this.list({ limit: 1000 }).find((state) => state.runId === runId) || null; }

  findActiveDedupe(scopeId, dedupeKey) {
    if (!dedupeKey) return null;
    return this.list({ scopeId, limit: 1000 }).find((state) => state.dedupeKey === dedupeKey && ["queued", "running", "waiting_approval"].includes(state.status)) || null;
  }

  recover() {
    const recovered = [];
    for (const state of this.list({ limit: 1000 })) {
      if (state.status === "running") {
        const next = this.update(state.scopeId, state.runId, { status: "interrupted", outcome: { reason: "application-restart" }, completedAt: this.now().toISOString() });
        this.appendEvent(state.scopeId, state.runId, { type: "interrupted", data: { reason: "application-restart", retryable: true } });
        recovered.push(next);
      } else if (state.status === "waiting_approval" || state.status === "queued") {
        recovered.push(state);
      }
    }
    return recovered;
  }

  _scopeIds() {
    try { return fs.readdirSync(this.projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  }

  _safeState(state) {
    const { task, messages, context, toolOutput, ...metadata } = state;
    return this.redactor.redact(metadata);
  }
}

module.exports = { DurableRunStore, RUN_STATES };
