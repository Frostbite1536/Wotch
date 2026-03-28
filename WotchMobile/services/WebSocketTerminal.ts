/**
 * WebSocket terminal service — connects to the VPS bridge server.
 *
 * Architecture:
 *   Phone ←→ WebSocket ←→ VPS Bridge Server ←→ node-pty ←→ shell/claude
 *
 * The bridge server runs on your Ubuntu VPS alongside Claude Code.
 * This service manages the WebSocket connection, authentication,
 * and data flow.
 */

import { BridgeMessage, ServerConfig } from "../constants/types";

export type TerminalEventType = "data" | "connected" | "disconnected" | "error";

interface TerminalCallbacks {
  onData: (data: string) => void;
  onConnected: () => void;
  onDisconnected: (reason?: string) => void;
  onError: (error: string) => void;
}

export class WebSocketTerminal {
  private ws: WebSocket | null = null;
  private config: ServerConfig;
  private callbacks: TerminalCallbacks;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;

  constructor(config: ServerConfig, callbacks: TerminalCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  /** Connect to the VPS bridge server */
  connect() {
    this.shouldReconnect = true;
    this.doConnect();
  }

  private doConnect() {
    const protocol = this.config.useTLS ? "wss" : "ws";
    const url = `${protocol}://${this.config.host}:${this.config.port}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.callbacks.onError(`Failed to create WebSocket: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // Authenticate with token
      this.send({ type: "auth", token: this.config.token });

      // Start keepalive pings every 30s
      this.pingTimer = setInterval(() => {
        this.send({ type: "ping" });
      }, 30000);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: BridgeMessage = JSON.parse(event.data as string);

        switch (msg.type) {
          case "connected":
            this.callbacks.onConnected();
            break;
          case "data":
            if (msg.payload) {
              this.callbacks.onData(msg.payload);
            }
            break;
          case "error":
            this.callbacks.onError(msg.payload || "Unknown error");
            break;
          case "closed":
            this.callbacks.onDisconnected(msg.payload);
            break;
          case "pong":
            // Keepalive response, nothing to do
            break;
        }
      } catch {
        // Raw text data (fallback for simple bridge servers)
        if (typeof event.data === "string") {
          this.callbacks.onData(event.data);
        }
      }
    };

    this.ws.onerror = () => {
      this.callbacks.onError("WebSocket connection error");
    };

    this.ws.onclose = (event) => {
      this.cleanup();
      this.callbacks.onDisconnected(event.reason || "Connection closed");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  /** Send text to the remote terminal (user typing) */
  write(data: string) {
    this.send({ type: "data", payload: data });
  }

  /** Resize the remote PTY */
  resize(cols: number, rows: number) {
    this.send({ type: "resize", cols, rows });
  }

  /** Disconnect and stop reconnecting */
  disconnect() {
    this.shouldReconnect = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, "User disconnected");
      this.ws = null;
    }
  }

  /** Check if connected */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: BridgeMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private cleanup() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Auto-reconnect with 3s delay (matches desktop SSH reconnect timing) */
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.doConnect();
      }
    }, 3000);
  }
}
