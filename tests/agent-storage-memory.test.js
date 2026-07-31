"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CheckpointCipher, appendJsonLine, atomicWriteJson, canonicalPathSync, isContainedPath, readJsonLines, resolveContainedPath, scopeIdForProject } = require("../src/agent/storage");
const { ProjectStore } = require("../src/agent/project-store");
const { ProjectMemoryStore } = require("../src/agent/memory-store");
const { DurableRunStore } = require("../src/agent/run-store");
const { Redactor } = require("../src/agent/redactor");
const { sanitizeLegacyAgentLogs } = require("../src/agent/manager");

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotch-agent-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("canonical containment rejects traversal and sibling-prefix paths and permits missing children", (t) => {
  const root = temp(t);
  const project = path.join(root, "project");
  const sibling = path.join(root, "project-evil");
  fs.mkdirSync(project); fs.mkdirSync(sibling);
  assert.equal(isContainedPath(project, path.join(project, "src"), { allowMissing: true }), true);
  assert.equal(isContainedPath(project, sibling), false);
  assert.throws(() => resolveContainedPath(project, "../project-evil/file.txt", { allowMissing: true }), /outside/);
  assert.equal(resolveContainedPath(project, "new/deep/file.txt", { allowMissing: true }), path.join(project, "new", "deep", "file.txt"));
  if (process.platform === "win32") assert.equal(canonicalPathSync(project).toLowerCase(), canonicalPathSync(project.toUpperCase()).toLowerCase());
});

test("canonical containment rejects symlinks escaping the project when supported", (t) => {
  const root = temp(t);
  const project = path.join(root, "project"); const outside = path.join(root, "outside");
  fs.mkdirSync(project); fs.mkdirSync(outside);
  const link = path.join(project, "link");
  try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); } catch { t.skip("symlinks unavailable"); return; }
  assert.equal(isContainedPath(project, link), false);
  assert.equal(isContainedPath(project, path.join(link, "new.txt"), { allowMissing: true }), false);
});

test("scope ids are deterministic and path-sensitive", (t) => {
  const root = temp(t); const a = path.join(root, "a"); const b = path.join(root, "b"); fs.mkdirSync(a); fs.mkdirSync(b);
  assert.equal(scopeIdForProject(a), scopeIdForProject(a));
  assert.notEqual(scopeIdForProject(a), scopeIdForProject(b));
  assert.equal(scopeIdForProject(""), "no-project");
});

test("JSONL reader ignores a partial tail", (t) => {
  const root = temp(t); const file = path.join(root, "events.jsonl");
  appendJsonLine(file, { one: 1 }); fs.appendFileSync(file, '{"partial"');
  assert.deepEqual(readJsonLines(file), [{ one: 1 }]);
});

test("legacy log migration removes raw tasks, inputs, outputs, and file bodies in place", (t) => {
  const root = temp(t); const logs = path.join(root, "agent-logs", "reviewer"); fs.mkdirSync(logs, { recursive: true });
  const file = path.join(logs, "run.jsonl"); const secret = "sk-ant-legacy-secret-123456789"; const body = "private file body";
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: "2026-01-01", runId: "run", agentId: "reviewer", type: "agent-start", task: `use ${secret}` }),
    JSON.stringify({ timestamp: "2026-01-01", runId: "run", agentId: "reviewer", type: "tool-call", tool: "FileSystem.readFile", input: { path: "x.txt", content: body }, output: body }),
  ].join("\n"));
  const marker = path.join(root, "migration.json");
  const result = sanitizeLegacyAgentLogs({ logsDir: path.join(root, "agent-logs"), markerFile: marker, redactor: new Redactor({ secrets: [secret] }) });
  assert.equal(result.files, 1);
  const migrated = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(migrated, /private file body|legacy-secret/);
  assert.match(migrated, /byteCount/);
  assert.equal(sanitizeLegacyAgentLogs({ logsDir: path.join(root, "agent-logs"), markerFile: marker, redactor: new Redactor() }).migrated, false);
});

test("durable run store recovers running runs as interrupted and preserves approvals", (t) => {
  const root = temp(t); const redactor = new Redactor({ secrets: ["top-secret"] });
  const store = new DurableRunStore({ projectsDir: root, redactor, cipher: new CheckpointCipher({ fallbackKey: Buffer.alloc(32, 7) }) });
  const base = { scopeId: "scope", agentId: "agent", agentName: "Agent", projectPath: root, harness: "mock", model: "mock", parentRunId: null, depth: 0, childRunIds: [], createdAt: new Date().toISOString(), iteration: 0, tokenTotal: 0, pendingApproval: null, dedupeKey: null, outcome: null };
  store.create({ ...base, runId: "running", status: "running" }, { task: "top-secret task" });
  store.create({ ...base, runId: "approval", status: "waiting_approval", pendingApproval: { actionId: "x" } }, { task: "raw", pendingAction: { actionId: "x" } });
  const recovered = store.recover();
  assert.equal(store.read("scope", "running").status, "interrupted");
  assert.equal(store.read("scope", "approval").status, "waiting_approval");
  assert.equal(store.readCheckpoint("scope", "running").task, "top-secret task");
  assert.doesNotMatch(fs.readFileSync(path.join(root, "scope", "runs", "running", "state.json"), "utf8"), /top-secret/);
  assert.equal(recovered.length, 2);
});

test("project trust is scoped and legacy trust migrates only to no-project", (t) => {
  const root = temp(t); const legacy = path.join(root, "agent-trust.json");
  atomicWriteJson(legacy, { reviewer: { mode: "auto-execute", runCount: 9 } });
  const store = new ProjectStore({ settingsDir: root, legacyTrustFile: legacy });
  assert.equal(store.migrateLegacyTrust(), true);
  assert.equal(store.getTrust("", "reviewer").mode, "auto-execute");
  const project = path.join(root, "repo"); fs.mkdirSync(project);
  assert.equal(store.getTrust(project, "reviewer").mode, "ask-first");
  store.updateTrust(project, "reviewer", { mode: "suggest-only" });
  assert.equal(store.getTrust(project, "reviewer").mode, "suggest-only");
  assert.ok(require(legacy)._v2Migration);
});

test("memory is opt-in, deterministic, deduplicated, capped, versioned, and secret-safe", (t) => {
  const root = temp(t); const project = path.join(root, "repo"); fs.mkdirSync(project);
  const projectStore = new ProjectStore({ settingsDir: path.join(root, "settings") });
  const memory = new ProjectMemoryStore({ projectStore, redactor: new Redactor({ secrets: ["known-secret-value"] }), maxFacts: 3, maxRevisions: 3 });
  assert.equal(memory.status(project).enabled, false);
  assert.throws(() => memory.capture(project, [{ fact: "Node version is 24" }]), /disabled/);
  memory.enable(project, true);
  const capture = memory.capture(project, [
    { fact: "Node version is 24", category: "toolchain" },
    { fact: "Node version is 24", category: "duplicate" },
    { fact: "Credential known-secret-value", category: "secret" },
    { fact: "Tests use node test", category: "testing" },
    { fact: "The project is local first", category: "architecture" },
    { fact: "Oldest should be capped", category: "cap" },
  ], { agentId: "reviewer", runId: "run" });
  assert.equal(capture.snapshot.facts.length, 3);
  assert.equal(capture.snapshot.facts.some((fact) => fact.fact.includes("known-secret")), false);
  assert.equal(memory.recall(project, "project architecture")[0].category, "architecture");
  const history = memory.history(project); assert.ok(history.length <= 3);
  const current = memory.status(project).version;
  const target = history.at(-1).version;
  memory.restore(project, target, current);
  assert.throws(() => memory.restore(project, target, current), /changed/);
});
