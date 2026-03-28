/**
 * Quick-action key buttons for terminal input.
 * Provides Ctrl+C, Tab, arrow keys, and other common shortcuts
 * that are hard to type on a phone keyboard.
 */

import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { WotchTheme } from "../constants/themes";

interface QuickKeysProps {
  onSend: (data: string) => void;
  theme: WotchTheme;
}

const KEYS = [
  { label: "^C", data: "\x03", desc: "Ctrl+C (interrupt)" },
  { label: "^D", data: "\x04", desc: "Ctrl+D (EOF)" },
  { label: "^Z", data: "\x1a", desc: "Ctrl+Z (suspend)" },
  { label: "^L", data: "\x0c", desc: "Ctrl+L (clear)" },
  { label: "Tab", data: "\t", desc: "Tab (autocomplete)" },
  { label: "Esc", data: "\x1b", desc: "Escape" },
  { label: "↑", data: "\x1b[A", desc: "Up arrow" },
  { label: "↓", data: "\x1b[B", desc: "Down arrow" },
  { label: "←", data: "\x1b[D", desc: "Left arrow" },
  { label: "→", data: "\x1b[C", desc: "Right arrow" },
];

export function QuickKeys({ onSend, theme }: QuickKeysProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
      style={[styles.scroll, { borderTopColor: theme.border }]}
    >
      {KEYS.map((key) => (
        <TouchableOpacity
          key={key.label}
          onPress={() => onSend(key.data)}
          style={[styles.key, { backgroundColor: theme.accentDim }]}
          activeOpacity={0.6}
          accessibilityLabel={key.desc}
        >
          <Text style={[styles.keyLabel, { color: theme.text }]}>{key.label}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  key: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    minWidth: 36,
    alignItems: "center",
  },
  keyLabel: {
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: "600",
  },
});
