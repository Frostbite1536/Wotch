/**
 * Settings screen — theme picker and app info.
 * Mirrors the desktop settings panel.
 */

import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../_layout";
import { THEMES, THEME_KEYS } from "../../constants/themes";

export default function SettingsScreen() {
  const { theme, themeName, setThemeName } = useApp();

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.bgSolid }]}>
      {/* Appearance */}
      <Text style={[styles.sectionTitle, { color: theme.textDim }]}>APPEARANCE</Text>
      <View style={[styles.section, { borderColor: theme.border }]}>
        {THEME_KEYS.map((key) => {
          const t = THEMES[key];
          const isActive = key === themeName;
          return (
            <TouchableOpacity
              key={key}
              style={[
                styles.themeRow,
                { borderBottomColor: theme.border },
                isActive && { backgroundColor: theme.accentDim },
              ]}
              onPress={() => setThemeName(key)}
            >
              <View style={styles.swatchRow}>
                <View style={[styles.swatch, { backgroundColor: t.bgSolid, borderColor: t.border }]} />
                <View style={[styles.swatch, { backgroundColor: t.accent }]} />
                <View style={[styles.swatch, { backgroundColor: t.green }]} />
              </View>
              <Text style={[styles.themeName, { color: theme.text }]}>{t.name}</Text>
              {isActive && (
                <Ionicons name="checkmark" size={18} color={theme.accent} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Setup Guide */}
      <Text style={[styles.sectionTitle, { color: theme.textDim }]}>VPS BRIDGE SERVER</Text>
      <View style={[styles.section, { borderColor: theme.border }]}>
        <View style={styles.guideRow}>
          <Text style={[styles.guideText, { color: theme.text }]}>
            The bridge server runs on your Ubuntu VPS and connects your phone to Claude Code via WebSocket.
          </Text>
        </View>
        <View style={[styles.guideRow, { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
          <Text style={[styles.codeBlock, { color: theme.accent, backgroundColor: theme.accentDim }]}>
            {"# On your VPS:\ncd WotchMobile/server\nnpm install\nnode index.js"}
          </Text>
        </View>
      </View>

      {/* About */}
      <Text style={[styles.sectionTitle, { color: theme.textDim }]}>ABOUT</Text>
      <View style={[styles.section, { borderColor: theme.border }]}>
        <View style={[styles.aboutRow, { borderBottomColor: theme.border }]}>
          <Text style={[styles.aboutLabel, { color: theme.text }]}>Wotch Mobile</Text>
          <Text style={[styles.aboutValue, { color: theme.textDim }]}>0.1.0</Text>
        </View>
        <View style={styles.aboutRow}>
          <Text style={[styles.aboutLabel, { color: theme.text }]}>Platform</Text>
          <Text style={[styles.aboutValue, { color: theme.textDim }]}>Expo + React Native</Text>
        </View>
      </View>

      <Text style={[styles.footer, { color: theme.textMuted }]}>
        Companion app for Wotch Desktop.{"\n"}
        Monitor Claude Code sessions from your iPhone.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
  },
  section: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: "hidden",
  },
  themeRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  swatchRow: {
    flexDirection: "row",
    gap: 3,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "transparent",
  },
  themeName: {
    flex: 1,
    fontSize: 15,
  },
  guideRow: {
    padding: 14,
  },
  guideText: {
    fontSize: 13,
    lineHeight: 18,
  },
  codeBlock: {
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
    padding: 10,
    borderRadius: 6,
    overflow: "hidden",
  },
  aboutRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  aboutLabel: {
    fontSize: 15,
  },
  aboutValue: {
    fontSize: 15,
  },
  footer: {
    fontSize: 12,
    textAlign: "center",
    marginTop: 32,
    marginBottom: 48,
    lineHeight: 18,
  },
});
