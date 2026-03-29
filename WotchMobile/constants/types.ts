/**
 * Shared type definitions for the app.
 */

/** SSH connection profile — mirrors desktop's sshProfiles[] schema */
export interface SSHProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  /** Only used transiently for key-based auth; key stored in SecureStore */
  keyTag?: string;
}

/** Connection lifecycle phase */
export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "failed";

/** Runtime state for an active connection */
export interface ConnectionState {
  id: string; // matches SSHProfile.id
  phase: ConnectionPhase;
  failMessage?: string;
  claudeState: import("./status").ClaudeState;
  claudeDescription: string;
}

/** VPS bridge server config */
export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  useTLS: boolean;
}

/** Message format between app and VPS bridge server */
export interface BridgeMessage {
  type: "auth" | "data" | "resize" | "ping" | "pong" | "error" | "connected" | "closed";
  payload?: string;
  cols?: number;
  rows?: number;
  token?: string;
}
