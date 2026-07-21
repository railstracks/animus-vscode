// extension.ts — Main extension entry point (sidebar WebviewView)

import * as vscode from 'vscode';
import { AnimusClient } from './client';
import { getConfig, promptForConnection } from './config';
import type { ConnectionState, Agent, Provider, SessionSummary } from './types';

let client: AnimusClient | null = null;
let statusBarItem: vscode.StatusBarItem;
let pollInterval: NodeJS.Timeout | null = null;
let extContext: vscode.ExtensionContext;
let view: vscode.WebviewView | null = null;

let cachedAgents: Agent[] = [];
let cachedProviders: Provider[] = [];
let cachedDefaultProvider = '';

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'animus.connect';
  context.subscriptions.push(statusBarItem);
  updateStatusBar('disconnected');
  statusBarItem.show();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('animus-sessions', new AnimusViewProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('animus.connect', () => connect()),
    vscode.commands.registerCommand('animus.disconnect', () => disconnect()),
    vscode.commands.registerCommand('animus.configureConnection', () => configureConnection()),
  );

  const config = getConfig();
  if (config.daemonUrl && config.authToken) {
    connect();
  }
}

export function deactivate(): void {
  disconnect();
}

class AnimusViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    view = webviewView;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml();

    view.webview.onDidReceiveMessage(msg => handleWebviewMessage(msg));

    // If already connected, push data to view
    if (client) {
      pushDataToView();
    }
  }
}

// ---- Connection Management ----

async function connect(): Promise<void> {
  let config = getConfig();

  if (!config.daemonUrl || !config.authToken) {
    const prompted = await promptForConnection();
    if (!prompted) return;
    config = prompted;
  }

  updateStatusBar('connecting');

  try {
    client = new AnimusClient(config);
    const agents = await client.listAgents();
    cachedAgents = agents.filter(a => a.id && a.id !== 'default');

    try {
      const providerData = await client.listProviders();
      cachedProviders = providerData.providers;
      cachedDefaultProvider = providerData.default;
    } catch {
      cachedProviders = [];
      cachedDefaultProvider = '';
    }

    startPolling();
    await refreshSessions();

    updateStatusBar('connected');
    vscode.window.showInformationMessage(
      `Animus: Connected (${agents.length} agent${agents.length !== 1 ? 's' : ''})`
    );
    pushDataToView();
  } catch (e) {
    updateStatusBar('disconnected');
    client = null;
    vscode.window.showErrorMessage(
      `Animus: Failed to connect — ${(e as Error).message}`
    );
  }
}

function disconnect(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (client) {
    client.disconnect();
    client = null;
  }
  cachedAgents = [];
  cachedProviders = [];
  cachedDefaultProvider = '';
  postToView({ type: 'disconnected' });
  updateStatusBar('disconnected');
}

function startPolling(): void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    refreshSessions().catch(() => {});
  }, 15000);
}

// ---- Data ----

async function refreshSessions(): Promise<void> {
  if (!client) return;

  try {
    const sessions = await client.listSessions();
    postToView({ type: 'sessions', sessions });
  } catch (e) {
    // Silent for polling
  }
}

function pushDataToView(): void {
  postToView({
    type: 'init',
    agents: cachedAgents,
    providers: cachedProviders,
    defaultProvider: cachedDefaultProvider,
  });
}

async function loadProviderModels(providerId: string): Promise<void> {
  if (!client) return;
  try {
    const models = await client.listProviderModels(providerId);
    postToView({ type: 'models', providerId, models });
  } catch {
    postToView({ type: 'models', providerId, models: [] });
  }
}

async function loadHistory(sessionId: string): Promise<void> {
  if (!client) return;
  try {
    const turns = await client.getSessionHistory(sessionId);
    postToView({ type: 'history', turns });
  } catch (e) {
    postToView({ type: 'error', message: `Failed to load history: ${(e as Error).message}` });
  }
}

// ---- WS event routing ----

let activeSessionId = '';

function connectWs(): void {
  if (!client) return;

  client.connectWebSocket({
    onOpen: () => {
      postToView({ type: 'ws_open' });
    },
    onMessage: (data) => {
      // Route WS events to the webview
      if (data.type === 'context' && data.session_id) {
        activeSessionId = data.session_id;
      }
      postToView(data);
    },
    onClose: () => {
      postToView({ type: 'ws_close' });
    },
    onError: (err) => {
      postToView({ type: 'ws_error', message: err.message });
    },
  });
}

// ---- Webview message handling ----

async function handleWebviewMessage(msg: any): Promise<void> {
  switch (msg.type) {
    case 'view_ready':
      if (client) {
        pushDataToView();
        connectWs();
        refreshSessions();
      }
      break;

    case 'send_message': {
      if (!client) return;
      const { content, agentId, provider, modelId, sessionId } = msg;

      if (!sessionId || sessionId === 'new') {
        // New session — send without session_id, tag as vscode
        client.sendWsMessage({
          type: 'message',
          content,
          source: 'vscode',
          ...(agentId ? { agent_id: agentId } : {}),
          ...(provider ? { provider } : {}),
          ...(modelId ? { model_id: modelId } : {}),
        });
      } else {
        client.sendWsMessage({
          type: 'message',
          session_id: sessionId,
          content,
          ...(provider ? { provider } : {}),
          ...(modelId ? { model_id: modelId } : {}),
        });
      }
      break;
    }

    case 'stop':
      client?.stopGeneration();
      break;

    case 'load_models':
      await loadProviderModels(msg.providerId);
      break;

    case 'load_history':
      await loadHistory(msg.sessionId);
      break;

    case 'refresh_sessions':
      await refreshSessions();
      break;
  }
}

// ---- Helpers ----

function postToView(msg: any): void {
  view?.webview.postMessage(msg);
}

// ---- Configuration ----

async function configureConnection(): Promise<void> {
  await promptForConnection();
  if (client) {
    disconnect();
    await connect();
  }
}

function updateStatusBar(state: ConnectionState): void {
  switch (state) {
    case 'connected':
      statusBarItem.text = '$(check) Animus';
      statusBarItem.tooltip = 'Animus: Connected';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'connecting':
      statusBarItem.text = '$(loading~spin) Animus';
      statusBarItem.tooltip = 'Animus: Connecting...';
      break;
    case 'disconnected':
      statusBarItem.text = '$(circle-slash) Animus';
      statusBarItem.tooltip = 'Animus: Click to connect';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      break;
  }
}

// ---- HTML ----

function getHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ---- Main View ---- */
    #main-view {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .section-label {
      font-size: 0.7em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.5;
      padding: 8px 12px 4px;
    }
    #new-session-form {
      padding: 4px 12px 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field-label {
      font-size: 0.7em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.5;
      margin-top: 4px;
    }
    .field-label:first-child { margin-top: 0; }
    select {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #d4d4d4);
      border: 1px solid var(--vscode-dropdown-border, #3c3c3c);
      padding: 3px 6px;
      border-radius: 3px;
      font-family: inherit;
      font-size: 0.85em;
      outline: none;
      width: 100%;
    }
    select:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    #message-input {
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #d4d4d4);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 6px 8px;
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 60px;
      max-height: 120px;
    }
    #message-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
      outline: none;
    }
    #send-btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.85em;
      align-self: flex-end;
    }
    #send-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    #send-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    /* ---- Session List ---- */
    #session-list-container {
      flex: 1;
      overflow-y: auto;
      padding: 0 4px 8px;
    }
    .session-item {
      padding: 8px 10px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .session-item:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .session-item .title {
      font-weight: 500;
      font-size: 0.9em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-item .meta {
      font-size: 0.75em;
      opacity: 0.6;
    }

    /* ---- Chat View ---- */
    #chat-view {
      display: none;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    #chat-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    }
    #back-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground, #d4d4d4);
      cursor: pointer;
      padding: 4px;
      font-size: 1.1em;
    }
    #back-btn:hover {
      opacity: 0.8;
    }
    #chat-title {
      font-size: 0.9em;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }
    .msg {
      margin-bottom: 10px;
      max-width: 95%;
    }
    .msg.user {
      margin-left: auto;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      padding: 6px 10px;
      border-radius: 8px;
    }
    .msg.assistant {
      background: var(--vscode-textBlockQuote-background, #2a2a2a);
      padding: 6px 10px;
      border-radius: 8px;
    }
    .msg.tool, .msg.tool_call {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      background: var(--vscode-textCodeBlock-background, #2d2d30);
      padding: 0;
      border-radius: 4px;
      border-left: 3px solid var(--vscode-textLink-foreground, #3794ff);
      overflow: hidden;
    }
    .msg .role-label {
      font-size: 0.7em;
      opacity: 0.5;
      margin-bottom: 2px;
    }
    .collapsible-header {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      padding: 4px 8px;
      user-select: none;
      font-size: 0.8em;
      opacity: 0.7;
    }
    .collapsible-header:hover { opacity: 1; }
    .collapsible-header .chevron { font-size: 0.7em; transition: transform 0.15s; }
    .collapsible-header.collapsed .chevron { transform: rotate(-90deg); }
    .collapsible-content {
      padding: 4px 8px;
      border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
      max-height: 200px;
      overflow-y: auto;
    }
    .collapsible-content.collapsed { display: none; }

    #chat-input-area {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
    }
    #chat-input {
      flex: 1;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #d4d4d4);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 6px 8px;
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.85em;
      resize: none;
      min-height: 32px;
      max-height: 100px;
    }
    #chat-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
      outline: none;
    }
    #chat-send {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.85em;
    }
    #chat-send:disabled { opacity: 0.5; cursor: default; }
    #chat-status {
      padding: 2px 12px;
      font-size: 0.7em;
      opacity: 0.5;
    }
    .streaming-cursor::after { content: '▋'; animation: blink 1s infinite; }
    @keyframes blink { 50% { opacity: 0; } }
  </style>
</head>
<body>

  <!-- Main View -->
  <div id="main-view">
    <div class="section-label">New Session</div>
    <div id="new-session-form">
      <label class="field-label" for="agent-select">Agent</label>
      <select id="agent-select"></select>
      <label class="field-label" for="provider-select">Provider</label>
      <select id="provider-select"></select>
      <label class="field-label" for="model-select">Model</label>
      <select id="model-select"></select>
      <textarea id="message-input" placeholder="Start a new conversation..." rows="3"></textarea>
      <button id="send-btn">Send</button>
    </div>

    <div class="section-label">Sessions</div>
    <div id="session-list-container"></div>
  </div>

  <!-- Chat View -->
  <div id="chat-view">
    <div id="chat-header">
      <button id="back-btn" title="Back">←</button>
      <span id="chat-title">Chat</span>
    </div>
    <div id="chat-messages"></div>
    <div id="chat-input-area">
      <textarea id="chat-input" placeholder="Send a message..." rows="1"></textarea>
      <button id="chat-send">Send</button>
    </div>
    <div id="chat-status">Ready</div>
  </div>

  <script>
    window.addEventListener('error', (e) => {
      document.title = 'ERR:' + e.message + ':' + e.lineno;
    });
    const vscode = acquireVsCodeApi();

    // State
    let currentView = 'main';
    let chatSessionId = '';
    let streaming = false;
    let currentAssistantEl = null;
    let modelsCache = {};  // providerId -> string[]

    // ---- Elements ----
    const mainView = document.getElementById('main-view');
    const chatView = document.getElementById('chat-view');
    const agentSelect = document.getElementById('agent-select');
    const providerSelect = document.getElementById('provider-select');
    const modelSelect = document.getElementById('model-select');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const sessionList = document.getElementById('session-list-container');

    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');
    const chatTitle = document.getElementById('chat-title');
    const chatStatus = document.getElementById('chat-status');
    const backBtn = document.getElementById('back-btn');

    // ---- Send from main view ----
    sendBtn.addEventListener('click', () => {
      const content = messageInput.value.trim();
      if (!content) return;
      const agentId = agentSelect.value || undefined;
      const provider = providerSelect.value || undefined;
      const modelId = modelSelect.value || undefined;
      // Switch to chat view with new session
      openChat('new', 'New Session');
      // Add user message
      appendMsg({ role: 'user', content, id: 'u' + Date.now() });
      // Send via WS
      vscode.postMessage({ type: 'send_message', content, agentId, provider, modelId, sessionId: 'new' });
      setStreaming(true);
      messageInput.value = '';
    });

    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    // ---- Provider/model cascading ----
    providerSelect.addEventListener('change', () => {
      const pid = providerSelect.value;
      modelSelect.innerHTML = '';
      if (!pid) return;
      if (modelsCache[pid]) {
        populateModels(modelsCache[pid]);
      } else {
        vscode.postMessage({ type: 'load_models', providerId: pid });
      }
    });

    function populateModels(models) {
      const current = modelSelect.value;
      modelSelect.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        modelSelect.appendChild(opt);
      }
      if (current && models.includes(current)) modelSelect.value = current;
    }

    // ---- Back button ----
    backBtn.addEventListener('click', () => {
      currentView = 'main';
      mainView.style.display = 'flex';
      chatView.style.display = 'none';
      vscode.postMessage({ type: 'refresh_sessions' });
    });

    // ---- Chat input ----
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend.click(); }
    });
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
    });
    chatSend.addEventListener('click', () => {
      const content = chatInput.value.trim();
      if (!content || streaming) return;
      appendMsg({ role: 'user', content, id: 'u' + Date.now() });
      vscode.postMessage({ type: 'send_message', content, sessionId: chatSessionId });
      chatInput.value = '';
      chatInput.style.height = 'auto';
      setStreaming(true);
    });

    // ---- Session list ----
    function renderSessions(sessions) {
      sessionList.innerHTML = '';
      if (!sessions || sessions.length === 0) {
        sessionList.innerHTML = '<div style="padding: 12px; opacity: 0.4; font-size: 0.85em;">No sessions yet</div>';
        return;
      }
      // Sort by last active desc
      sessions.sort((a, b) => (b.last_active_unix_ms || 0) - (a.last_active_unix_ms || 0));
      for (const s of sessions) {
        const el = document.createElement('div');
        el.className = 'session-item';
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = s.conversation_id || s.id;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = s.message_count + ' msgs · ' + timeAgo(s.last_active_unix_ms);
        el.appendChild(title);
        el.appendChild(meta);
        el.addEventListener('click', () => {
          openChat(s.id, s.conversation_id || s.id);
          vscode.postMessage({ type: 'load_history', sessionId: s.id });
        });
        sessionList.appendChild(el);
      }
    }

    function timeAgo(ms) {
      if (!ms) return '?';
      const s = Math.floor((Date.now() - ms) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    }

    // ---- Chat view ----
    function openChat(sessionId, title) {
      currentView = 'chat';
      chatSessionId = sessionId;
      mainView.style.display = 'none';
      chatView.style.display = 'flex';
      chatTitle.textContent = title;
      chatMessages.innerHTML = '';
      currentAssistantEl = null;
      setStatus('Ready');
    }

    function appendMsg(msg) {
      const el = document.createElement('div');
      el.className = 'msg ' + msg.role;

      if (msg.role === 'tool_call' || msg.role === 'tool') {
        const header = document.createElement('div');
        header.className = 'collapsible-header';
        const chevron = document.createElement('span');
        chevron.className = 'chevron'; chevron.textContent = '▼';
        const label = document.createElement('span');
        label.textContent = msg.role === 'tool_call' ? '🔧 ' + (msg.toolName || 'tool') : '📋 ' + (msg.toolName || 'result');
        header.appendChild(chevron);
        header.appendChild(label);
        el.appendChild(header);

        const content = document.createElement('div');
        content.className = 'collapsible-content';
        content.textContent = msg.content;
        el.appendChild(content);

        header.addEventListener('click', () => {
          header.classList.toggle('collapsed');
          content.classList.toggle('collapsed');
        });
      } else {
        const c = document.createElement('div');
        c.className = 'content';
        c.textContent = msg.content || '';
        el.appendChild(c);
      }

      chatMessages.appendChild(el);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return el;
    }

    function setStreaming(on) {
      streaming = on;
      chatSend.disabled = on;
      setStatus(on ? 'Agent is thinking...' : 'Ready');
    }

    function setStatus(text) {
      chatStatus.textContent = text;
    }

    // ---- Message handler from extension ----
    window.addEventListener('message', (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'init':
          // Populate agents
          agentSelect.innerHTML = '';
          for (const a of (msg.agents || [])) {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name || a.id;
            agentSelect.appendChild(opt);
          }
          // Populate providers
          providerSelect.innerHTML = '';
          for (const p of (msg.providers || [])) {
            const opt = document.createElement('option');
            opt.value = p.provider_id;
            opt.textContent = p.provider_id;
            providerSelect.appendChild(opt);
          }
          if (msg.defaultProvider) providerSelect.value = msg.defaultProvider;
          // Clear model select until provider is picked
          modelSelect.innerHTML = '';
          // Auto-load models for default provider
          if (providerSelect.value) {
            vscode.postMessage({ type: 'load_models', providerId: providerSelect.value });
          }
          break;

        case 'sessions':
          renderSessions((msg.sessions || []).filter(function(s) { return s.source === 'vscode'; }));
          break;

        case 'models':
          modelsCache[msg.providerId] = msg.models || [];
          if (providerSelect.value === msg.providerId) {
            populateModels(msg.models || []);
          }
          break;

        case 'history':
          chatMessages.innerHTML = '';
          currentAssistantEl = null;
          const turns = msg.turns || [];
          // Reverse to chronological
          for (const t of turns.slice().reverse()) {
            if (t.is_summary) continue;
            if (t.role === 'assistant' && t.tool_calls) {
              if (t.content) appendMsg({ role: 'assistant', content: t.content, id: 't' + t.turn_id });
              for (const tc of t.tool_calls) {
                appendMsg({ role: 'tool_call', content: tc.arguments, toolName: tc.name, id: 'tc' + tc.id });
              }
            } else if (t.role === 'tool') {
              appendMsg({ role: 'tool', content: t.content, toolName: t.tool_name, id: 'tr' + t.turn_id });
            } else if (t.content) {
              appendMsg({ role: t.role === 'user' ? 'user' : 'assistant', content: t.content, id: 't' + t.turn_id });
            }
          }
          chatMessages.scrollTop = chatMessages.scrollHeight;
          break;

        case 'context':
          if (msg.session_id) chatSessionId = msg.session_id;
          break;

        case 'text':
          if (!currentAssistantEl) {
            currentAssistantEl = appendMsg({ role: 'assistant', content: '', id: 's' + Date.now() });
            currentAssistantEl.classList.add('streaming-cursor');
          }
          let textDiv = currentAssistantEl.querySelector('.content');
          if (!textDiv) {
            textDiv = document.createElement('div');
            textDiv.className = 'content';
            currentAssistantEl.appendChild(textDiv);
          }
          textDiv.textContent += msg.content;
          chatMessages.scrollTop = chatMessages.scrollHeight;
          break;

        case 'tool_call':
          if (currentAssistantEl) {
            currentAssistantEl.classList.remove('streaming-cursor');
            currentAssistantEl = null;
          }
          appendMsg({ role: 'tool_call', content: msg.arguments, toolName: msg.tool_name, id: 'tc' + msg.tool_call_id });
          break;

        case 'tool_result':
          appendMsg({ role: 'tool', content: msg.content, toolName: msg.tool_name, id: 'tr' + msg.tool_call_id });
          break;

        case 'done':
          if (currentAssistantEl) {
            currentAssistantEl.classList.remove('streaming-cursor');
            currentAssistantEl = null;
          }
          setStreaming(false);
          break;

        case 'error':
        case 'ws_error':
          if (currentView === 'chat') setStatus('Error: ' + msg.message);
          break;

        case 'ws_open':
          if (currentView === 'chat') setStatus('Connected');
          break;

        case 'ws_close':
          if (currentView === 'chat') setStatus('Disconnected');
          break;

        case 'disconnected':
          agentSelect.innerHTML = '<option value="">Default Agent</option>';
          providerSelect.innerHTML = '<option value="">Provider</option>';
          modelSelect.innerHTML = '<option value="">Model</option>';
          sessionList.innerHTML = '<div style="padding: 12px; opacity: 0.4; font-size: 0.85em;">Not connected</div>';
          break;
      }
    });

    // Notify extension that view is ready
    vscode.postMessage({ type: 'view_ready' });
  </script>
</body>
</html>`;
}
