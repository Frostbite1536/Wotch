/**
 * Terminal output display — scrollable text view showing terminal data.
 *
 * This is a simplified terminal renderer. For a full xterm experience,
 * you could embed a WebView with xterm.js, but for monitoring Claude
 * status this text-based view is fast and lightweight.
 */

import React, { useRef, useEffect } from "react";
import { ScrollView, Text, StyleSheet, View } from "react-native";
import { WotchTheme } from "../constants/themes";

interface TerminalOutputProps {
  output: string;
  theme: WotchTheme;
}

export function TerminalOutput({ output, theme }: TerminalOutputProps) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    // Auto-scroll to bottom on new output
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [output]);

  // Strip ANSI codes for display (same regex as desktop stripAnsi)
  const cleanOutput = output
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
      ""
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  return (
    <View style={[styles.container, { backgroundColor: theme.termBg }]}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={true}
        indicatorStyle={theme.termBg === "#ffffff" ? "black" : "white"}
      >
        <Text
          style={[styles.text, { color: theme.termFg }]}
          selectable={true}
        >
          {cleanOutput || "\n  Connecting...\n"}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 8,
    paddingBottom: 20,
  },
  text: {
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 16,
  },
});
