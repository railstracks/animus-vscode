// chatPanel.ts — Webview panel for chat interface

import * as vscode from 'vscode';
import { AnimusClient } from './client';
import type { SessionTurn, ChatMessage, Attachment } from './types';

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private static readonly viewType = 'animusChat';

  private panel: vscode.WebviewPanel;
  private client: AnimusClient;
  private sessionId: string;
  private daemonUrl: string;
  private messages: ChatMessage[] = [];
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(
    extensionUri: vscode.Uri,
    client: AnimusClient,
    sessionId: string,
    sessionTitle: string
  ): ChatPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal(column);
      ChatPanel.currentPanel.switchSession(sessionId, sessionTitle);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      `Animus: ${sessionTitle}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri, client, sessionId, sessionTitle);
    return ChatPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    client: AnimusClient,
    sessionId: string,
    sessionTitle: string
  ) {
    this.panel = panel;
    this.client = client;
    this.sessionId = sessionId;

    this.panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.daemonUrl = (client as any)['config']?.daemonUrl || 'http://localhost:8080';
    this.panel.webview.html = this.getHtml(sessionTitle);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      message => this.handleWebviewMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Connect WebSocket
    this.connectWs();

    // Load history
    this.loadHistory();
  }

  public switchSession(sessionId: string, title: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.messages = [];
    this.panel.title = `Animus: ${title}`;
    this.panel.webview.html = this.getHtml(title);
    this.connectWs();
    this.loadHistory();
  }

  public sendNewSessionMessage(content: string, agentId?: string): void {
    // Add user message locally
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now(),
      streaming: false,
    };
    this.messages.push(userMsg);
    this.postMessage({ type: 'user_message', message: userMsg });
    // Send without session_id — server creates a new session
    this.client.sendNewSessionMessage(content, agentId);
  }

  private connectWs(): void {
    this.client.connectWebSocket({
      onOpen: () => {
        this.postMessage({ type: 'ws_open' });
      },
      onMessage: (data) => {
        this.handleWsEvent(data);
      },
      onClose: () => {
        this.postMessage({ type: 'ws_close' });
      },
      onError: (err) => {
        this.postMessage({ type: 'ws_error', message: err.message });
      },
    });
  }

  private async loadHistory(): Promise<void> {
    try {
      const turns = await this.client.getSessionHistory(this.sessionId);
      // Convert turns to chat messages (reverse to chronological order)
      const chronological = turns.slice().reverse();
      for (const turn of chronological) {
        this.addTurnToMessages(turn);
      }
      this.postMessage({ type: 'history', messages: this.messages });
    } catch (e) {
      this.postMessage({ type: 'error', message: `Failed to load history: ${(e as Error).message}` });
    }
  }

  private addTurnToMessages(turn: SessionTurn): void {
    if (turn.is_summary) return; // Skip compaction summaries in chat

    if (turn.role === 'assistant' && turn.tool_calls && turn.tool_calls.length > 0) {
      // Emit assistant text (if any) then tool calls
      if (turn.content) {
        this.messages.push({
          id: `turn-${turn.turn_id}`,
          role: 'assistant',
          content: turn.content,
          timestamp: turn.unix_ms,
          streaming: false,
          thinking: turn.thinking_content,
        });
      }
      for (const tc of turn.tool_calls) {
        this.messages.push({
          id: `turn-${turn.turn_id}-tc-${tc.id}`,
          role: 'tool_call',
          content: tc.arguments,
          timestamp: turn.unix_ms,
          streaming: false,
          toolName: tc.name,
        });
      }
    } else if (turn.role === 'tool') {
      this.messages.push({
        id: `turn-${turn.turn_id}`,
        role: 'tool',
        content: turn.content,
        timestamp: turn.unix_ms,
        streaming: false,
        toolName: turn.tool_name,
      });
    } else if (turn.content) {
      this.messages.push({
        id: `turn-${turn.turn_id}`,
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: turn.content,
        timestamp: turn.unix_ms,
        streaming: false,
        thinking: turn.thinking_content,
      });
    }

    // Attachments
    if (turn.attachments && turn.attachments.length > 0) {
      this.messages.push({
        id: `turn-${turn.turn_id}-att`,
        role: 'assistant',
        content: '',
        timestamp: turn.unix_ms,
        streaming: false,
        attachments: turn.attachments,
      });
    }
  }

  private handleWsEvent(data: any): void {
    const type = data.type;

    if (type === 'context') {
      // Server sends context event when a session is bound (including new sessions)
      if (data.session_id) {
        this.sessionId = data.session_id;
      }
      // Context layers may follow but we don't need to render them
    } else if (type === 'text') {
      this.postMessage({ type: 'stream_text', content: data.content });
    } else if (type === 'thinking') {
      this.postMessage({ type: 'stream_thinking', content: data.content });
    } else if (type === 'tool_call') {
      this.postMessage({
        type: 'tool_call',
        tool_call_id: data.tool_call_id,
        tool_name: data.tool_name,
        arguments: data.arguments,
      });
    } else if (type === 'tool_result') {
      this.postMessage({
        type: 'tool_result',
        tool_call_id: data.tool_call_id,
        tool_name: data.tool_name,
        success: data.success,
        content: data.content,
      });
    } else if (type === 'attachment') {
      this.postMessage({
        type: 'attachment',
        attachment: data.attachment,
      });
    } else if (type === 'done') {
      this.postMessage({ type: 'stream_done', interrupted: data.interrupted });
    } else if (type === 'error') {
      this.postMessage({ type: 'ws_error', message: data.message || 'Unknown server error' });
    } else if (type === 'sessions') {
      // Response to list_sessions request
      this.postMessage({ type: 'sessions_list', sessions: data.sessions });
    }
  }

  private async handleWebviewMessage(message: any): Promise<void> {
    if (message.type === 'send') {
      // Add user message to local list
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: message.content,
        timestamp: Date.now(),
        streaming: false,
      };
      this.messages.push(userMsg);
      this.postMessage({ type: 'user_message', message: userMsg });
      // If session is still pending, send without session_id to create one
      if (this.sessionId.startsWith('pending-')) {
        this.client.sendNewSessionMessage(message.content);
      } else {
        this.client.sendUserMessage(this.sessionId, message.content);
      }
    }
  }

  private postMessage(message: any): void {
    this.panel.webview.postMessage(message);
  }

  private getHtml(title: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Animus: ${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    .message {
      margin-bottom: 12px;
      max-width: 90%;
    }
    .message.user {
      margin-left: auto;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      padding: 8px 12px;
      border-radius: 8px;
    }
    .message.assistant {
      background: var(--vscode-textBlockQuote-background, #2a2a2a);
      padding: 8px 12px;
      border-radius: 8px;
    }
    .message.tool, .message.tool_call {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      background: var(--vscode-textCodeBlock-background, #2d2d30);
      padding: 0;
      border-radius: 4px;
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      overflow: hidden;
    }
    .message .role-label {
      font-size: 0.75em;
      opacity: 0.6;
      margin-bottom: 4px;
    }
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      padding: 6px 10px;
      user-select: none;
      font-size: 0.85em;
      opacity: 0.8;
    }
    .collapsible-header:hover {
      opacity: 1;
    }
    .collapsible-header .chevron {
      transition: transform 0.15s;
      font-size: 0.7em;
    }
    .collapsible-header.collapsed .chevron {
      transform: rotate(-90deg);
    }
    .collapsible-content {
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
      max-height: 300px;
      overflow-y: auto;
    }
    .collapsible-content.collapsed {
      display: none;
    }
    .message .thinking {
      font-size: 0.85em;
      opacity: 0.7;
      font-style: italic;
      margin-top: 4px;
      border-left: 2px solid var(--vscode-textLink-foreground, #3794ff);
      padding-left: 8px;
    }
    .attachment {
      margin-top: 8px;
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      border-radius: 6px;
      overflow: hidden;
      max-width: 400px;
    }
    .attachment img {
      max-width: 100%;
      max-height: 300px;
      object-fit: contain;
      display: block;
    }
    .attachment .meta {
      padding: 4px 8px;
      font-size: 0.8em;
      opacity: 0.7;
    }
    #input-area {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
    }
    #input {
      flex: 1;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #d4d4d4);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 8px 12px;
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 36px;
      max-height: 120px;
    }
    #send-btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
    }
    #send-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    #status {
      padding: 4px 12px;
      font-size: 0.75em;
      opacity: 0.6;
      border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
    }
    .streaming-cursor::after {
      content: '▋';
      animation: blink 1s infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
  </style>
</head>
<body>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" placeholder="Send a message..." rows="1"></textarea>
    <button id="send-btn">Send</button>
  </div>
  <div id="status">Ready</div>

  <script>
    const vscode = acquireVsCodeApi();
    const DAEMON_URL = '${this.daemonUrl}';
    const SESSION_ID = '${this.sessionId}';
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('send-btn');
    const statusEl = document.getElementById('status');

    let currentAssistantEl = null;
    let streaming = false;

    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', sendMessage);

    function sendMessage() {
      const content = inputEl.value.trim();
      if (!content || streaming) return;
      vscode.postMessage({ type: 'send', content });
      inputEl.value = '';
      inputEl.style.height = 'auto';
    }

    function appendMessage(msg) {
      const el = document.createElement('div');
      el.className = 'message ' + msg.role;
      el.id = msg.id;

      const isTool = msg.role === 'tool_call' || msg.role === 'tool';

      if (isTool) {
        // Collapsible tool block
        const header = document.createElement('div');
        header.className = 'collapsible-header';
        const chevron = document.createElement('span');
        chevron.className = 'chevron';
        chevron.textContent = '▼';
        const label = document.createElement('span');
        label.textContent = msg.role === 'tool_call'
          ? '🔧 ' + (msg.toolName || 'tool')
          : '📋 ' + (msg.toolName || 'result');
        header.appendChild(chevron);
        header.appendChild(label);
        el.appendChild(header);

        const contentEl = document.createElement('div');
        contentEl.className = 'collapsible-content';
        contentEl.textContent = msg.content;
        el.appendChild(contentEl);

        header.addEventListener('click', () => {
          header.classList.toggle('collapsed');
          contentEl.classList.toggle('collapsed');
        });
      } else {
        const roleLabel = document.createElement('div');
        roleLabel.className = 'role-label';
        roleLabel.textContent = msg.role;
        el.appendChild(roleLabel);

        const contentEl = document.createElement('div');
        contentEl.className = 'content';
        contentEl.textContent = msg.content;
        el.appendChild(contentEl);

        if (msg.thinking) {
          const thinkEl = document.createElement('div');
          thinkEl.className = 'thinking';
          thinkEl.textContent = msg.thinking;
          el.appendChild(thinkEl);
        }
      }

      if (msg.attachments) {
        for (const att of msg.attachments) {
          el.appendChild(createAttachmentEl(att));
        }
      }

      messagesEl.appendChild(el);
      scrollBottom();
      return el;
    }

    function createAttachmentEl(att) {
      const el = document.createElement('div');
      el.className = 'attachment';

      if (att.mime_type && att.mime_type.startsWith('image/')) {
        const img = document.createElement('img');
        const base = DAEMON_URL + '/api/v1/sessions/' + SESSION_ID + '/attachments/' + att.id;
        img.src = att.access_token ? base + '?token=' + att.access_token : base;
        img.alt = att.filename;
        el.appendChild(img);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = att.filename + ' (' + formatSize(att.size_bytes) + ')';
      el.appendChild(meta);

      return el;
    }

    function formatSize(bytes) {
      if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
      if (bytes >= 1e3) return Math.round(bytes / 1e3) + ' KB';
      return bytes + ' B';
    }

    function scrollBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(text) {
      statusEl.textContent = text;
    }

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'history':
          messagesEl.innerHTML = '';
          currentAssistantEl = null;
          for (const m of msg.messages) {
            appendMessage(m);
          }
          scrollBottom();
          break;

        case 'user_message':
          appendMessage(msg.message);
          streaming = true;
          sendBtn.disabled = true;
          setStatus('Agent is thinking...');
          break;

        case 'stream_text':
          if (!currentAssistantEl) {
            currentAssistantEl = appendMessage({
              id: 'streaming-' + Date.now(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
            });
            currentAssistantEl.classList.add('streaming-cursor');
          }
          const contentEl = currentAssistantEl.querySelector('.content');
          contentEl.textContent += msg.content;
          scrollBottom();
          break;

        case 'stream_thinking':
          if (currentAssistantEl) {
            let thinkEl = currentAssistantEl.querySelector('.thinking');
            if (!thinkEl) {
              thinkEl = document.createElement('div');
              thinkEl.className = 'thinking';
              currentAssistantEl.appendChild(thinkEl);
            }
            thinkEl.textContent += msg.content;
          }
          break;

        case 'tool_call':
          // Finalize current streaming message
          if (currentAssistantEl) {
            currentAssistantEl.classList.remove('streaming-cursor');
            currentAssistantEl = null;
          }
          appendMessage({
            id: 'tc-' + msg.tool_call_id,
            role: 'tool_call',
            content: msg.arguments,
            timestamp: Date.now(),
            toolName: msg.tool_name,
          });
          break;

        case 'tool_result':
          appendMessage({
            id: 'tr-' + msg.tool_call_id,
            role: 'tool',
            content: msg.content,
            timestamp: Date.now(),
            toolName: msg.tool_name,
          });
          break;

        case 'attachment':
          if (currentAssistantEl) {
            currentAssistantEl.classList.remove('streaming-cursor');
            currentAssistantEl = null;
          }
          appendMessage({
            id: 'att-' + Date.now(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            attachments: [msg.attachment],
          });
          break;

        case 'stream_done':
          if (currentAssistantEl) {
            currentAssistantEl.classList.remove('streaming-cursor');
            currentAssistantEl = null;
          }
          streaming = false;
          sendBtn.disabled = false;
          setStatus(msg.interrupted ? 'Stopped' : 'Ready');
          break;

        case 'ws_open':
          setStatus('Connected');
          break;

        case 'ws_close':
          setStatus('Disconnected');
          break;

        case 'ws_error':
          setStatus('Error: ' + msg.message);
          break;

        case 'error':
          setStatus('Error: ' + msg.message);
          break;
      }
    });

    setStatus('Connecting...');
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    ChatPanel.currentPanel = undefined;
    this.client.disconnect();
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
