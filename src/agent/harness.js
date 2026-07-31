"use strict";

class HarnessAdapter {
  get identity() { throw new Error("HarnessAdapter.identity must be implemented"); }
  get capabilities() { return {}; }
  async runTurn() { throw new Error("HarnessAdapter.runTurn must be implemented"); }
  async resetSession() { return undefined; }
  async compactHistory() { throw new Error("HarnessAdapter.compactHistory must be implemented"); }
  async extractMemoryCandidates() { return { candidates: [], usage: { inputTokens: 0, outputTokens: 0 } }; }
  getContextBudget() { return 100000; }
  getUsage(response) { return response?.usage || { inputTokens: 0, outputTokens: 0 }; }
}

class HarnessRegistry {
  constructor() { this.adapters = new Map(); }
  register(adapter) {
    if (!(adapter instanceof HarnessAdapter) && (!adapter || typeof adapter.runTurn !== "function")) throw new Error("Invalid harness adapter");
    const identity = adapter.identity;
    if (!identity?.id || typeof identity.id !== "string") throw new Error("Harness identity requires an id");
    if (this.adapters.has(identity.id)) throw new Error(`Harness '${identity.id}' is already registered`);
    this.adapters.set(identity.id, adapter);
    return this;
  }
  get(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown harness: ${id}`);
    return adapter;
  }
  list() { return [...this.adapters.values()].map((adapter) => ({ ...adapter.identity, capabilities: adapter.capabilities })); }
}

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value || ""), "utf8") / 4);
}

module.exports = { HarnessAdapter, HarnessRegistry, estimateTokens };
