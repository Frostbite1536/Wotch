"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HarnessAdapter, HarnessRegistry } = require("../src/agent/harness");
const { AgentManager } = require("../src/agent/manager");
const { AutomationService } = require("../src/agent/automation");
const { ProjectStore } = require("../src/agent/project-store");
const { PolicyEvaluator } = require("../src/agent/policy");
const { Redactor } = require("../src/agent/redactor");
const { registerAgentIpc } = require("../src/agent/ipc");

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotch-manager-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
async function until(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Timed out waiting for condition");
}

class QueueHarness extends HarnessAdapter {
  constructor() { super(); this.calls = []; this.releaseFirst = null; }
  get identity() { return { id: "mock", displayName: "Mock" }; }
  async runTurn({ messages }) {
    const task = messages[0].content; this.calls.push(task);
    if (this.calls.length === 1) await new Promise((resolve) => { this.releaseFirst = resolve; });
    return { content: [{ type: "text", text: `done:${task}` }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
  async compactHistory({ messages }) { return { messages, usage: {} }; }
  getContextBudget() { return 200000; }
}

function makeManager(t, { adapter = new QueueHarness(), backend } = {}) {
  const root = temp(t); const settingsDir = path.join(root, "settings"); const bundled = path.join(root, "agents"); const project = path.join(root, "project");
  fs.mkdirSync(bundled); fs.mkdirSync(project);
  fs.writeFileSync(path.join(bundled, "agent.yaml"), `name: agent\ndescription: Test agent\nsystemPrompt: Help.\ntools:\n  - Shell.execute\nharness: mock\nmaxTurns: 5\nmaxTokenBudget: 1000\n`);
  const runtimeBackend = backend || { execute: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }) };
  const registry = new HarnessRegistry().register(adapter);
  const settings = { agentSettings: { enabled: true, maxConcurrentAgents: 1, defaultApprovalMode: "ask-first", approvalTimeoutMs: 1000, autoTriggerEnabled: true } };
  const manager = new AgentManager({ settingsDir, bundledAgentsDir: bundled, backend: runtimeBackend, registry, getSettings: () => settings, updateAgentSettings: (patch) => Object.assign(settings.agentSettings, patch), getCredential: () => null });
  t.after(() => manager.stop());
  return { manager, adapter, project, root, settings, backend: runtimeBackend };
}

test("durable manager queues FIFO, deduplicates automation, and never deduplicates manual starts", async (t) => {
  const { manager, adapter, project } = makeManager(t);
  await manager.init();
  const first = await manager.startAgent("agent", { task: "first", projectPath: project });
  await until(() => adapter.calls.length === 1);
  const second = await manager.startAgent("agent", { task: "second", projectPath: project });
  const auto1 = await manager.startAgent("agent", { task: "auto", projectPath: project, _dedupeKey: "trigger:x" });
  const auto2 = await manager.startAgent("agent", { task: "auto-again", projectPath: project, _dedupeKey: "trigger:x" });
  const manualAgain = await manager.startAgent("agent", { task: "second", projectPath: project });
  assert.equal(auto2.runId, auto1.runId);
  assert.notEqual(second.runId, manualAgain.runId);
  assert.equal(manager.runStore.findByRunId(second.runId).status, "queued");
  adapter.releaseFirst();
  await until(() => manager.listRuns(project).filter((run) => run.status === "completed").length === 4);
  assert.deepEqual(adapter.calls, ["first", "second", "auto", "second"]);
  assert.equal(manager.runStore.findByRunId(first.runId).status, "completed");
});

test("parent cancellation cascades to queued children and emergency stop demotes project trust", async (t) => {
  const { manager, adapter, project } = makeManager(t);
  await manager.init();
  manager.setTrust(project, "agent", "auto-execute");
  const parent = await manager.startAgent("agent", { task: "parent", projectPath: project });
  await until(() => adapter.calls.length === 1);
  const child = await manager.startAgent("agent", { task: "child", projectPath: project, _parentRunId: parent.runId, _agentDepth: 1 });
  await manager.emergencyStopAll();
  adapter.releaseFirst();
  await until(() => manager.runStore.findByRunId(parent.runId).status === "stopped");
  assert.equal(manager.runStore.findByRunId(child.runId).status, "stopped");
  assert.equal(manager.getTrust(project, "agent").mode, "ask-first");
});

test("recovered approvals are re-evaluated against current policy", async (t) => {
  let executions = 0;
  const adapter = new QueueHarness(); adapter.runTurn = async () => ({ content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" });
  const { manager, project } = makeManager(t, { adapter, backend: { execute: async () => { executions++; return { exitCode: 0, stdout: "ok" }; } } });
  manager._discover(project);
  const scope = manager.projectStore.scope(project);
  const state = { runId: "recovered", scopeId: scope.scopeId, projectPath: project, agentId: "agent", agentName: "Test agent", harness: "mock", model: "mock", status: "waiting_approval", parentRunId: null, depth: 0, childRunIds: [], createdAt: new Date().toISOString(), iteration: 1, modelCalls: 1, tokenTotal: 2, pendingApproval: { actionId: "action", tool: "Shell.execute", commandPreview: "echo hello" }, outcome: null };
  const toolUse = { type: "tool_use", id: "tool", name: "Shell.execute", input: { command: "echo hello", dialect: "posix" } };
  const checkpoint = { task: "task", context: { projectPath: project }, systemPrompt: "system", messages: [{ role: "user", content: "task" }, { role: "assistant", content: [toolUse] }], iteration: 1, modelCalls: 1, tokenTotal: 2, toolSummaries: [], pendingAction: { actionId: "action", toolUse }, pendingBatch: { toolUses: [toolUse], index: 0, toolResults: [] } };
  manager.runStore.create(state, checkpoint);
  fs.mkdirSync(path.join(project, ".wotch"), { recursive: true });
  fs.writeFileSync(path.join(project, ".wotch", "agent-policy.json"), JSON.stringify({ rules: [{ id: "deny-echo", dialect: "posix", pattern: "^echo", decision: "deny", reason: "policy changed" }] }));
  await manager.init();
  const result = manager.approveAction("recovered", "action", "approve"); assert.equal(result.success, true);
  await until(() => manager.runStore.findByRunId("recovered").status === "completed");
  assert.equal(executions, 0);
  assert.ok(manager.getRunEvents("recovered").some((event) => event.type === "policy-denied"));
});

test("command watches require standing approval, establish a baseline, and trigger only on change", async (t) => {
  const root = temp(t); const settings = path.join(root, "settings"); const project = path.join(root, "project"); fs.mkdirSync(project);
  const projectStore = new ProjectStore({ settingsDir: settings }); const redactor = new Redactor();
  let call = 0; const backend = { execute: async () => ({ stdout: call++ === 0 ? "same" : "changed", exitCode: 0 }) };
  const starts = [];
  const definition = { name: "watcher", displayName: "Watcher", triggers: [{ type: "commandWatch", id: "status", command: "git status --porcelain", intervalSeconds: 60, timeoutMs: 5000, compare: "output", task: "Inspect change", dialect: "posix" }] };
  const manager = { definitionStore: { list: () => [definition], get: () => definition }, _discover: () => {}, attachAutomation(service) { this.automation = service; }, startAgent: async (_agent, context) => { starts.push(context); return { runId: "run" }; } };
  const automation = new AutomationService({ manager, projectStore, backend, policyEvaluator: new PolicyEvaluator({ redactor }), redactor, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  t.after(() => automation.stop());
  const proposed = await automation.enable(project, "watcher", "status");
  assert.equal(proposed.requiresApproval, true); assert.equal(starts.length, 0);
  await assert.rejects(() => automation.enable(project, "watcher", "status", { standingApproval: true }), /approval is missing/);
  await automation.enable(project, "watcher", "status", { standingApproval: true, approvalToken: proposed.approvalToken });
  assert.equal(starts.length, 0);
  await automation._pollCommand(project, "watcher", definition.triggers[0]);
  assert.equal(starts.length, 1);
  assert.match(starts[0].task, /COMMAND WATCH CHANGE/);
  assert.ok(starts[0].task.length < 17000);
  projectStore.updateProjectPolicy(project, { rules: [{ id: "approval", dialect: "posix", pattern: "git status", decision: "require_approval", reason: "changed" }], approvedEnv: [] });
  assert.equal(automation.list(project)[0].enabled, false);
});

test("command watch disables after three consecutive failures", (t) => {
  const root = temp(t); const project = path.join(root, "project"); fs.mkdirSync(project);
  const projectStore = new ProjectStore({ settingsDir: path.join(root, "settings") }); const redactor = new Redactor(); const notifications = [];
  const trigger = { type: "commandWatch", id: "x", command: "echo x", intervalSeconds: 60, timeoutMs: 1000, compare: "output", task: "x" };
  const definition = { name: "agent", triggers: [trigger] };
  const manager = { definitionStore: { list: () => [definition], get: () => definition }, _discover: () => {}, attachAutomation() {}, startAgent: async () => ({ runId: "x" }) };
  const automation = new AutomationService({ manager, projectStore, backend: {}, policyEvaluator: new PolicyEvaluator({ redactor }), redactor, notify: (value) => notifications.push(value) });
  const file = automation._file(project); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 1, triggers: { "agent:x": { enabled: true } } }));
  automation._recordError(project, "agent", trigger, new Error("one")); automation._recordError(project, "agent", trigger, new Error("two")); automation._recordError(project, "agent", trigger, new Error("three"));
  assert.equal(automation._load(project).triggers["agent:x"].enabled, false);
  assert.equal(notifications.length, 1);
});

test("cron and file watch enablement is invalidated by definition drift", async (t) => {
  const root = temp(t); const project = path.join(root, "project"); fs.mkdirSync(project);
  const projectStore = new ProjectStore({ settingsDir: path.join(root, "settings") }); const redactor = new Redactor();
  const definitions = [
    { name: "cron-agent", displayName: "Cron", triggers: [{ type: "cron", id: "daily", schedule: "0 9 * * *", task: "Original cron task" }] },
    { name: "file-agent", displayName: "File", triggers: [{ type: "fileWatch", id: "source", globs: ["src/**/*.js"], ignoredGlobs: [], debounceMs: 100, task: "Original file task" }] },
  ];
  const manager = { definitionStore: { list: () => definitions, get: (name) => definitions.find((item) => item.name === name) }, _discover: () => {}, attachAutomation(service) { this.automation = service; }, startAgent: async () => ({ runId: "run" }) };
  const first = new AutomationService({ manager, projectStore, backend: {}, policyEvaluator: new PolicyEvaluator({ redactor }), redactor });
  await first.enable(project, "cron-agent", "daily");
  await first.enable(project, "file-agent", "source");
  await first.stop();

  definitions[0].triggers[0] = { ...definitions[0].triggers[0], schedule: "0 10 * * *", task: "Changed cron task" };
  definitions[1].triggers[0] = { ...definitions[1].triggers[0], globs: ["**/*"], task: "Changed file task" };
  const restored = new AutomationService({ manager, projectStore, backend: {}, policyEvaluator: new PolicyEvaluator({ redactor }), redactor });
  t.after(() => restored.stop());
  await restored.restore(project);

  const records = restored.list(project);
  assert.equal(records.find((item) => item.agentId === "cron-agent").enabled, false);
  assert.equal(records.find((item) => item.agentId === "file-agent").enabled, false);
  assert.match(records.find((item) => item.agentId === "cron-agent").error, /explicit re-enable/);
  assert.match(records.find((item) => item.agentId === "file-agent").error, /explicit re-enable/);
});

test("cron has no catch-up fire and file watches debounce bursts while ignoring defaults", async (t) => {
  const root = temp(t); const project = path.join(root, "project"); fs.mkdirSync(path.join(project, "src", "nested"), { recursive: true }); fs.mkdirSync(path.join(project, "node_modules", "pkg"), { recursive: true });
  const projectStore = new ProjectStore({ settingsDir: path.join(root, "settings") }); const redactor = new Redactor(); const starts = [];
  const definitions = [
    { name: "cron-agent", displayName: "Cron", triggers: [{ type: "cron", id: "minute", schedule: "* * * * *", timezone: "America/Chicago", task: "cron task" }] },
    { name: "file-agent", displayName: "File", triggers: [{ type: "fileWatch", id: "source", globs: ["src/**/*.js"], ignoredGlobs: [], debounceMs: 100, task: "file task" }] },
  ];
  let current;
  const manager = { definitionStore: { list: () => definitions, get: (name) => definitions.find((item) => item.name === name) }, _discover: () => {}, attachAutomation(service) { this.automation = service; }, startAgent: async (agentId, context) => { starts.push({ agentId, context }); return { runId: String(starts.length) }; } };
  const automation = new AutomationService({ manager, projectStore, backend: {}, policyEvaluator: new PolicyEvaluator({ redactor }), redactor });
  t.after(() => automation.stop());
  await automation.enable(project, "cron-agent", "minute");
  assert.equal(starts.length, 0);
  assert.ok(automation.list(project).find((item) => item.agentId === "cron-agent").nextRun);
  await automation.enable(project, "file-agent", "source");
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.writeFileSync(path.join(project, "src", "nested", "a.js"), "one");
  fs.writeFileSync(path.join(project, "src", "nested", "a.js"), "two");
  fs.writeFileSync(path.join(project, "node_modules", "pkg", "ignored.js"), "ignored");
  await until(() => starts.length === 1, 3000);
  assert.equal(starts[0].agentId, "file-agent");
  assert.match(starts[0].context.task, /src\/nested\/a\.js/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(starts.length, 1);
});

test("agent IPC validates payloads and exposes every v2 group", async () => {
  const handlers = new Map(); const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const manager = new Proxy({}, { get: (_target, property) => property === "getAgentSettings" ? () => ({}) : property === "getAgentList" ? () => [] : () => ({ ok: true }) });
  const automation = { list: () => [], enable: () => ({}), disable: () => ({}), runNow: () => ({}) };
  registerAgentIpc({ ipcMain, manager, automation });
  for (const name of ["agent-v2-runs-list", "agent-v2-runs-events", "agent-v2-runs-start", "agent-v2-runs-resume", "agent-v2-trust-get", "agent-v2-policy-update", "agent-v2-memory-history", "agent-v2-automation-enable", "agent-list"]) assert.equal(handlers.has(name), true, name);
  assert.throws(() => handlers.get("agent-v2-runs-events")(null, { runId: "" }), /runId/);
  assert.throws(() => handlers.get("agent-v2-memory-restore")(null, { projectPath: "x", version: "1", expectedVersion: 1 }), /integers/);
});
