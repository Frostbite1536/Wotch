/**
 * Claude status state definitions — matches the desktop pill dot colors.
 *
 * Desktop CSS (index.html lines 63-92):
 *   idle/done:  #34d399 (green), no animation
 *   thinking:   accent (#a78bfa), pulse 1.5s
 *   working:    #60a5fa (blue), pulse 2s
 *   waiting:    #fbbf24 (yellow), pulse 3s
 *   error:      #f87171 (red), no animation
 */

export type ClaudeState = "idle" | "thinking" | "working" | "waiting" | "done" | "error";

export interface ClaudeStatusInfo {
  state: ClaudeState;
  description: string;
  lastActivity: number; // timestamp
}

// Priority order for aggregate status (highest first)
// From main.js getAggregateStatus()
export const STATE_PRIORITY: Record<ClaudeState, number> = {
  error: 6,
  working: 5,
  thinking: 4,
  waiting: 2,
  done: 1,
  idle: 0,
};

// Dot colors matching desktop CSS exactly
export const STATUS_COLORS: Record<ClaudeState, string> = {
  idle: "#34d399",
  thinking: "#a78bfa",
  working: "#60a5fa",
  waiting: "#fbbf24",
  done: "#34d399",
  error: "#f87171",
};

// Pulse duration in ms (0 = no pulse) — matches desktop CSS animation durations
export const STATUS_PULSE_MS: Record<ClaudeState, number> = {
  idle: 0,
  thinking: 1500,
  working: 2000,
  waiting: 3000,
  done: 0,
  error: 0,
};

// Human-readable labels
export const STATUS_LABELS: Record<ClaudeState, string> = {
  idle: "Ready",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for input",
  done: "Done",
  error: "Error",
};

export const IDLE_STATUS: ClaudeStatusInfo = {
  state: "idle",
  description: "",
  lastActivity: Date.now(),
};
