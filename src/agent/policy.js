"use strict";

const crypto = require("crypto");
const { Redactor } = require("./redactor");

const DECISIONS = new Set(["allow", "require_approval", "deny"]);
const DIALECTS = new Set(["any", "posix", "cmd", "powershell"]);

const TOOL_RISK = Object.freeze({
  "Shell.execute": "write",
  "Shell.readVisibleTerminal": "read",
  "FileSystem.readFile": "read",
  "FileSystem.writeFile": "write",
  "FileSystem.listFiles": "read",
  "FileSystem.searchFiles": "read",
  "FileSystem.deleteFile": "dangerous",
  "Git.status": "safe",
  "Git.diff": "read",
  "Git.log": "read",
  "Git.checkpoint": "write",
  "Git.branchInfo": "safe",
  "Terminal.readBuffer": "read",
  "Terminal.detectPattern": "read",
  "Project.list": "safe",
  "Project.getInfo": "safe",
  "Wotch.getStatus": "safe",
  "Wotch.showNotification": "safe",
  "Agent.spawn": "write",
  "Memory.read": "read",
  "Memory.query": "read",
  "Memory.capture": "write",
});

function policyRevision(layers) {
  return crypto.createHash("sha256").update(JSON.stringify(layers || {})).digest("hex").slice(0, 16);
}

function validateSafeRegex(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("Policy pattern is required");
  if (pattern.length > 256) throw new Error("Policy pattern exceeds 256 characters");
  if (/\\[1-9]/.test(pattern)) throw new Error("Policy patterns may not contain backreferences");
  if (/\(\?(?:[=!<]|<[=!])/.test(pattern)) throw new Error("Policy patterns may not contain lookarounds");
  if (/\([^)]*(?:\*|\+|\{\d+(?:,\d*)?\})[^)]*\)(?:\*|\+|\{\d+(?:,\d*)?\})/.test(pattern)) {
    throw new Error("Policy patterns may not contain nested repetition");
  }
  const quantifiedGroup = pattern.match(/\(([^()]*)\)(?:\*|\+|\{\d+(?:,\d*)?\})/);
  if (quantifiedGroup?.[1].includes("|")) throw new Error("Policy patterns may not quantify alternation");
  try { return new RegExp(pattern, "i"); } catch (error) { throw new Error(`Invalid policy pattern: ${error.message}`); }
}

function validatePolicyRule(rule, { repository = false } = {}) {
  if (!rule || typeof rule !== "object") throw new Error("Policy rule must be an object");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(rule.id || "")) throw new Error("Policy rule id is invalid");
  if (!DIALECTS.has(rule.dialect || "any")) throw new Error("Policy rule dialect is invalid");
  if (!DECISIONS.has(rule.decision)) throw new Error("Policy rule decision is invalid");
  if (repository && rule.decision === "allow") throw new Error("Repository policy cannot add allow rules");
  if (typeof rule.reason !== "string" || !rule.reason.trim() || rule.reason.length > 300) throw new Error("Policy rule reason is invalid");
  const regex = validateSafeRegex(rule.pattern);
  return { id: rule.id, dialect: rule.dialect || "any", pattern: rule.pattern, decision: rule.decision, reason: rule.reason.trim(), regex };
}

function removeHereDocBodies(command) {
  const lines = String(command).split(/\r?\n/);
  const output = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator) {
      if (line.trim() === terminator) terminator = null;
      output.push("");
      continue;
    }
    output.push(line);
    const match = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (match) terminator = match[1];
  }
  return output.join("\n");
}

function splitExecutableSegments(command, dialect) {
  const text = removeHereDocBodies(command);
  const segments = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let pipeline = false;
  const escapeCharacter = dialect === "cmd" ? "^" : dialect === "powershell" ? "`" : "\\";
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === escapeCharacter && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) {
      current += char;
      if (char === quote && !(dialect === "powershell" && text[index + 1] === quote)) quote = null;
      else if (dialect === "powershell" && char === quote && text[index + 1] === quote) current += text[++index];
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    const pair = text.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) segments.push({ text: current.trim(), pipeline });
      current = ""; pipeline = false; index++; continue;
    }
    if (pair === "|&") {
      if (current.trim()) segments.push({ text: current.trim(), pipeline });
      current = ""; pipeline = true; index++; continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      if (current.trim()) segments.push({ text: current.trim(), pipeline });
      current = ""; pipeline = char === "|"; continue;
    }
    current += char;
  }
  if (current.trim()) segments.push({ text: current.trim(), pipeline });
  return { segments, ambiguous: Boolean(quote || escaped) };
}

function tokenize(segment, dialect = "posix") {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  const escapeCharacter = dialect === "cmd" ? "^" : dialect === "powershell" ? "`" : "\\";
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (escaped) { token += char; escaped = false; continue; }
    if (char === escapeCharacter && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { tokens.push(token); token = ""; }
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return { tokens, ambiguous: Boolean(quote || escaped) };
}

function executableName(token) {
  return String(token || "").replace(/^.*[\\/]/, "").replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase();
}

function extractSubstitutions(command, dialect) {
  const found = [];
  let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue; }
    if (char === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; continue; }
    if (quote === "'") continue;
    if (dialect === "posix" && char === "`" && command[index + 1] !== "`") {
      const end = command.indexOf("`", index + 1);
      if (end < 0) return { found, ambiguous: true };
      found.push(command.slice(index + 1, end)); index = end; continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      let depth = 1;
      let end = index + 2;
      for (; end < command.length && depth; end++) {
        if (command[end] === "(") depth++;
        if (command[end] === ")") depth--;
      }
      if (depth) return { found, ambiguous: true };
      found.push(command.slice(index + 2, end - 1)); index = end - 1;
    }
  }
  return { found, ambiguous: false };
}

function finding(decision, ruleId, reason, matchedText, dialect) {
  return { decision, ruleId, source: "immutable-floor", dialect, reason, matchedText };
}

function scanSegment(segment, dialect) {
  const { tokens, ambiguous } = tokenize(segment.text, dialect);
  if (ambiguous || tokens.length === 0) return ambiguous ? finding("require_approval", "floor.ambiguous", "Command quoting could not be parsed safely", segment.text, dialect) : null;
  let offset = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[offset] || "")) offset++;
  while (dialect === "powershell" && ["&", "."].includes(tokens[offset])) offset++;
  while (["env", "command", "nohup", "call", "start"].includes(executableName(tokens[offset]))) offset++;
  const executable = executableName(tokens[offset]);
  const args = tokens.slice(offset + 1);
  const lower = args.map((item) => item.toLowerCase());

  if (executable === "mkfs" || executable.startsWith("mkfs.") || ["diskpart", "format", "clear-disk", "format-volume", "initialize-disk", "bcdedit"].includes(executable)) {
    return finding("deny", `floor.${executable}`, "Destructive disk or boot operation is blocked", segment.text, dialect);
  }
  if (executable === "dd" && args.some((arg) => /^of=(?:\/dev\/|\\\\\.\\)/i.test(arg))) {
    return finding("deny", "floor.raw-disk-write", "Raw disk writes are blocked", segment.text, dialect);
  }
  if (["sudo", "doas", "runas", "pkexec"].includes(executable) || (executable === "start-process" && lower.some((arg) => /runas/i.test(arg)))) {
    return finding("require_approval", "floor.privilege-elevation", "Privilege elevation requires approval", segment.text, dialect);
  }
  if (["shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"].includes(executable)) {
    return finding("require_approval", "floor.system-power", "Destructive system power operations require approval", segment.text, dialect);
  }
  if (executable === "reg" && lower[0] === "delete") return finding("require_approval", "floor.registry-delete", "Registry deletion requires approval", segment.text, dialect);
  if (executable === "rm") {
    const flags = lower.filter((arg) => /^-/.test(arg)).join("");
    if (flags.includes("r") || lower.includes("--recursive")) return finding("require_approval", "floor.recursive-delete", "Recursive deletion requires approval", segment.text, dialect);
  }
  if (["rd", "rmdir", "del", "erase"].includes(executable) && lower.some((arg) => /^\/(?:[sqf](?:\/[sqf])*)$/.test(arg) || /^-[rf]+$/.test(arg))) {
    return finding("require_approval", "floor.windows-recursive-delete", "Recursive or forced deletion requires approval", segment.text, dialect);
  }
  if (["remove-item", "ri", "del", "erase", "rmdir"].includes(executable) && lower.some((arg) => /^-(?:recurse|r|force)$/.test(arg))) {
    return finding("require_approval", "floor.powershell-recursive-delete", "Recursive or forced deletion requires approval", segment.text, dialect);
  }
  if (executable === "git") {
    if (lower[0] === "push" && lower.some((arg) => arg === "-f" || arg === "--force" || arg.startsWith("--force-with-lease"))) {
      return finding("require_approval", "floor.git-force-push", "Force pushing requires approval", segment.text, dialect);
    }
    if (lower[0] === "reset" && lower.includes("--hard")) return finding("require_approval", "floor.git-hard-reset", "Hard reset requires approval", segment.text, dialect);
    if (lower[0] === "clean" && lower.some((arg) => /^-[^-]*[fdx]/.test(arg))) return finding("require_approval", "floor.git-clean", "Destructive git clean requires approval", segment.text, dialect);
  }
  if (["mysql", "psql", "sqlite3", "sqlcmd", "invoke-sqlcmd"].includes(executable)) {
    const query = args.join(" ");
    if (/\b(?:drop\s+(?:database|schema|table)|truncate\s+table|delete\s+from\b(?![^;]*\bwhere\b))/.test(query.toLowerCase())) {
      return finding("require_approval", "floor.destructive-sql", "Destructive SQL requires approval", segment.text, dialect);
    }
  }
  if (["invoke-expression", "iex", "eval"].includes(executable)) {
    return finding("require_approval", "floor.dynamic-execution", "Dynamic executable text requires approval", segment.text, dialect);
  }
  return null;
}

function nestedShellPayload(tokens) {
  if (!tokens.length) return null;
  const executable = executableName(tokens[0]);
  if (["sh", "bash", "zsh", "dash", "cmd", "powershell", "pwsh"].includes(executable)) {
    const encodedIndex = tokens.findIndex((token) => /^-(?:e|en|enc|enco|encod|encode|encodedcommand)$/i.test(token));
    if (["powershell", "pwsh"].includes(executable) && encodedIndex >= 0) {
      const encoded = tokens[encodedIndex + 1];
      if (!encoded) return { ambiguous: true };
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf16le");
        if (!decoded.trim() || /\uFFFD/.test(decoded)) return { ambiguous: true };
        return { command: decoded, dialect: "powershell" };
      } catch { return { ambiguous: true }; }
    }
    const flagIndex = tokens.findIndex((token) => /^(?:-c|\/c|-command)$/i.test(token));
    if (flagIndex >= 0) {
      if (!tokens[flagIndex + 1]) return { ambiguous: true };
      return { command: tokens.slice(flagIndex + 1).join(" "), dialect: executable === "cmd" ? "cmd" : ["powershell", "pwsh"].includes(executable) ? "powershell" : "posix" };
    }
  }
  return null;
}

function scanCommand(command, dialect = process.platform === "win32" ? "cmd" : "posix", depth = 0) {
  if (depth > 4) return finding("require_approval", "floor.nested-depth", "Nested shell depth is ambiguous", command, dialect);
  const substitutions = extractSubstitutions(command, dialect);
  if (substitutions.ambiguous) return finding("require_approval", "floor.ambiguous", "Executable substitution could not be parsed", command, dialect);
  for (const nested of substitutions.found) {
    const match = scanCommand(nested, dialect, depth + 1);
    if (match) return match;
  }

  const split = splitExecutableSegments(command, dialect);
  if (split.ambiguous) return finding("require_approval", "floor.ambiguous", "Command quoting could not be parsed safely", command, dialect);
  for (let index = 0; index < split.segments.length; index++) {
    const segment = split.segments[index];
    const parsed = tokenize(segment.text, dialect);
    if (parsed.ambiguous) return finding("require_approval", "floor.ambiguous", "Command quoting could not be parsed safely", segment.text, dialect);
    const nested = nestedShellPayload(parsed.tokens);
    if (nested?.ambiguous) return finding("require_approval", "floor.encoded-command", "Encoded command could not be decoded safely", segment.text, dialect);
    if (nested?.command) {
      const nestedFinding = scanCommand(nested.command, nested.dialect, depth + 1);
      if (nestedFinding) return nestedFinding;
    }
    const current = scanSegment(segment, dialect);
    if (current) return current;
    if (segment.pipeline && index > 0) {
      const previousExecutable = executableName(tokenize(split.segments[index - 1].text, dialect).tokens[0]);
      const currentExecutable = executableName(parsed.tokens[0]);
      if (["curl", "wget", "invoke-webrequest", "iwr"].includes(previousExecutable) && ["sh", "bash", "zsh", "powershell", "pwsh", "cmd"].includes(currentExecutable)) {
        return finding("require_approval", "floor.pipe-to-shell", "Piping downloaded content to a shell requires approval", `${split.segments[index - 1].text} | ${segment.text}`, dialect);
      }
    }
  }
  return null;
}

class PolicyEvaluator {
  constructor({ redactor = new Redactor(), toolRisk = TOOL_RISK } = {}) {
    this.redactor = redactor;
    this.toolRisk = toolRisk;
  }

  evaluate({ tool, input = {}, dialect, trustMode = "ask-first", repositoryRules = [], userRules = [], projectRules = [] }) {
    const selectedDialect = dialect || input.dialect || (process.platform === "win32" ? "cmd" : "posix");
    const command = tool === "Shell.execute" ? String(input.command || "") : `${tool} ${JSON.stringify(input)}`;
    const floor = tool === "Shell.execute" ? scanCommand(command, selectedDialect) : null;
    if (floor) return this._redactFinding(floor);

    const matches = [];
    const layers = [
      ["repository", repositoryRules, true],
      ["user", userRules, false],
      ["project", projectRules, false],
    ];
    for (const [source, rules, repository] of layers) {
      for (const rawRule of rules || []) {
        const rule = validatePolicyRule(rawRule, { repository });
        if (rule.dialect !== "any" && rule.dialect !== selectedDialect) continue;
        const match = rule.regex.exec(command);
        if (match) matches.push({ decision: rule.decision, ruleId: rule.id, source, dialect: selectedDialect, reason: rule.reason, matchedText: match[0] });
      }
    }
    const chosen = matches.find((item) => item.decision === "deny") || matches.find((item) => item.decision === "require_approval");
    if (chosen) return this._redactFinding(chosen);

    const risk = this.toolRisk[tool] || "write";
    if (risk === "dangerous") return this._redactFinding({ decision: "require_approval", ruleId: "tool.inherently-dangerous", source: "tool-risk", dialect: selectedDialect, reason: `${tool} is inherently dangerous`, matchedText: tool });
    const explicitAllow = matches.find((item) => item.decision === "allow");
    if (explicitAllow && risk === "write") return this._redactFinding(explicitAllow);
    if (trustMode === "suggest-only") return this._redactFinding({ decision: "require_approval", ruleId: "trust.suggest-only", source: "trust", dialect: selectedDialect, reason: "Suggest-only mode requires approval for every action", matchedText: tool });
    if (trustMode === "ask-first" && risk === "write") return this._redactFinding({ decision: "require_approval", ruleId: "trust.write", source: "trust", dialect: selectedDialect, reason: "Write actions require approval in ask-first mode", matchedText: tool });
    return this._redactFinding({ decision: "allow", ruleId: explicitAllow?.ruleId || "trust.allowed", source: explicitAllow?.source || "trust", dialect: selectedDialect, reason: explicitAllow?.reason || "Allowed by tool risk and project trust", matchedText: explicitAllow?.matchedText || tool });
  }

  _redactFinding(result) {
    return { ...result, matchedText: this.redactor.redactString(result.matchedText || "", { maxString: 500 }) };
  }
}

module.exports = {
  PolicyEvaluator,
  TOOL_RISK,
  policyRevision,
  scanCommand,
  validatePolicyRule,
  validateSafeRegex,
};
