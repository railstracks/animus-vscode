// client.ts — Animus daemon HTTP + WebSocket client

import WebSocket from 'ws';
import type { Agent, SessionSummary, SessionTurn, ConnectionConfig } from './types';

export class AnimusClient {
  private config: ConnectionConfig;
  private ws: WebSocket | null = null;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  updateConfig(config: ConnectionConfig): void {
    this.config = config;
  }

  private get baseUrl(): string {
    return this.config.daemonUrl;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.authToken) {
      h['Authorization'] = `Bearer ${this.config.authToken}`;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`API ${method} ${path}: ${resp.status} ${resp.statusText} — ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  // ---- Agents ----

  async listAgents(): Promise<Agent[]> {
    const data = await this.request<{ agents: Agent[] }>('GET', '/api/v1/agents');
    return data.agents ?? [];
  }

  // ---- Sessions ----

  async listSessions(): Promise<SessionSummary[]> {
    const data = await this.request<{ sessions: SessionSummary[] } | SessionSummary[]>('GET', '/api/v1/sessions');
    // Handle both response shapes
    if (Array.isArray(data)) return data;
    return data.sessions ?? [];
  }

  async getSessionHistory(sessionId: string): Promise<SessionTurn[]> {
    const data = await this.request<{ items: SessionTurn[] }>('GET', `/api/v1/sessions/${sessionId}/history?page=1&limit=200`);
    return data.items ?? [];
  }

  // ---- Messaging ----

  /**
   * Connect to the session WebSocket for streaming responses.
   * Returns the WebSocket instance for event handling.
   */
  connectWebSocket(
    handlers: {
      onOpen?: () => void;
      onMessage?: (data: any) => void;
      onClose?: () => void;
      onError?: (error: Error) => void;
    }
  ): WebSocket {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws/chat';

    const headers: Record<string, string> = {};
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    this.ws = new WebSocket(wsUrl, { headers });

    this.ws.on('open', () => {
      handlers.onOpen?.();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        handlers.onMessage?.(data);
      } catch (e) {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      handlers.onClose?.();
    });

    this.ws.on('error', (err: Error) => {
      handlers.onError?.(err);
    });

    return this.ws;
  }

  /**
   * Send a message to a session via the WebSocket.
   */
  sendWsMessage(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Send a user message to a session via the WebSocket.
   * The Animus WS protocol uses type: "message" (not "user_message").
   */
  sendUserMessage(sessionId: string, content: string, agentId?: string): void {
    this.sendWsMessage({
      type: 'message',
      session_id: sessionId,
      content,
      ...(agentId ? { agent_id: agentId } : {}),
    });
  }

  /**
   * Create a new session by sending a first message without a session_id.
   * The Animus WS protocol creates a session implicitly when no session_id is provided.
   * The server responds with a `context` event containing the new session_id.
   */
  sendNewSessionMessage(content: string, agentId?: string): void {
    this.sendWsMessage({
      type: 'message',
      content,
      ...(agentId ? { agent_id: agentId } : {}),
    });
  }

  /**
   * Request session list via the WebSocket.
   */
  requestSessionList(): void {
    this.sendWsMessage({ type: 'list_sessions' });
  }

  /**
   * Stop active generation.
   */
  stopGeneration(): void {
    this.sendWsMessage({ type: 'stop' });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
