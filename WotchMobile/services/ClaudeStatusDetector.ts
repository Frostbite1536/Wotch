/**
 * Claude Code status detector — near-verbatim port from desktop main.js
 * ClaudeStatusDetector class (lines 666-1015).
 *
 * Feeds raw terminal output through ANSI stripping and pattern matching
 * to detect Claude's current activity state. Same 6-state machine,
 * same patterns, same priority order.
 */

import {
  ClaudeState,
  ClaudeStatusInfo,
  STATE_PRIORITY,
  IDLE_STATUS,
} from "../constants/status";

interface TabState {
  state: ClaudeState;
  description: string;
  buffer: string;
  lastActivity: number;
  claudeActive: boolean;
  recentFiles: string[];
}

type StatusCallback = (aggregate: ClaudeStatusInfo, perTab: Record<string, ClaudeStatusInfo>) => void;

export class ClaudeStatusDetector {
  private tabs = new Map<string, TabState>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private onStatusChange: StatusCallback | null = null;

  constructor() {
    // Idle timeout check — matches desktop's 2s interval
    this.idleCheckTimer = setInterval(() => this.checkIdleTimeouts(), 2000);
  }

  destroy() {
    if (this.idleCheckTimer) clearInterval(this.idleCheckTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
  }

  setCallback(cb: StatusCallback) {
    this.onStatusChange = cb;
  }

  addTab(tabId: string) {
    this.tabs.set(tabId, {
      state: "idle",
      description: "",
      buffer: "",
      lastActivity: 0,
      claudeActive: false,
      recentFiles: [],
    });
  }

  removeTab(tabId: string) {
    this.tabs.delete(tabId);
  }

  // ── ANSI stripping — from main.js stripAnsi() ──
  private stripAnsi(str: string): string {
    return str
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
        ""
      )
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  }

  // ── Main feed method — from main.js feed() ──
  feed(tabId: string, rawData: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const clean = this.stripAnsi(rawData);
    tab.lastActivity = Date.now();

    // Rolling buffer, keep last ~2000 chars
    tab.buffer += clean;
    if (tab.buffer.length > 2000) {
      tab.buffer = tab.buffer.slice(-2000);
    }

    // ── Detect if Claude Code session is active ──
    if (!tab.claudeActive) {
      if (
        /claude\s/i.test(clean) ||
        /╭─/u.test(clean) ||
        /Claude Code/i.test(clean) ||
        /claude\.ai/i.test(clean)
      ) {
        tab.claudeActive = true;
      }
    }

    if (!tab.claudeActive) {
      tab.state = "idle";
      tab.description = "";
      this.scheduleBroadcast();
      return;
    }

    const prevState = tab.state;
    const prevDesc = tab.description;

    // Check for spinner characters (braille spinners)
    const hasSpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/u.test(rawData);

    // ── Pattern matching — same patterns and priority as desktop ──

    // 1. Error
    let matched = false;
    for (const re of PATTERNS.error) {
      const m = clean.match(re);
      if (m) {
        tab.state = "error";
        tab.description = this.extractDescription(m, clean, "Error");
        matched = true;
        break;
      }
    }

    // 2. Done
    if (!matched) {
      for (const re of PATTERNS.done) {
        const m = clean.match(re);
        if (m) {
          tab.state = "done";
          tab.description = this.extractDescription(m, clean, "Done");
          matched = true;
          break;
        }
      }
    }

    // 3. Waiting for user
    if (!matched) {
      for (const re of PATTERNS.waiting) {
        if (re.test(clean)) {
          tab.state = "waiting";
          tab.description = "Waiting for input";
          matched = true;
          break;
        }
      }
    }

    // 4. Tool use (file operations, commands)
    if (!matched) {
      for (const re of PATTERNS.toolUse) {
        const m = clean.match(re);
        if (m) {
          tab.state = "working";
          const target = (m[1] || "").trim();
          const shortTarget = target.includes("/") ? target.split("/").pop()! : target;
          tab.description = shortTarget ? `Working on ${shortTarget.slice(0, 40)}` : "Working...";
          if (shortTarget && !tab.recentFiles.includes(shortTarget)) {
            tab.recentFiles.push(shortTarget);
            if (tab.recentFiles.length > 5) tab.recentFiles.shift();
          }
          matched = true;
          break;
        }
      }
    }

    // 5. File paths (secondary working indicator)
    if (!matched) {
      for (const re of PATTERNS.filePaths) {
        const m = clean.match(re);
        if (m) {
          const fileName = m[1].split("/").pop()!;
          if (fileName && fileName.length > 2) {
            tab.state = "working";
            tab.description = `Touching ${fileName}`;
            if (!tab.recentFiles.includes(fileName)) {
              tab.recentFiles.push(fileName);
              if (tab.recentFiles.length > 5) tab.recentFiles.shift();
            }
          }
          matched = true;
          break;
        }
      }
    }

    // 6. Thinking / spinner
    if (!matched) {
      if (hasSpinner) {
        tab.state = "thinking";
        tab.description = tab.description || "Thinking...";
        matched = true;
      } else {
        for (const re of PATTERNS.thinking) {
          if (re.test(clean)) {
            tab.state = "thinking";
            tab.description = "Thinking...";
            matched = true;
            break;
          }
        }
      }
    }

    // 7. Shell prompt → idle
    if (!matched) {
      for (const re of PATTERNS.prompt) {
        if (re.test(clean)) {
          tab.state = "idle";
          tab.description = tab.claudeActive ? "Ready" : "";
          break;
        }
      }
    }

    // Richer descriptions for multi-file edits
    if (tab.state === "working" && tab.recentFiles.length > 1) {
      const count = tab.recentFiles.length;
      const latest = tab.recentFiles[tab.recentFiles.length - 1];
      tab.description = `Editing ${count} files (${latest})`;
    }

    if (tab.state !== prevState || tab.description !== prevDesc) {
      this.scheduleBroadcast();
    }
  }

  // ── extractDescription — from main.js ──
  private extractDescription(match: RegExpMatchArray, clean: string, fallback: string): string {
    if (match[1] && match[1].trim().length > 2) {
      return match[1].trim().slice(0, 50);
    }
    const words = clean.trim().split(/\s+/).slice(0, 8).join(" ");
    return words.length > 3 ? words.slice(0, 50) : fallback;
  }

  // ── Aggregate status — from main.js getAggregateStatus() ─��
  getAggregateStatus(): ClaudeStatusInfo {
    let best: ClaudeStatusInfo = { ...IDLE_STATUS };
    let bestActivity = 0;

    for (const [, tab] of this.tabs) {
      const p = STATE_PRIORITY[tab.state] || 0;
      const bestP = STATE_PRIORITY[best.state] || 0;
      if (p > bestP || (p === bestP && tab.lastActivity > bestActivity)) {
        best = { state: tab.state, description: tab.description, lastActivity: tab.lastActivity };
        bestActivity = tab.lastActivity;
      }
    }

    return best;
  }

  getTabStatus(tabId: string): ClaudeStatusInfo {
    const tab = this.tabs.get(tabId);
    if (!tab) return { ...IDLE_STATUS };
    return { state: tab.state, description: tab.description, lastActivity: tab.lastActivity };
  }

  // ── Idle timeouts — from main.js idleCheckInterval ──
  private checkIdleTimeouts() {
    const now = Date.now();
    let changed = false;

    for (const [, tab] of this.tabs) {
      if ((tab.state === "thinking" || tab.state === "working") && now - tab.lastActivity > 5000) {
        tab.state = "idle";
        tab.description = "Ready";
        changed = true;
      }
      if (tab.state === "done" && now - tab.lastActivity > 8000) {
        tab.state = "idle";
        tab.description = "Ready";
        changed = true;
      }
      if (tab.state === "error" && now - tab.lastActivity > 10000) {
        tab.state = "idle";
        tab.description = "Ready";
        changed = true;
      }
    }

    if (changed) this.broadcastNow();
  }

  // ── Broadcast (debounced 150ms) — from main.js broadcast() ──
  private scheduleBroadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastNow();
    }, 150);
  }

  private broadcastNow() {
    if (!this.onStatusChange) return;

    const perTab: Record<string, ClaudeStatusInfo> = {};
    for (const [tabId, tab] of this.tabs) {
      perTab[tabId] = { state: tab.state, description: tab.description, lastActivity: tab.lastActivity };
    }

    this.onStatusChange(this.getAggregateStatus(), perTab);
  }
}

// ── Pattern definitions — copied from main.js lines 716-790 ──

const PATTERNS = {
  error: [
    /[✗✘×]\s*(.{0,60})/u,
    /(?:Error|Failed|Failure)\b/i,
    /command failed/i,
    /permission denied/i,
    /not found/i,
  ],
  done: [
    /[✓✔]\s*(.{0,60})/u,
    /(?:Done|Complete|Finished|Success|Applied)\b/i,
    /changes applied/i,
    /wrote \d+ file/i,
    /updated \d+ file/i,
  ],
  waiting: [
    /\?\s*$/,
    /would you like/i,
    /do you want/i,
    /shall I/i,
    /should I/i,
    /choose|select|pick/i,
    /\(y\/n\)/i,
    /\[Y\/n\]/i,
    /approve|accept|reject|deny/i,
  ],
  toolUse: [
    /(?:Read|Reading)\s+(.{1,60})/i,
    /(?:Write|Writing)\s+(.{1,60})/i,
    /(?:Edit|Editing)\s+(.{1,60})/i,
    /(?:Update|Updating)\s+(.{1,60})/i,
    /(?:Create|Creating)\s+(.{1,60})/i,
    /(?:Delete|Deleting)\s+(.{1,60})/i,
    /(?:Search|Searching)\s+(.{1,60})/i,
    /(?:Replace|Replacing)\s+(.{1,60})/i,
    /(?:Run|Running|Execute|Executing)\s+(.{1,60})/i,
    /(?:Install|Installing)\s+(.{1,60})/i,
    /(?:Compile|Compiling|Build|Building)\s+(.{1,60})/i,
    /(?:Test|Testing)\s+(.{1,60})/i,
  ],
  filePaths: [
    /([a-zA-Z0-9_\-/.]+\.(?:ts|js|py|rs|go|jsx|tsx|css|html|json|toml|yaml|yml|md|txt|c|cpp|h|java|rb|php|swift|kt|sh|sql))\b/,
  ],
  thinking: [
    /thinking/i,
    /processing/i,
    /analyzing/i,
    /understanding/i,
    /planning/i,
    /reasoning/i,
  ],
  prompt: [
    /[❯➜→▶$#%]\s*$/,
    /^\s*\$\s*$/m,
  ],
};
