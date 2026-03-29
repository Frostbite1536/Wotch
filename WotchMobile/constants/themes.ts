/**
 * Theme definitions — direct port from desktop renderer.js THEMES object.
 *
 * Each theme maps exactly to the desktop CSS variables:
 *   --bg, --bg-solid, --border, --accent, --accent-dim,
 *   --text, --text-dim, --text-muted, --green,
 *   termBg, termFg, termCursor
 */

export interface WotchTheme {
  name: string;
  bg: string;
  bgSolid: string;
  border: string;
  accent: string;
  accentDim: string;
  text: string;
  textDim: string;
  textMuted: string;
  green: string;
  termBg: string;
  termFg: string;
  termCursor: string;
}

// Copied verbatim from renderer.js lines 23-71
export const THEMES: Record<string, WotchTheme> = {
  dark: {
    name: "Dark",
    bg: "rgba(10, 10, 18, 0.97)",
    bgSolid: "#0a0a12",
    border: "rgba(148, 163, 184, 0.12)",
    accent: "#a78bfa",
    accentDim: "rgba(168, 139, 250, 0.15)",
    text: "#e2e8f0",
    textDim: "#64748b",
    textMuted: "#475569",
    green: "#34d399",
    termBg: "#0a0a12",
    termFg: "#e2e8f0",
    termCursor: "#a78bfa",
  },
  light: {
    name: "Light",
    bg: "rgba(255, 255, 255, 0.97)",
    bgSolid: "#ffffff",
    border: "rgba(100, 116, 139, 0.2)",
    accent: "#7c3aed",
    accentDim: "rgba(124, 58, 237, 0.1)",
    text: "#1e293b",
    textDim: "#64748b",
    textMuted: "#94a3b8",
    green: "#059669",
    termBg: "#ffffff",
    termFg: "#1e293b",
    termCursor: "#7c3aed",
  },
  purple: {
    name: "Purple",
    bg: "rgba(20, 10, 30, 0.97)",
    bgSolid: "#140a1e",
    border: "rgba(168, 139, 250, 0.15)",
    accent: "#c084fc",
    accentDim: "rgba(192, 132, 252, 0.15)",
    text: "#e2e8f0",
    textDim: "#a78bfa",
    textMuted: "#6d28d9",
    green: "#34d399",
    termBg: "#140a1e",
    termFg: "#e2e8f0",
    termCursor: "#c084fc",
  },
  green: {
    name: "Green",
    bg: "rgba(5, 15, 10, 0.97)",
    bgSolid: "#050f0a",
    border: "rgba(52, 211, 153, 0.15)",
    accent: "#34d399",
    accentDim: "rgba(52, 211, 153, 0.15)",
    text: "#d1fae5",
    textDim: "#6ee7b7",
    textMuted: "#065f46",
    green: "#34d399",
    termBg: "#050f0a",
    termFg: "#d1fae5",
    termCursor: "#34d399",
  },
};

export const DEFAULT_THEME = "dark";
export const THEME_KEYS = Object.keys(THEMES) as Array<keyof typeof THEMES>;
