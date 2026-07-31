"use strict";

const os = require("os");
const path = require("path");
const { resolveContainedPath } = require("./storage");

const ESSENTIAL_ENV = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "USER", "USERNAME", "LANG", "LC_ALL", "TERM",
];
const CREDENTIAL_ENV = /(?:ANTHROPIC|OPENROUTER|OPENAI|API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH|CREDENTIAL|PASSWORD|SECRET)/i;

function reducedEnvironment(approvedNames = [], source = process.env) {
  const allowed = new Set([...ESSENTIAL_ENV, ...approvedNames.filter((name) => typeof name === "string")]);
  const output = {};
  for (const name of allowed) {
    if (!Object.prototype.hasOwnProperty.call(source, name)) continue;
    if (CREDENTIAL_ENV.test(name) && !approvedNames.includes(name)) continue;
    output[name] = source[name];
  }
  output.TERM = output.TERM || "xterm-256color";
  return output;
}

function shellForDialect(dialect, platform = process.platform) {
  if (dialect === "powershell") return { executable: platform === "win32" ? "powershell.exe" : "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] };
  if (dialect === "cmd") return { executable: platform === "win32" ? "cmd.exe" : "cmd", args: ["/d", "/s", "/c"] };
  return { executable: process.env.SHELL || (platform === "win32" ? "bash.exe" : "/bin/sh"), args: ["-c"] };
}

class AgentExecutionBackend {
  async execute() { throw new Error("AgentExecutionBackend.execute must be implemented"); }
}

class LocalPtyExecutionBackend extends AgentExecutionBackend {
  constructor({ pty, stripAnsi, platform = process.platform, envSource = process.env } = {}) {
    super();
    if (!pty?.spawn) throw new Error("LocalPtyExecutionBackend requires node-pty");
    this.pty = pty;
    this.stripAnsi = stripAnsi || ((value) => String(value).replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, ""));
    this.platform = platform;
    this.envSource = envSource;
  }

  async execute({ command, projectPath, cwd, dialect, approvedEnvNames = [], timeoutMs = 30000, maxOutputBytes = 102400, signal }) {
    if (typeof command !== "string" || !command.trim()) throw new Error("Command is required");
    const root = projectPath || os.homedir();
    const workDir = cwd ? resolveContainedPath(root, cwd) : path.resolve(root);
    const selectedDialect = dialect || (this.platform === "win32" ? "cmd" : "posix");
    const shell = shellForDialect(selectedDialect, this.platform);
    const boundedTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 30000, 120000));
    const boundedOutput = Math.max(1024, Math.min(Number(maxOutputBytes) || 102400, 1048576));
    if (signal?.aborted) throw signal.reason || new Error("Command cancelled");

    return new Promise((resolve, reject) => {
      let output = "";
      let outputBytes = 0;
      let timedOut = false;
      let truncated = false;
      let settled = false;
      const startedAt = Date.now();
      const proc = this.pty.spawn(shell.executable, [...shell.args, command], {
        name: "xterm-256color", cols: 120, rows: 40, cwd: workDir,
        env: reducedEnvironment(approvedEnvNames, this.envSource),
      });
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", abort);
        callback(value);
      };
      const abort = () => {
        try { proc.kill(); } catch { /* already exited */ }
        const error = signal?.reason instanceof Error ? signal.reason : new Error("Command cancelled");
        error.name = "AbortError";
        finish(reject, error);
      };
      signal?.addEventListener?.("abort", abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* noop */ } }, boundedTimeout);
      proc.onData((data) => {
        if (truncated) return;
        const clean = this.stripAnsi(data);
        outputBytes += Buffer.byteLength(clean);
        output += clean;
        if (outputBytes > boundedOutput) {
          output = `${Buffer.from(output).subarray(0, boundedOutput).toString("utf8")}\n[truncated]`;
          truncated = true;
          try { proc.kill(); } catch { /* noop */ }
        }
      });
      proc.onExit(({ exitCode, signal: exitSignal }) => finish(resolve, {
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal: exitSignal ?? null,
        stdout: output,
        stderr: "",
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      }));
    });
  }
}

module.exports = { AgentExecutionBackend, LocalPtyExecutionBackend, reducedEnvironment, shellForDialect };
