/**
 * Profile editor — create or edit a VPS connection profile.
 * Mirrors the desktop SSH Profile Editor dialog.
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../_layout";
import * as Settings from "../../services/SettingsService";

export default function ProfileEditorScreen() {
  const { theme, profiles, setProfiles } = useApp();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();

  const existing = id ? profiles.find((p) => p.id === id) : null;

  const [name, setName] = useState(existing?.name || "");
  const [host, setHost] = useState(existing?.host || "");
  const [port, setPort] = useState(String(existing?.port || 22));
  const [username, setUsername] = useState(existing?.username || "");

  const isEditing = !!existing;

  const handleSave = async () => {
    const trimmedHost = host.trim();
    if (!trimmedHost) {
      Alert.alert("Error", "Host is required");
      return;
    }
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      Alert.alert("Error", "Username is required");
      return;
    }

    let portNum = parseInt(port) || 22;
    if (portNum < 1 || portNum > 65535) portNum = 22;

    const profile = {
      id: existing?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: name.trim(),
      host: trimmedHost,
      port: portNum,
      username: trimmedUsername,
      authMethod: "password" as const, // WebSocket bridge handles auth on VPS side
    };

    const updated = await Settings.saveProfile(profile);
    setProfiles(updated);
    router.back();
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.bgSolid }]}
      keyboardDismissMode="on-drag"
    >
      <Text style={[styles.sectionTitle, { color: theme.textDim }]}>CONNECTION</Text>

      <View style={[styles.fieldGroup, { borderColor: theme.border }]}>
        <View style={[styles.field, { borderBottomColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.textDim }]}>Name</Text>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={name}
            onChangeText={setName}
            placeholder="My VPS (optional)"
            placeholderTextColor={theme.textMuted}
          />
        </View>

        <View style={[styles.field, { borderBottomColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.textDim }]}>Host</Text>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={host}
            onChangeText={setHost}
            placeholder="192.168.1.100 or example.com"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>

        <View style={[styles.field, { borderBottomColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.textDim }]}>Port</Text>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={port}
            onChangeText={setPort}
            placeholder="22"
            placeholderTextColor={theme.textMuted}
            keyboardType="number-pad"
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.textDim }]}>Username</Text>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={username}
            onChangeText={setUsername}
            placeholder="root"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      <Text style={[styles.helpText, { color: theme.textMuted }]}>
        This is the SSH connection info for your VPS. The bridge server on your VPS handles
        the actual terminal session — the app connects to it via WebSocket.
      </Text>

      {/* Save button */}
      <TouchableOpacity
        style={[styles.saveButton, { backgroundColor: theme.accent }]}
        onPress={handleSave}
      >
        <Text style={[styles.saveButtonText, { color: theme.bgSolid }]}>
          {isEditing ? "Save Changes" : "Add Connection"}
        </Text>
      </TouchableOpacity>
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
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  fieldGroup: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: "hidden",
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  label: {
    width: 80,
    fontSize: 14,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: "monospace",
    padding: 0,
  },
  helpText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    marginHorizontal: 4,
  },
  saveButton: {
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
