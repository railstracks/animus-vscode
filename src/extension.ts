// extension.ts — Main extension entry point

import * as vscode from 'vscode';
import { AnimusClient } from './client';
import { SessionProvider } from './sessionProvider';
import { ChatPanel } from './chatPanel';
import { getConfig, promptForConnection } from './config';
import type { ConnectionState, Agent } from './types';

let client: AnimusClient | null = null;
let sessionProvider: SessionProvider;
let statusBarItem: vscode.StatusBarItem;
let pollInterval: NodeJS.Timeout | null = null;
let extContext: vscode.ExtensionContext;
let cachedAgents: Agent[] = [];

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;

  sessionProvider = new SessionProvider();
  vscode.window.registerTreeDataProvider('animus-sessions', sessionProvider);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'animus.connect';
  context.subscriptions.push(statusBarItem);
  updateStatusBar('disconnected');
  statusBarItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand('animus.connect', () => connect()),
    vscode.commands.registerCommand('animus.disconnect', () => disconnect()),
    vscode.commands.registerCommand('animus.refreshSessions', () => refreshSessions()),
    vscode.commands.registerCommand('animus.newSession', () => newSession()),
    vscode.commands.registerCommand('animus.openChat', (item) => openChat(item)),
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
    cachedAgents = agents;

    startPolling();
    await refreshSessions();

    updateStatusBar('connected');
    vscode.window.showInformationMessage(
      `Animus: Connected (${agents.length} agent${agents.length !== 1 ? 's' : ''})`
    );
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
  sessionProvider.updateData([]);
  updateStatusBar('disconnected');
}

function startPolling(): void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    refreshSessions().catch(() => {});
  }, 15000);
}

// ---- Session Management ----

async function refreshSessions(): Promise<void> {
  if (!client) return;

  try {
    const sessions = await client.listSessions();
    sessionProvider.updateData(sessions);
  } catch (e) {
    if (client) {
      vscode.window.showWarningMessage(
        `Animus: Failed to refresh — ${(e as Error).message}`
      );
    }
  }
}

async function newSession(): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Animus: Not connected');
    return;
  }

  // Open chat panel in "new session" mode — the panel itself handles
  // agent/provider/model selection and sends the first message
  const extensionUri = extContext.extensionUri;
  ChatPanel.createOrShow(extensionUri, client, '', 'New Session', true, cachedAgents);
}

async function openChat(item: any): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Animus: Not connected');
    return;
  }

  const sessionId = item?.session?.id;
  if (!sessionId) {
    vscode.window.showWarningMessage('Animus: No session selected');
    return;
  }

  const extensionUri = extContext.extensionUri;
  const title = item?.session?.conversation_id || `Session ${sessionId}`;
  ChatPanel.createOrShow(extensionUri, client, sessionId, title, false, cachedAgents);
}

export function getAgents(): Agent[] {
  return cachedAgents;
}

// ---- Configuration ----

async function configureConnection(): Promise<void> {
  await promptForConnection();
  if (client) {
    disconnect();
    await connect();
  }
}

// ---- UI Helpers ----

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
