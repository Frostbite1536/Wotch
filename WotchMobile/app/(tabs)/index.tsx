/**
 * Connections list — shows saved VPS profiles with status.
 * Main home screen of the app.
 */

import React from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../_layout";
import { ProfileRow } from "../../components/ProfileRow";
import { StatusDot } from "../../components/StatusDot";
import * as Settings from "../../services/SettingsService";

export default function ConnectionsScreen() {
  const { theme, profiles, setProfiles, connections, aggregateStatus } = useApp();
  const router = useRouter();

  const handleAdd = () => {
    router.push("/profile/editor");
  };

  const handlePress = (profileId: string) => {
    router.push(`/terminal/${profileId}`);
  };

  const handleLongPress = (profileId: string) => {
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return;

    Alert.alert(profile.name || profile.host, undefined, [
      {
        text: "Edit",
        onPress: () => router.push(`/profile/editor?id=${profileId}`),
      },
      {
        text: "Server Setup",
        onPress: () => router.push(`/profile/server-setup?id=${profileId}`),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          Alert.alert("Delete Connection", `Remove ${profile.name || profile.host}?`, [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: async () => {
                const updated = await Settings.deleteProfile(profileId);
                setProfiles(updated);
              },
            },
          ]);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bgSolid }]}>
      {/* Aggregate status bar — mini pill */}
      {aggregateStatus.state !== "idle" && (
        <View style={[styles.statusBar, { backgroundColor: theme.bgSolid, borderBottomColor: theme.border }]}>
          <StatusDot state={aggregateStatus.state} size={8} />
          <Text style={[styles.statusText, { color: theme.textDim }]}>
            {aggregateStatus.description || aggregateStatus.state}
          </Text>
        </View>
      )}

      {profiles.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="cloud-offline-outline" size={56} color={theme.textMuted} />
          <Text style={[styles.emptyTitle, { color: theme.text }]}>No Connections</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textDim }]}>
            Add your VPS to monitor Claude Code sessions remotely.
          </Text>
          <TouchableOpacity
            style={[styles.addButton, { backgroundColor: theme.accent }]}
            onPress={handleAdd}
          >
            <Text style={[styles.addButtonText, { color: theme.bgSolid }]}>Add Connection</Text>
          </TouchableOpacity>

          <View style={styles.helpBox}>
            <Text style={[styles.helpTitle, { color: theme.textDim }]}>How it works</Text>
            <Text style={[styles.helpText, { color: theme.textMuted }]}>
              1. Install the bridge server on your Ubuntu VPS{"\n"}
              2. Add your VPS connection here{"\n"}
              3. See Claude's status in real-time from your phone
            </Text>
          </View>
        </View>
      ) : (
        <FlatList
          data={profiles}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ProfileRow
              profile={item}
              connection={connections[item.id]}
              theme={theme}
              onPress={() => handlePress(item.id)}
              onLongPress={() => handleLongPress(item.id)}
            />
          )}
          contentContainerStyle={styles.list}
        />
      )}

      {/* FAB for adding new connection */}
      {profiles.length > 0 && (
        <TouchableOpacity
          style={[styles.fab, { backgroundColor: theme.accent }]}
          onPress={handleAdd}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={28} color={theme.bgSolid} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusText: {
    fontFamily: "monospace",
    fontSize: 12,
  },
  list: {
    paddingBottom: 80,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
    marginTop: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  addButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  addButtonText: {
    fontSize: 15,
    fontWeight: "600",
  },
  helpBox: {
    marginTop: 32,
    padding: 16,
    borderRadius: 8,
    width: "100%",
    gap: 8,
  },
  helpTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  helpText: {
    fontSize: 12,
    lineHeight: 20,
    fontFamily: "monospace",
  },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
});
