/**
 * Tab layout — Connections and Settings tabs.
 */

import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "../_layout";
import { StatusDot } from "../../components/StatusDot";
import { View, StyleSheet } from "react-native";

export default function TabLayout() {
  const { theme, aggregateStatus } = useApp();

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: theme.bgSolid,
          borderTopColor: theme.border,
        },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        headerStyle: { backgroundColor: theme.bgSolid },
        headerTintColor: theme.text,
        headerTitleStyle: { fontFamily: "monospace", fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Connections",
          tabBarIcon: ({ color, size }) => (
            <View style={styles.iconContainer}>
              <Ionicons name="terminal-outline" size={size} color={color} />
              {aggregateStatus.state !== "idle" && (
                <View style={styles.badgeDot}>
                  <StatusDot state={aggregateStatus.state} size={6} />
                </View>
              )}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconContainer: {
    position: "relative",
  },
  badgeDot: {
    position: "absolute",
    top: -2,
    right: -4,
  },
});
