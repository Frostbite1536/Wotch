"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentDefinitionStore, parseDefinition, validateTrigger } = require("../src/agent/definitions");
const { LocalPtyExecutionBackend, reducedEnvironment } = require("../src/agent/execution-backend");

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wotch-definition-test-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test("complete YAML parsing preserves nested triggers and project precedence", (t) => {
  const root = temp(t); const bundled = path.join(root, "bundled"); const user = path.join(root, "user"); const project = path.join(root, "project");
  fs.mkdirSync(bundled); fs.mkdirSync(user); fs.mkdirSync(path.join(project, ".wotch", "agents"), { recursive: true });
  const yaml = (description, task) => `name: watcher\ndescription: ${description}\nsystemPrompt: |\n  Help safely.\ntools:\n  - Shell.execute\nharness: anthropic\nmaxTurns: 4\nmaxTokenBudget: 1000\ntriggers:\n  - type: cron\n    id: nightly\n    schedule: \"0 2 * * *\"\n    timezone: America/Chicago\n    task: ${task}\n  - type: fileWatch\n    id: source\n    globs:\n      - \"src/**/*.js\"\n    ignoredGlobs:\n      - \"src/generated/**\"\n    debounceMs: 500\n    task: Inspect changes\n  - type: commandWatch\n    id: status\n    command: git status --porcelain\n    intervalSeconds: 60\n    timeoutMs: 5000\n    compare: output\n    task: Explain changes\n`;
  fs.writeFileSync(path.join(bundled, "watcher.yaml"), yaml("bundled", "Bundled task"));
  fs.writeFileSync(path.join(user, "watcher.yaml"), yaml("user", "User task"));
  fs.writeFileSync(path.join(project, ".wotch", "agents", "watcher.yaml"), yaml("project", "Project task"));
  const store = new AgentDefinitionStore({ bundledDir: bundled, userDir: user }); store.discover(project);
  assert.equal(store.get("watcher").description, "project");
  assert.equal(store.get("watcher").triggers[0].timezone, "America/Chicago");
  assert.deepEqual(store.get("watcher").triggers[1].ignoredGlobs, ["src/generated/**"]);
  assert.equal(parseDefinition(path.join(bundled, "watcher.yaml")).harness, "anthropic");
});

test("automation trigger validation rejects unstable or unsafe configuration", () => {
  assert.throws(() => validateTrigger({ type: "cron", id: "x", schedule: "* * * *", task: "x" }, 0), /five-field/);
  assert.throws(() => validateTrigger({ type: "fileWatch", id: "x", globs: [], task: "x" }, 0), /requires globs/);
  assert.throws(() => validateTrigger({ type: "commandWatch", id: "x", command: "echo x", intervalSeconds: 59, task: "x" }, 0), /60-86400/);
  assert.throws(() => validateTrigger({ type: "commandWatch", id: "x", command: "echo x", intervalSeconds: 60, compare: "weird", task: "x" }, 0), /comparison/);
});

test("reduced environment excludes provider credentials unless explicitly approved", () => {
  const source = { PATH: "bin", HOME: "home", ANTHROPIC_API_KEY: "secret", OPENROUTER_API_KEY: "secret2", PROJECT_MODE: "dev" };
  assert.deepEqual(reducedEnvironment(["PROJECT_MODE"], source), { PATH: "bin", HOME: "home", PROJECT_MODE: "dev", TERM: "xterm-256color" });
  assert.equal(reducedEnvironment(["ANTHROPIC_API_KEY"], source).ANTHROPIC_API_KEY, "secret");
});

test("local PTY backend enforces cwd, timeout/output metadata, and cancellation", async (t) => {
  const root = temp(t); const project = path.join(root, "project"); fs.mkdirSync(project);
  let handlers;
  const fakePty = { spawn: (_exe, _args, options) => {
    handlers = {};
    const proc = {
      onData: (callback) => { handlers.data = callback; },
      onExit: (callback) => { handlers.exit = callback; queueMicrotask(() => { handlers.data("hello"); callback({ exitCode: 0 }); }); },
      kill: () => handlers.exit?.({ exitCode: 1, signal: 9 }),
    };
    assert.equal(options.cwd, project);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    return proc;
  } };
  const backend = new LocalPtyExecutionBackend({ pty: fakePty, platform: "win32", envSource: { PATH: "bin", ANTHROPIC_API_KEY: "secret" } });
  const result = await backend.execute({ command: "echo hi", projectPath: project, timeoutMs: 1000 });
  assert.equal(result.stdout, "hello"); assert.equal(result.exitCode, 0);
  await assert.rejects(() => backend.execute({ command: "echo hi", projectPath: project, cwd: "../outside", timeoutMs: 1000 }), /outside/);
});
