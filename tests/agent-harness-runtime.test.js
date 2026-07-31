"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AnthropicHarnessAdapter } = require("../src/agent/anthropic-harness");
const { HarnessAdapter, HarnessRegistry } = require("../src/agent/harness");
const { AgentRuntime } = require("../src/agent/runtime");
const { PolicyEvaluator } = require("../src/agent/policy");
const { Redactor } = require("../src/agent/redactor");
const { DurableRunStore } = require("../src/agent/run-store");
const { CheckpointCipher } = require("../src/agent/storage");

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotch-runtime-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

class MockHarness extends HarnessAdapter {
  constructor(responses, { contextBudget = 200000 } = {}) { super(); this.responses = [...responses]; this.contextBudget = contextBudget; this.calls = []; }
  get identity() { return { id: "mock", displayName: "Mock" }; }
  async runTurn(request) { this.calls.push({ type: "turn", request }); return this.responses.shift(); }
  async compactHistory({ messages }) { this.calls.push({ type: "compact" }); return { messages: messages.slice(-2), usage: { inputTokens: 2, outputTokens: 2 } }; }
  async extractMemoryCandidates() { this.calls.push({ type: "memory" }); return { candidates: [], usage: { inputTokens: 1, outputTokens: 1 } }; }
  getContextBudget() { return this.contextBudget; }
}

test("harness registry is provider-neutral", () => {
  const registry = new HarnessRegistry();
  const mock = new MockHarness([]);
  registry.register(mock);
  assert.equal(registry.get("mock"), mock);
  assert.deepEqual(registry.list()[0].id, "mock");
  assert.throws(() => registry.get("missing"), /Unknown harness/);
});

test("Anthropic adapter forwards cancellation, normalizes usage, compacts, and tolerates malformed extraction", async () => {
  const calls = [];
  const client = { messages: { create: async (body, options) => {
    calls.push({ body, options });
    if (body.system?.startsWith("Extract durable")) return { content: [{ type: "text", text: "not-json" }], usage: { input_tokens: 2, output_tokens: 1 } };
    return { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: "end_turn", model: body.model };
  } } };
  const adapter = new AnthropicHarnessAdapter({ apiKeyProvider: () => "key", clientFactory: () => client });
  const controller = new AbortController();
  const turn = await adapter.runTurn({ model: "model", system: "system", messages: [], tools: [], signal: controller.signal });
  assert.deepEqual(turn.usage, { inputTokens: 3, outputTokens: 4 });
  assert.equal(calls[0].options.signal, controller.signal);
  const compacted = await adapter.compactHistory({ model: "model", system: "system", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] });
  assert.ok(compacted.messages.length >= 1);
  const extraction = await adapter.extractMemoryCandidates({ model: "model", task: "x", finalResponse: "y", toolSummaries: [] });
  assert.deepEqual(extraction.candidates, []);
});

function runtimeFixture(t, adapter, { trustMode = "auto-execute", maxTurns = 5, maxTokenBudget = 1000, memoryEnabled = false } = {}) {
  const root = temp(t); const project = path.join(root, "project"); fs.mkdirSync(project);
  const redactor = new Redactor({ secrets: ["runtime-secret"] });
  const runStore = new DurableRunStore({ projectsDir: path.join(root, "projects"), redactor, cipher: new CheckpointCipher({ fallbackKey: Buffer.alloc(32, 4) }) });
  const state = { runId: "run", scopeId: "scope", projectPath: project, agentId: "agent", agentName: "Agent", harness: "mock", model: "mock", status: "queued", parentRunId: null, depth: 0, childRunIds: [], createdAt: new Date().toISOString(), iteration: 0, modelCalls: 0, tokenTotal: 0, pendingApproval: null, outcome: null };
  const checkpoint = { task: "task", context: { projectPath: project }, systemPrompt: "system", messages: [{ role: "user", content: "task" }], iteration: 0, modelCalls: 0, tokenTotal: 0, toolSummaries: [] };
  runStore.create(state, checkpoint);
  const events = [];
  const memoryStore = {
    status: () => ({ enabled: memoryEnabled }),
    capture: () => ({ added: [], snapshot: {} }),
  };
  const runtime = new AgentRuntime({
    definition: { name: "agent", model: "mock", maxTurns, maxTokenBudget }, state, checkpoint, adapter,
    tools: { "FileSystem.writeFile": async () => ({ success: true }) },
    toolDefs: [], policyEvaluator: new PolicyEvaluator({ redactor }),
    getPolicy: () => ({ repositoryRules: [], userRules: [], projectRules: [] }), getTrustMode: () => trustMode,
    redactor, runStore, memoryStore, emit: (event) => events.push(event), approvalTimeoutMs: 1000,
  });
  return { runtime, runStore, events, project };
}

test("runtime persists boundaries, waits for approval, and never audits raw content", async (t) => {
  const adapter = new MockHarness([
    { content: [{ type: "tool_use", id: "tool-1", name: "FileSystem.writeFile", input: { path: "x.txt", content: "runtime-secret raw body" } }], usage: { inputTokens: 5, outputTokens: 2 } },
    { content: [{ type: "text", text: "done" }], usage: { inputTokens: 4, outputTokens: 1 }, stopReason: "end_turn" },
  ]);
  const fixture = runtimeFixture(t, adapter, { trustMode: "ask-first" });
  const promise = fixture.runtime.run();
  for (let index = 0; index < 50 && fixture.runStore.read("scope", "run").status !== "waiting_approval"; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  const waiting = fixture.runStore.read("scope", "run");
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(JSON.stringify(waiting).includes("raw body"), false);
  assert.equal(fixture.runtime.resolveApproval(waiting.pendingApproval.actionId, "approve"), true);
  assert.equal(await promise, "done");
  assert.equal(fixture.runStore.read("scope", "run").status, "completed");
  const diskEvents = fixture.runStore.events("scope", "run");
  assert.equal(JSON.stringify(diskEvents).includes("raw body"), false);
  assert.equal(JSON.stringify(diskEvents).includes("runtime-secret"), false);
});

test("runtime enforces token budget and AbortSignal cancellation", async (t) => {
  const budgetAdapter = new MockHarness([{ content: [{ type: "text", text: "too much" }], usage: { inputTokens: 20, outputTokens: 20 } }]);
  const budget = runtimeFixture(t, budgetAdapter, { maxTokenBudget: 10 });
  await budget.runtime.run();
  assert.equal(budget.runStore.read("scope", "run").status, "failed");
  assert.equal(budget.runStore.read("scope", "run").outcome.reason, "token-budget");

  const blocking = new MockHarness([]);
  blocking.runTurn = ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true }));
  const cancelled = runtimeFixture(t, blocking);
  const run = cancelled.runtime.run();
  cancelled.runtime.stop();
  await run;
  assert.equal(cancelled.runStore.read("scope", "run").status, "stopped");
});

test("runtime compaction and memory extraction calls count toward maxTurns", async (t) => {
  const adapter = new MockHarness([{ content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" }], { contextBudget: 1 });
  const fixture = runtimeFixture(t, adapter, { maxTurns: 2, memoryEnabled: true });
  await fixture.runtime.run();
  assert.deepEqual(adapter.calls.map((call) => call.type), ["compact", "turn"]);
  assert.equal(adapter.calls.some((call) => call.type === "memory"), false); // extraction would exceed maxTurns
  assert.equal(fixture.runStore.read("scope", "run").status, "completed");
});
