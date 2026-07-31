"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("main process delegates agent runtime and contains no v1 command-pattern implementation", () => {
  const main = read("src/main.js");
  assert.match(main, /createAgentRuntimeV2/);
  assert.match(main, /agentRuntimeV2\.registerIpc/);
  assert.doesNotMatch(main, /DANGEROUS_COMMAND_PATTERNS|parseAgentYaml|class AgentRuntime/);
});

test("preload exposes every durable project control", () => {
  const preload = read("src/preload.js");
  for (const name of [
    "agentRunsList", "agentRunEvents", "agentRunStart", "agentRunRetry", "agentRunResume", "agentRunStop", "agentRunApprove", "agentRunReject",
    "agentTrustGet", "agentTrustUpdate", "agentPolicyGet", "agentPolicyUpdate", "agentSettingsGet", "agentSettingsUpdate",
    "agentMemoryStatus", "agentMemoryEnable", "agentMemoryList", "agentMemoryDelete", "agentMemoryHistory", "agentMemoryRestore",
    "agentAutomationList", "agentAutomationEnable", "agentAutomationDisable", "agentAutomationRunNow",
  ]) assert.match(preload, new RegExp(`\\b${name}\\s*:`), name);
});

test("agent panel includes run, trust/policy, memory, automation, and recovered approval controls", () => {
  const html = read("src/index.html"); const renderer = read("src/renderer.js");
  for (const id of [
    "agent-run-list", "agent-run-events", "btn-agent-run-retry", "btn-agent-run-approve", "btn-agent-run-reject",
    "agent-trust-mode", "agent-project-policy", "agent-repository-policy", "agent-memory-enabled", "agent-memory-history",
    "agent-automation-list", "set-agents-enabled", "set-agent-approval-mode", "set-agent-max-concurrent", "set-agent-auto-trigger",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), id);
  assert.match(renderer, /saveAgentSettingsUI/);
  assert.match(renderer, /agentRunApprove/);
  assert.match(renderer, /agentMemoryRestore/);
  assert.match(renderer, /agentAutomationEnable/);
});
