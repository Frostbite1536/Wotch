/**
 * Root layout — provides theme context and navigation structure.
 */

import React, { useState, useEffect, createContext, useContext } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { THEMES, WotchTheme, DEFAULT_THEME } from "../constants/themes";
import { ClaudeStatusInfo, IDLE_STATUS } from "../constants/status";
import { SSHProfile, ConnectionState } from "../constants/types";
import * as Settings from "../services/SettingsService";

// ── App Context ──
interface AppContextType {
  theme: WotchTheme;
  themeName: string;
  setThemeName: (name: string) => void;
  profiles: SSHProfile[];
  setProfiles: (profiles: SSHProfile[]) => void;
  connections: Record<string, ConnectionState>;
  setConnections: React.Dispatch<React.SetStateAction<Record<string, ConnectionState>>>;
  aggregateStatus: ClaudeStatusInfo;
  setAggregateStatus: (status: ClaudeStatusInfo) => void;
}

export const AppContext = createContext<AppContextType>({
  theme: THEMES.dark,
  themeName: "dark",
  setThemeName: () => {},
  profiles: [],
  setProfiles: () => {},
  connections: {},
  setConnections: () => {},
  aggregateStatus: IDLE_STATUS,
  setAggregateStatus: () => {},
});

export const useApp = () => useContext(AppContext);

export default function RootLayout() {
  const [themeName, setThemeNameState] = useState(DEFAULT_THEME);
  const [profiles, setProfilesState] = useState<SSHProfile[]>([]);
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [aggregateStatus, setAggregateStatus] = useState<ClaudeStatusInfo>(IDLE_STATUS);

  const theme = THEMES[themeName] || THEMES.dark;

  // Load persisted settings on mount
  useEffect(() => {
    (async () => {
      const [savedTheme, savedProfiles] = await Promise.all([
        Settings.loadTheme(),
        Settings.loadProfiles(),
      ]);
      setThemeNameState(savedTheme);
      setProfilesState(savedProfiles);
    })();
  }, []);

  const setThemeName = (name: string) => {
    setThemeNameState(name);
    Settings.saveTheme(name);
  };

  const setProfiles = (newProfiles: SSHProfile[]) => {
    setProfilesState(newProfiles);
    Settings.saveProfiles(newProfiles);
  };

  return (
    <AppContext.Provider
      value={{
        theme,
        themeName,
        setThemeName,
        profiles,
        setProfiles,
        connections,
        setConnections,
        aggregateStatus,
        setAggregateStatus,
      }}
    >
      <StatusBar style={themeName === "light" ? "dark" : "light"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.bgSolid },
          headerTintColor: theme.text,
          headerTitleStyle: { fontFamily: "monospace", fontWeight: "600" },
          contentStyle: { backgroundColor: theme.bgSolid },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="terminal/[id]"
          options={{
            title: "Terminal",
            presentation: "card",
          }}
        />
        <Stack.Screen
          name="profile/editor"
          options={{
            title: "Connection",
            presentation: "modal",
          }}
        />
        <Stack.Screen
          name="profile/server-setup"
          options={{
            title: "Server Setup",
            presentation: "modal",
          }}
        />
      </Stack>
    </AppContext.Provider>
  );
}
