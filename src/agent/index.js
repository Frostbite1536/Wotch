"use strict";

const { AgentManager } = require("./manager");
const { AutomationService } = require("./automation");
const { registerAgentIpc } = require("./ipc");

function createAgentRuntimeV2(options) {
  const manager = new AgentManager(options);
  const automation = new AutomationService({
    manager, projectStore: manager.projectStore, backend: manager.backend,
    policyEvaluator: manager.policyEvaluator, redactor: manager.redactor, notify: manager.notify,
  });
  return { manager, automation, registerIpc: (ipcMain) => registerAgentIpc({ ipcMain, manager, automation }) };
}

module.exports = { createAgentRuntimeV2 };
