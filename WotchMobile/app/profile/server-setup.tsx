/**
 * Server setup screen — configure the bridge server connection.
 * This is where users enter their VPS bridge server's WebSocket URL and auth token.
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../_layout";
import * as Settings from "../../services/SettingsService";
import { ServerConfig } from "../../constants/types";

export default function ServerSetupScreen() {
  const { theme, profiles } = useApp();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const profile = profiles.find((p) => p.id === id);

  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState("3456");
  const [token, setToken] = useState("");
  const [useTLS, setUseTLS] = useState(false);

  // Load existing config
  useEffect(() => {
    if (!id) return;
    (async () => {
      const config = await Settings.loadServerConfig(id);
      if (config) {
        setServerHost(config.host);
        setServerPort(String(config.port));
        setToken(config.token);
        setUseTLS(config.useTLS);
      } else if (profile) {
        // Default to the profile's SSH host
        setServerHost(profile.host);
      }
    })();
  }, [id]);

  const handleSave = async () => {
    const trimmedHost = serverHost.trim();
    if (!trimmedHost) {
      Alert.alert("Error", "Server host is required");
      return;
    }

    let portNum = parseInt(serverPort) || 3456;
    if (portNum < 1 || portNum > 65535) portNum = 3456;

    if (!token.trim()) {
      Alert.alert("Error", "Auth token is required for security");
      return;
    }

    const config: ServerConfig = {
      host: trimmedHost,
      port: portNum,
      token: token.trim(),
      useTLS,
    };

    await Settings.saveServerConfig(id!, config);
    Alert.alert("Saved", "Server configuration saved. You can now connect.");
    router.back();
  };

  if (!profile) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: theme.bgSolid }]}>
        <Text style={{ color: theme.text }}>Profile not found</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.bgSolid }]}
      keyboardDismissMode="on-drag"
    >
      {/* Instructions */}
      <View style={[styles.infoBox, { backgroundColor: theme.accentDim, borderColor: theme.border }]}>
        <Ionicons name="information-circle-outline" size={18} color={theme.accent} />
        <Text style={[styles.infoText, { color: theme.textDim }]}>
          The bridge server runs on your VPS and creates a WebSocket link to the terminal.
          Install it with the commands below, then enter the connection details here.
        </Text>
      </View>

      {/* Install instructions */}
      <Text style={[styles.sectionTitle, { color: theme.textDim }]}>INSTALL ON VPS</Text>
      <View style={[styles.codeBox, { backgroundColor: theme.accentDim, borderColor: theme.border }]}>
        <Text style={[styles.code, { color: theme.accent }]}>
          {"# Copy the server/ folder to your VPS, then:\ncd WotchMobile/server\nnpm install\n\n# Start with your chosen token:\nWOTCH_TOKEN=your-secret-token node index.js\n\n# Or use a random token (printed on startup):\nnode index.js"}
        </Text>
      </View>

      {/* Server config */}
      <Text style={[styles.sectionTitle, { color: theme.textDim }]}>BRIDGE SERVER</Text>
      <View style={[styles.fieldGroup, { borderColor: theme.border }]}>
        <View style={[styles.field, { borderBottomColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.textDim }]}>Host</Text>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={serverHost}
            onChangeText={setServerHost}
            placeholder={profile.host}
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
            value={serverPort}
            onChangeText={setServerPort}
            placeholder="3456"
            placeholderTextColor={theme.textMuted}
            keyboardType="number-pad"
          />
        </View>

        <View style={[styles.field, { borderBottomColor: theme.border }]}>
          <Text style={[styles.label, { color: theme.textDim }]}>Token</Text>
          <TextInput
            style={[styles.input, { color: theme.text }]}
            value={token}
            onChangeText={setToken}
            placeholder="your-secret-token"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        <View style={[styles.field]}>
          <Text style={[styles.label, { color: theme.textDim }]}>TLS</Text>
          <View style={styles.switchRow}>
            <Text style={[styles.switchLabel, { color: theme.textMuted }]}>
              {useTLS ? "wss://" : "ws://"}
            </Text>
            <Switch
              value={useTLS}
              onValueChange={setUseTLS}
              trackColor={{ false: theme.textMuted, true: theme.accent }}
            />
          </View>
        </View>
      </View>

      <Text style={[styles.helpText, { color: theme.textMuted }]}>
        The token must match what the bridge server was started with.
        It's stored encrypted on your device and never transmitted in plain text after auth.
      </Text>

      <TouchableOpacity
        style={[styles.saveButton, { backgroundColor: theme.accent }]}
        onPress={handleSave}
      >
        <Text style={[styles.saveButtonText, { color: theme.bgSolid }]}>Save Configuration</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  infoBox: {
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
  },
  codeBox: {
    padding: 14,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  code: {
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
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
    width: 60,
    fontSize: 14,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: "monospace",
    padding: 0,
  },
  switchRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  switchLabel: {
    fontFamily: "monospace",
    fontSize: 13,
  },
  helpText: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
    marginHorizontal: 4,
  },
  saveButton: {
    marginTop: 24,
    marginBottom: 48,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
