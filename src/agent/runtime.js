"use strict";

const crypto = require("crypto");
const { estimateTokens } = require("./harness");
const { summarizeToolBoundary, byteSummary } = require("./redactor");

function usageTotal(usage = {}) { return Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0); }

function summarizeToolInput(tool, input, redactor) {
  const summary = { tool };
  if (input?.path) summary.path = input.path;
  if (input?.cwd) summary.cwd = input.cwd;
  if (tool === "Shell.execute") summary.commandPreview = redactor.redactString(input.command || "", { maxString: 500 });
  if (typeof input?.content === "string") Object.assign(summary, byteSummary(input.content));
  if (typeof input?.fact === "string") Object.assign(summary, byteSummary(input.fact));
  if (input?.agentId) summary.agentId = input.agentId;
  return redactor.redact(summary);
}

class AgentRuntime {
  constructor({ definition, state, checkpoint, adapter, tools, toolDefs, policyEvaluator, getPolicy, getTrustMode, redactor, runStore, memoryStore, emit, approvalTimeoutMs = 300000, now = () => new Date(), abortController }) {
    this.definition = definition;
    this.state = state;
    this.checkpoint = checkpoint;
    this.adapter = adapter;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.policyEvaluator = policyEvaluator;
    this.getPolicy = getPolicy;
    this.getTrustMode = getTrustMode;
    this.redactor = redactor;
    this.runStore = runStore;
    this.memoryStore = memoryStore;
    this.emitExternal = emit;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.now = now;
    this.abortController = abortController || new AbortController();
    this.pendingResolver = null;
    this.childRunIds = new Set(state.childRunIds || []);
  }

  get runId() { return this.state.runId; }
  get status() { return this.state.status; }

  async run({ recoveredDecision } = {}) {
    try {
      this._setState({ status: "running", startedAt: this.state.startedAt || this.now().toISOString() });
      this._event("started", { agentId: this.state.agentId, agentName: this.definition.displayName || this.definition.name, recovered: Boolean(recoveredDecision) });
      if (this.checkpoint.pendingBatch) {
        const results = await this._processToolBatch(this.checkpoint.pendingBatch.toolUses, this.checkpoint.pendingBatch.index, this.checkpoint.pendingBatch.toolResults, recoveredDecision);
        if (this.abortController.signal.aborted) return this._stop("cancelled");
        this.checkpoint.messages.push({ role: "user", content: results });
        delete this.checkpoint.pendingBatch;
        delete this.checkpoint.pendingAction;
        this._checkpoint("after-recovered-tool-batch");
      }
      return await this._loop();
    } catch (error) {
      if (error?.name === "AbortError" || this.abortController.signal.aborted) return this._stop("cancelled");
      return this._fail(error);
    }
  }

  async _loop() {
    const maxTurns = this.definition.maxTurns || 10;
    const maxTokenBudget = this.definition.maxTokenBudget || 40000;
    this.checkpoint.modelCalls = Number(this.checkpoint.modelCalls || 0);
    while (this.checkpoint.modelCalls < maxTurns && !this.abortController.signal.aborted) {
      if (this.checkpoint.tokenTotal >= maxTokenBudget) return this._fail(new Error("Agent token budget exhausted"), "token-budget");
      await this._maybeCompact(maxTokenBudget, maxTurns);
      if (this.abortController.signal.aborted) return this._stop("cancelled");
      if (this.checkpoint.modelCalls >= maxTurns) return this._complete("Agent reached maximum model calls", "max-turns");
      this.checkpoint.iteration++;
      this.checkpoint.modelCalls++;
      this._setState({ status: "running", iteration: this.checkpoint.iteration, tokenTotal: this.checkpoint.tokenTotal });
      this._event("reasoning", { text: `Turn ${this.checkpoint.iteration}/${maxTurns}` });
      this._checkpoint("before-model");
      const response = await this.adapter.runTurn({
        model: this.definition.model,
        system: this.checkpoint.systemPrompt,
        messages: this.checkpoint.messages,
        tools: this.toolDefs,
        maxTokens: Math.min(4096, Math.max(1, maxTokenBudget - this.checkpoint.tokenTotal)),
        signal: this.abortController.signal,
      });
      if (this.abortController.signal.aborted) return this._stop("cancelled");
      this.checkpoint.tokenTotal += usageTotal(response.usage);
      this.checkpoint.messages.push({ role: "assistant", content: response.content });
      this._checkpoint("after-model");
      if (this.checkpoint.tokenTotal > maxTokenBudget) return this._fail(new Error("Agent token budget exhausted"), "token-budget");
      const textBlocks = response.content.filter((block) => block.type === "text");
      const toolUses = response.content.filter((block) => block.type === "tool_use");
      for (const block of textBlocks) this._event("reasoning", { text: block.text });

      if (!toolUses.length) {
        const finalResponse = textBlocks.map((block) => block.text).join("\n");
        await this._captureMemory(finalResponse, maxTokenBudget, maxTurns);
        return this._complete(finalResponse, response.stopReason || "end_turn");
      }
      const toolResults = await this._processToolBatch(toolUses, 0, []);
      if (this.abortController.signal.aborted) return this._stop("cancelled");
      this.checkpoint.messages.push({ role: "user", content: toolResults });
      delete this.checkpoint.pendingBatch;
      delete this.checkpoint.pendingAction;
      this._checkpoint("after-tool-batch");
    }
    return this._complete("Agent reached maximum turns", "max-turns");
  }

  async _maybeCompact(maxTokenBudget, maxTurns) {
    const contextBudget = this.adapter.getContextBudget(this.definition.model);
    if (estimateTokens(this.checkpoint.messages) < contextBudget * 0.8) return;
    if (this.checkpoint.modelCalls + 1 >= maxTurns) return;
    this.checkpoint.modelCalls++;
    this._checkpoint("before-compaction");
    const compacted = await this.adapter.compactHistory({
      model: this.definition.model, system: this.checkpoint.systemPrompt,
      messages: this.checkpoint.messages, signal: this.abortController.signal,
    });
    this.checkpoint.tokenTotal += usageTotal(compacted.usage);
    if (this.checkpoint.tokenTotal > maxTokenBudget) throw new Error("Agent token budget exhausted during compaction");
    this.checkpoint.messages = compacted.messages;
    this._event("compaction", { preservedToolExchanges: 2, tokenTotal: this.checkpoint.tokenTotal });
    this._checkpoint("after-compaction");
  }

  async _processToolBatch(toolUses, startIndex, toolResults, recoveredDecision) {
    const results = [...toolResults];
    for (let index = startIndex; index < toolUses.length; index++) {
      if (this.abortController.signal.aborted) break;
      const toolUse = toolUses[index];
      const inputSummary = summarizeToolInput(toolUse.name, toolUse.input, this.redactor);
      this._event("tool-call", inputSummary);
      const evaluation = this._evaluate(toolUse.name, toolUse.input);
      if (evaluation.decision === "deny") {
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Denied by policy (${evaluation.ruleId}): ${evaluation.reason}`, is_error: true });
        this._event("policy-denied", { tool: toolUse.name, policy: evaluation });
        continue;
      }

      let decision = recoveredDecision;
      recoveredDecision = undefined;
      if (evaluation.decision === "require_approval" && !decision) {
        const actionId = crypto.randomUUID();
        this.checkpoint.pendingBatch = { toolUses, index, toolResults: results };
        this.checkpoint.pendingAction = { actionId, toolUse };
        this._setState({ status: "waiting_approval", pendingApproval: { actionId, ...inputSummary, policy: evaluation } });
        this._checkpoint("waiting-approval");
        this._event("approval-waiting", { actionId, ...inputSummary, policy: evaluation });
        decision = await this._waitForApproval(actionId);
      }
      if (decision === "approve") {
        const current = this._evaluate(toolUse.name, toolUse.input);
        if (current.decision === "deny") decision = "reject";
      }
      if (decision === "reject" || decision === "stop") {
        this._event("approval-response", { actionId: this.checkpoint.pendingAction?.actionId, decision });
        if (decision === "stop") { this.stop(); break; }
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User rejected this action", is_error: true });
        this._setState({ status: "running", pendingApproval: null });
        continue;
      }

      this._setState({ status: "running", pendingApproval: null });
      this._checkpoint("before-tool");
      const startedAt = Date.now();
      try {
        const tool = this.tools[toolUse.name];
        if (!tool) throw new Error(`Unknown tool: ${toolUse.name}`);
        const result = await tool(toolUse.input);
        const rawOutput = typeof result === "string" ? result : JSON.stringify(result);
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: rawOutput });
        const summary = summarizeToolBoundary({ tool: toolUse.name, input: toolUse.input, result, durationMs: Date.now() - startedAt, projectPath: this.checkpoint.context.projectPath, redactor: this.redactor });
        this.checkpoint.toolSummaries.push(summary);
        this._event("tool-result", summary);
      } catch (error) {
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${error.message}`, is_error: true });
        this._event("error", { tool: toolUse.name, message: error.message });
      }
      this._checkpoint("after-tool");
    }
    return results;
  }

  _evaluate(tool, input) {
    const policy = this.getPolicy();
    return this.policyEvaluator.evaluate({ tool, input, trustMode: this.getTrustMode(), ...policy });
  }

  _waitForApproval(actionId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingResolver?.actionId === actionId) {
          this.pendingResolver = null;
          resolve("reject");
        }
      }, this.approvalTimeoutMs);
      this.pendingResolver = { actionId, resolve: (decision) => { clearTimeout(timer); this.pendingResolver = null; resolve(decision); } };
    });
  }

  resolveApproval(actionId, decision) {
    if (this.pendingResolver?.actionId !== actionId) return false;
    this.pendingResolver.resolve(decision);
    return true;
  }

  async _captureMemory(finalResponse, maxTokenBudget, maxTurns) {
    if (this.state.parentRunId || !this.checkpoint.context.projectPath || !this.memoryStore.status(this.checkpoint.context.projectPath).enabled) return;
    if (this.checkpoint.tokenTotal >= maxTokenBudget || this.checkpoint.modelCalls >= maxTurns) return;
    try {
      this.checkpoint.modelCalls++;
      this._checkpoint("before-memory-extraction");
      const result = await this.adapter.extractMemoryCandidates({
        model: this.definition.model,
        task: this.redactor.redactString(this.checkpoint.task),
        finalResponse: this.redactor.redactString(finalResponse),
        toolSummaries: this.checkpoint.toolSummaries,
        signal: this.abortController.signal,
      });
      this.checkpoint.tokenTotal += usageTotal(result.usage);
      if (this.checkpoint.tokenTotal <= maxTokenBudget) {
        const captured = this.memoryStore.capture(this.checkpoint.context.projectPath, result.candidates, { agentId: this.state.agentId, runId: this.runId }, { authorized: true });
        this._event("memory-captured", { candidateCount: result.candidates.length, addedCount: captured.added.length });
      }
      this._checkpoint("after-memory-extraction");
    } catch (error) {
      this._event("memory-error", { message: error.message });
    }
  }

  stop() {
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error("Agent stopped"));
    if (this.pendingResolver) this.pendingResolver.resolve("stop");
  }

  addChild(runId) { this.childRunIds.add(runId); this._setState({ childRunIds: [...this.childRunIds] }); }

  _checkpoint(boundary) {
    this.runStore.writeCheckpoint(this.state.scopeId, this.runId, this.checkpoint);
    this._setState({ iteration: this.checkpoint.iteration, modelCalls: this.checkpoint.modelCalls || 0, tokenTotal: this.checkpoint.tokenTotal, lastBoundary: boundary });
  }

  _setState(patch) {
    this.state = this.runStore.update(this.state.scopeId, this.runId, patch);
  }

  _event(type, data) {
    const event = this.runStore.appendEvent(this.state.scopeId, this.runId, { type, data });
    this.emitExternal?.({ runId: this.runId, type, data: event.data, timestamp: event.timestamp, parentRunId: this.state.parentRunId, depth: this.state.depth });
  }

  _complete(summary, reason) {
    this._setState({ status: "completed", completedAt: this.now().toISOString(), iteration: this.checkpoint.iteration, tokenTotal: this.checkpoint.tokenTotal, pendingApproval: null, outcome: { reason, summary: this.redactor.redactString(summary, { maxString: 2000 }) } });
    this._event("completed", { summary, turnsUsed: this.checkpoint.iteration, tokenTotal: this.checkpoint.tokenTotal, reason });
    this.runStore.deleteCheckpoint(this.state.scopeId, this.runId);
    return summary;
  }

  _stop(reason) {
    this._setState({ status: "stopped", completedAt: this.now().toISOString(), pendingApproval: null, outcome: { reason } });
    this._event("stopped", { reason });
    this.runStore.deleteCheckpoint(this.state.scopeId, this.runId);
    return "Agent stopped";
  }

  _fail(error, reason = "error") {
    this._setState({ status: "failed", completedAt: this.now().toISOString(), pendingApproval: null, outcome: { reason, error: this.redactor.redactString(error.message) } });
    this._event("error", { message: error.message, reason });
    this._event("failed", { message: error.message, reason });
    this.runStore.deleteCheckpoint(this.state.scopeId, this.runId);
    return `Agent failed: ${this.redactor.redactString(error.message)}`;
  }
}

module.exports = { AgentRuntime, summarizeToolInput, usageTotal };
