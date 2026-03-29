/**
 * Settings persistence — uses AsyncStorage for profiles/prefs
 * and SecureStore for sensitive data (server tokens).
 *
 * Mirrors the desktop's ~/.wotch/settings.json pattern.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { SSHProfile, ServerConfig } from "../constants/types";

const KEYS = {
  profiles: "wotch.profiles",
  theme: "wotch.theme",
  serverConfigs: "wotch.serverConfigs",
  lastServerId: "wotch.lastServerId",
  knownHosts: "wotch.knownHosts",
} as const;

// ── Profiles ──

export async function loadProfiles(): Promise<SSHProfile[]> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.profiles);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveProfiles(profiles: SSHProfile[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.profiles, JSON.stringify(profiles));
}

export async function saveProfile(profile: SSHProfile): Promise<SSHProfile[]> {
  const profiles = await loadProfiles();
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  await saveProfiles(profiles);
  return profiles;
}

export async function deleteProfile(profileId: string): Promise<SSHProfile[]> {
  const profiles = await loadProfiles();
  const filtered = profiles.filter((p) => p.id !== profileId);
  await saveProfiles(filtered);
  // Also delete any stored token for this profile
  await SecureStore.deleteItemAsync(`wotch.token.${profileId}`);
  return filtered;
}

// ── Theme ──

export async function loadTheme(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(KEYS.theme)) || "dark";
  } catch {
    return "dark";
  }
}

export async function saveTheme(theme: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.theme, theme);
}

// ── Server configs (host/port stored in AsyncStorage, token in SecureStore) ──

export async function loadServerConfig(profileId: string): Promise<ServerConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(`${KEYS.serverConfigs}.${profileId}`);
    if (!raw) return null;
    const config = JSON.parse(raw) as Omit<ServerConfig, "token"> & { token?: string };
    // Load token from SecureStore
    const token = await SecureStore.getItemAsync(`wotch.token.${profileId}`);
    return { ...config, token: token || "" } as ServerConfig;
  } catch {
    return null;
  }
}

export async function saveServerConfig(profileId: string, config: ServerConfig): Promise<void> {
  // Store token separately in SecureStore (encrypted)
  if (config.token) {
    await SecureStore.setItemAsync(`wotch.token.${profileId}`, config.token);
  }
  // Store non-sensitive parts in AsyncStorage
  const { token: _, ...rest } = config;
  await AsyncStorage.setItem(`${KEYS.serverConfigs}.${profileId}`, JSON.stringify(rest));
}

// ── Known hosts (fingerprints are public data, AsyncStorage is fine) ──

export async function loadKnownHosts(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.knownHosts);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveKnownHosts(hosts: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(KEYS.knownHosts, JSON.stringify(hosts));
}
