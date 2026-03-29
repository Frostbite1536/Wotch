/**
 * Terminal screen — connects to VPS and shows live terminal output.
 * This is the core screen where you monitor and interact with Claude Code.
 */

import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../_layout";
import { StatusDot } from "../../components/StatusDot";
import { TerminalOutput } from "../../components/TerminalOutput";
import { QuickKeys } from "../../components/QuickKeys";
import { WebSocketTerminal } from "../../services/WebSocketTerminal";
import { ClaudeStatusDetector } from "../../services/ClaudeStatusDetector";
import * as Settings from "../../services/SettingsService";
import { ClaudeStatusInfo, IDLE_STATUS, STATUS_LABELS } from "../../constants/status";

export default function TerminalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme, profiles, connections, setConnections, setAggregateStatus } = useApp();
  const navigation = useNavigation();

  const profile = profiles.find((p) => p.id === id);
  const [output, setOutput] = useState("");
  const [inputText, setInputText] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<ClaudeStatusInfo>(IDLE_STATUS);
  const [error, setError] = useState<string | null>(null);

  const terminalRef = useRef<WebSocketTerminal | null>(null);
  const detectorRef = useRef<ClaudeStatusDetector | null>(null);

  // Set up navigation title
  useEffect(() => {
    navigation.setOptions({
      title: profile?.name || profile?.host || "Terminal",
      headerRight: () => (
        <View style={styles.headerRight}>
          <StatusDot state={status.state} size={10} />
        </View>
      ),
    });
  }, [profile, status.state]);

  // Set up status detector
  useEffect(() => {
    if (!id) return;
    const detector = new ClaudeStatusDetector();
    detector.addTab(id);
    detector.setCallback((aggregate, perTab) => {
      const tabStatus = perTab[id] || IDLE_STATUS;
      setStatus(tabStatus);
      setAggregateStatus(aggregate);

      // Update connections state
      setConnections((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          claudeState: tabStatus.state,
          claudeDescription: tabStatus.description,
        },
      }));
    });
    detectorRef.current = detector;

    return () => {
      detector.destroy();
      detectorRef.current = null;
    };
  }, [id]);

  // Connect to VPS
  const connect = useCallback(async () => {
    if (!id || !profile) return;

    setError(null);
    setOutput("");

    const config = await Settings.loadServerConfig(id);
    if (!config) {
      setError("No server configured. Long-press the connection and tap 'Server Setup' to configure.");
      return;
    }

    setOutput("\x1b[90m── Connecting to " + profile.host + "...\x1b[0m\r\n");

    setConnections((prev) => ({
      ...prev,
      [id]: { id, phase: "connecting", claudeState: "idle", claudeDescription: "" },
    }));

    const terminal = new WebSocketTerminal(config, {
      onData: (data) => {
        setOutput((prev) => {
          const next = prev + data;
          // Keep buffer reasonable
          return next.length > 50000 ? next.slice(-40000) : next;
        });
        detectorRef.current?.feed(id, data);
      },
      onConnected: () => {
        setIsConnected(true);
        setConnections((prev) => ({
          ...prev,
          [id]: { ...prev[id], phase: "connected" },
        }));
        setOutput((prev) => prev + "\x1b[32m── Connected ──\x1b[0m\r\n");
      },
      onDisconnected: (reason) => {
        setIsConnected(false);
        setConnections((prev) => ({
          ...prev,
          [id]: { ...prev[id], phase: "disconnected" },
        }));
        setOutput((prev) => prev + `\r\n\x1b[90m── Disconnected${reason ? ": " + reason : ""} ──\x1b[0m\r\n`);
      },
      onError: (err) => {
        setError(err);
        setConnections((prev) => ({
          ...prev,
          [id]: { ...prev[id], phase: "failed", failMessage: err },
        }));
      },
    });

    terminal.connect();
    terminalRef.current = terminal;
  }, [id, profile]);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => {
      terminalRef.current?.disconnect();
      terminalRef.current = null;
    };
  }, [connect]);

  const handleSend = (data: string) => {
    terminalRef.current?.write(data);
  };

  const handleSubmitInput = () => {
    if (inputText) {
      handleSend(inputText + "\n");
      setInputText("");
    }
  };

  if (!profile) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: theme.bgSolid }]}>
        <Text style={{ color: theme.text }}>Connection not found</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.bgSolid }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      {/* Status bar */}
      <View style={[styles.statusBar, { borderBottomColor: theme.border }]}>
        <StatusDot state={status.state} size={8} />
        <Text style={[styles.statusLabel, { color: theme.textDim }]}>
          {isConnected ? STATUS_LABELS[status.state] : "Disconnected"}
        </Text>
        {status.description ? (
          <Text style={[styles.statusDesc, { color: theme.textMuted }]} numberOfLines={1}>
            — {status.description}
          </Text>
        ) : null}
        <View style={{ flex: 1 }} />
        {isConnected ? (
          <TouchableOpacity onPress={() => {
            terminalRef.current?.disconnect();
            setIsConnected(false);
          }}>
            <Ionicons name="close-circle-outline" size={18} color={theme.textDim} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={connect}>
            <Ionicons name="refresh-outline" size={18} color={theme.accent} />
          </TouchableOpacity>
        )}
      </View>

      {/* Error banner */}
      {error && (
        <View style={[styles.errorBanner, { backgroundColor: "rgba(248, 113, 113, 0.1)" }]}>
          <Ionicons name="alert-circle" size={14} color="#f87171" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Terminal */}
      <TerminalOutput output={output} theme={theme} />

      {/* Quick keys */}
      <QuickKeys onSend={handleSend} theme={theme} />

      {/* Input bar */}
      <View style={[styles.inputBar, { borderTopColor: theme.border, backgroundColor: theme.bgSolid }]}>
        <TextInput
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
          value={inputText}
          onChangeText={setInputText}
          onSubmitEditing={handleSubmitInput}
          placeholder="Command..."
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          editable={isConnected}
        />
        <TouchableOpacity
          onPress={handleSubmitInput}
          disabled={!isConnected}
          style={[styles.sendButton, { backgroundColor: theme.accent, opacity: isConnected ? 1 : 0.4 }]}
        >
          <Ionicons name="return-down-back" size={18} color={theme.bgSolid} />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  headerRight: {
    marginRight: 4,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusLabel: {
    fontFamily: "monospace",
    fontSize: 12,
  },
  statusDesc: {
    fontFamily: "monospace",
    fontSize: 12,
    flex: 1,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: {
    color: "#f87171",
    fontSize: 12,
    flex: 1,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 8,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    fontFamily: "monospace",
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
});
