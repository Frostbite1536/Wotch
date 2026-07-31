"use strict";

function object(value, name = "payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function string(value, name, max = 4096, { optional = false } = {}) {
  if (optional && (value == null || value === "")) return value || "";
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} is invalid`);
  return value;
}
function id(value, name = "id") { return string(value, name, 100); }
function project(value, { optional = false } = {}) { return string(value, "projectPath", 4096, { optional }); }

function registerAgentIpc({ ipcMain, manager, automation }) {
  const handle = (channel, callback) => ipcMain.handle(channel, (_event, payload = {}) => callback(object(payload)));

  handle("agent-v2-runs-list", ({ projectPath, limit }) => manager.listRuns(project(projectPath, { optional: true }), limit));
  handle("agent-v2-runs-events", ({ runId }) => manager.getRunEvents(id(runId, "runId")));
  handle("agent-v2-runs-start", ({ agentId, context = {} }) => manager.startAgent(id(agentId, "agentId"), object(context, "context")));
  handle("agent-v2-runs-retry", ({ runId }) => manager.retryRun(id(runId, "runId")));
  handle("agent-v2-runs-resume", ({ runId, actionId, decision }) => manager.approveAction(id(runId, "runId"), id(actionId, "actionId"), decision || "approve"));
  handle("agent-v2-runs-stop", ({ runId }) => manager.stopAgent(id(runId, "runId")));
  handle("agent-v2-runs-approve", ({ runId, actionId, decision }) => manager.approveAction(id(runId, "runId"), id(actionId, "actionId"), decision || "approve"));
  handle("agent-v2-runs-reject", ({ runId, actionId }) => manager.approveAction(id(runId, "runId"), id(actionId, "actionId"), "reject"));

  handle("agent-v2-trust-get", ({ projectPath, agentId }) => manager.getTrust(project(projectPath, { optional: true }), id(agentId, "agentId")));
  handle("agent-v2-trust-update", ({ projectPath, agentId, mode }) => manager.setTrust(project(projectPath, { optional: true }), id(agentId, "agentId"), string(mode, "mode", 30)));
  handle("agent-v2-policy-get", ({ projectPath }) => manager.getPolicy(project(projectPath, { optional: true })));
  handle("agent-v2-policy-update", ({ projectPath, policy }) => manager.updatePolicy(project(projectPath), object(policy, "policy")));
  ipcMain.handle("agent-v2-settings-get", () => manager.getAgentSettings());
  handle("agent-v2-settings-update", (payload) => manager.setAgentSettings(payload));

  handle("agent-v2-memory-status", ({ projectPath }) => manager.memoryStatus(project(projectPath)));
  handle("agent-v2-memory-enable", ({ projectPath, enabled }) => manager.memoryEnable(project(projectPath), Boolean(enabled)));
  handle("agent-v2-memory-list", ({ projectPath, query }) => manager.memoryList(project(projectPath), query == null ? "" : string(query, "query", 500, { optional: true })));
  handle("agent-v2-memory-delete", ({ projectPath, factId }) => manager.memoryDelete(project(projectPath), id(factId, "factId")));
  handle("agent-v2-memory-history", ({ projectPath }) => manager.memoryHistory(project(projectPath)));
  handle("agent-v2-memory-restore", ({ projectPath, version, expectedVersion }) => {
    if (!Number.isInteger(version) || !Number.isInteger(expectedVersion)) throw new Error("Memory versions must be integers");
    return manager.memoryRestore(project(projectPath), version, expectedVersion);
  });

  handle("agent-v2-automation-list", ({ projectPath }) => automation.list(project(projectPath)));
  handle("agent-v2-automation-enable", ({ projectPath, agentId, triggerId, standingApproval, approvalToken }) => automation.enable(project(projectPath), id(agentId, "agentId"), id(triggerId, "triggerId"), { standingApproval: Boolean(standingApproval), approvalToken: approvalToken ? id(approvalToken, "approvalToken") : null }));
  handle("agent-v2-automation-disable", ({ projectPath, agentId, triggerId }) => automation.disable(project(projectPath), id(agentId, "agentId"), id(triggerId, "triggerId")));
  handle("agent-v2-automation-run-now", ({ projectPath, agentId, triggerId }) => automation.runNow(project(projectPath), id(agentId, "agentId"), id(triggerId, "triggerId")));

  // Compatibility wrappers retained for one release.
  ipcMain.handle("agent-list", (_event, payload = {}) => manager.getAgentList(typeof payload.projectPath === "string" ? payload.projectPath : ""));
  handle("agent-start", ({ agentId, context = {} }) => manager.startAgent(id(agentId, "agentId"), object(context, "context")));
  handle("agent-stop", ({ runId }) => manager.stopAgent(id(runId, "runId")));
  handle("agent-approve", ({ runId, actionId, decision }) => manager.approveAction(id(runId, "runId"), id(actionId, "actionId"), decision || "approve"));
  handle("agent-reject", ({ runId, actionId }) => manager.approveAction(id(runId, "runId"), id(actionId, "actionId"), "reject"));
  ipcMain.handle("agent-runs", () => manager.getRunningAgents());
  ipcMain.handle("agent-tree", () => manager.getTree());
  handle("agent-get-trust", ({ agentId, projectPath = "" }) => manager.getTrust(project(projectPath, { optional: true }), id(agentId, "agentId")));
  handle("agent-set-trust", ({ agentId, mode, projectPath = "" }) => manager.setTrust(project(projectPath, { optional: true }), id(agentId, "agentId"), string(mode, "mode", 30)));
}

module.exports = { registerAgentIpc };
