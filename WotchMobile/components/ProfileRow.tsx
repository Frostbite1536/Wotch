/**
 * Connection profile row for the connections list.
 * Shows status dot, profile name, host info, and connection state.
 */

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusDot } from "./StatusDot";
import { SSHProfile, ConnectionState } from "../constants/types";
import { WotchTheme } from "../constants/themes";
import type { ClaudeState } from "../constants/status";

interface ProfileRowProps {
  profile: SSHProfile;
  connection?: ConnectionState;
  theme: WotchTheme;
  onPress: () => void;
  onLongPress?: () => void;
}

export function ProfileRow({ profile, connection, theme, onPress, onLongPress }: ProfileRowProps) {
  const isConnected = connection?.phase === "connected";
  const claudeState: ClaudeState = connection?.claudeState || "idle";

  const displayName = profile.name || `${profile.username}@${profile.host}`;
  const subtitle = profile.name
    ? `${profile.username}@${profile.host}:${profile.port}`
    : `Port ${profile.port}`;

  return (
    <TouchableOpacity
      style={[styles.container, { borderBottomColor: theme.border }]}
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.7}
    >
      <StatusDot state={isConnected ? claudeState : "idle"} size={12} />

      <View style={styles.info}>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
          {displayName}
        </Text>
        <View style={styles.subtitleRow}>
          <Ionicons
            name={profile.authMethod === "key" ? "key-outline" : "lock-closed-outline"}
            size={10}
            color={theme.textDim}
          />
          <Text style={[styles.subtitle, { color: theme.textDim }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>

      <View style={styles.right}>
        {isConnected && connection?.claudeDescription ? (
          <Text style={[styles.status, { color: theme.textDim }]} numberOfLines={1}>
            {connection.claudeDescription}
          </Text>
        ) : isConnected ? (
          <Text style={[styles.connected, { color: theme.green }]}>Connected</Text>
        ) : connection?.phase === "connecting" ? (
          <Text style={[styles.status, { color: theme.accent }]}>Connecting...</Text>
        ) : null}
        <Ionicons name="chevron-forward" size={16} color={theme.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 16,
    fontWeight: "500",
  },
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "monospace",
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  status: {
    fontSize: 11,
    fontFamily: "monospace",
    maxWidth: 120,
  },
  connected: {
    fontSize: 11,
    fontWeight: "500",
  },
});
