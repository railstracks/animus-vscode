// client.ts — Animus daemon HTTP + WebSocket client

import WebSocket from 'ws';
import type { Agent, SessionSummary, SessionTurn, ConnectionConfig, Provider } from './types';

export class AnimusClient {
  private config: ConnectionConfig;
  private ws: WebSocket | null = null;
  private wsQueue: string[] = [];
  private wsOpenPromise: Promise<void> | null = null;

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

  // ---- Providers ----

  async listProviders(): Promise<{ default: string; providers: Provider[] }> {
    const data = await this.request<{ default_provider: string; providers: Provider[] }>('GET', '/api/v1/providers');
    return { default: data.default_provider ?? '', providers: data.providers ?? [] };
  }

  async listProviderModels(providerId: string): Promise<string[]> {
    const data = await this.request<{ models: string[] }>('GET', `/api/v1/providers/${providerId}/models`);
    return data.models ?? [];
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
    let wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws/chat';

    // Pass auth token as query param (more reliable than headers for WS upgrade)
    if (this.config.authToken) {
      wsUrl += '?token=' + encodeURIComponent(this.config.authToken);
    }

    console.log('[Animus] WS URL:', wsUrl.replace(/token=[^&]+/, 'token=***'));

    this.ws = new WebSocket(wsUrl);

    // Create a promise that resolves when WS is open
    this.wsOpenPromise = new Promise<void>((resolve) => {
      this.ws!.on('open', () => {
        console.log('[Animus] WS open, flushing', this.wsQueue.length, 'queued messages');
        // Flush queued messages
        for (const queued of this.wsQueue) {
          this.ws!.send(queued);
        }
        this.wsQueue = [];
        handlers.onOpen?.();
        resolve();
      });
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        handlers.onMessage?.(data);
      } catch (e) {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log('[Animus] WS close:', code, reason.toString());
      handlers.onClose?.();
    });

    this.ws.on('error', (err: Error) => {
      console.error('[Animus] WS error:', err.message);
      // Clear queue on connection error
      this.wsQueue = [];
      handlers.onError?.(err);
    });

    this.ws.on('unexpected-response', (resp: any) => {
      console.error('[Animus] WS unexpected-response:', resp.statusCode);
      handlers.onError?.(new Error(`WebSocket upgrade rejected: HTTP ${resp.statusCode}`));
    });

    return this.ws;
  }

  /**
   * Send a message to a session via the WebSocket.
   * If the WS isn't open yet, queues the message for when it opens.
   */
  sendWsMessage(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      // Queue until WS opens
      this.wsQueue.push(data);
    }
  }

  /**
   * Wait for the WebSocket to be open.
   */
  async waitForOpen(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.wsOpenPromise) await this.wsOpenPromise;
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
    this.wsQueue = [];
    this.wsOpenPromise = null;
  }
}
