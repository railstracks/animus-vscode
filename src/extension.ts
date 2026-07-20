// extension.ts — Main extension entry point

import * as vscode from 'vscode';
import { AnimusClient } from './client';
import { SessionProvider } from './sessionProvider';
import { ChatPanel } from './chatPanel';
import { getConfig, promptForConnection } from './config';
import type { ConnectionState } from './types';

let client: AnimusClient | null = null;
let sessionProvider: SessionProvider;
let statusBarItem: vscode.StatusBarItem;
let pollInterval: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // Create session provider
  sessionProvider = new SessionProvider();
  vscode.window.registerTreeDataProvider('animus-sessions', sessionProvider);

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'animus.connect';
  context.subscriptions.push(statusBarItem);
  updateStatusBar('disconnected');
  statusBarItem.show();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('animus.connect', () => connect(context)),
    vscode.commands.registerCommand('animus.disconnect', () => disconnect()),
    vscode.commands.registerCommand('animus.refreshSessions', () => refreshSessions()),
    vscode.commands.registerCommand('animus.newSession', () => newSession()),
    vscode.commands.registerCommand('animus.openChat', (item) => openChat(item)),
    vscode.commands.registerCommand('animus.selectAgent', () => selectAgent()),
    vscode.commands.registerCommand('animus.configureConnection', () => configureConnection()),
  );

  // Auto-connect if config exists
  const config = getConfig();
  if (config.daemonUrl && config.authToken) {
    connect(context);
  }
}

export function deactivate(): void {
  disconnect();
}

// ---- Connection Management ----

async function connect(context: vscode.ExtensionContext): Promise<void> {
  let config = getConfig();

  if (!config.daemonUrl || !config.authToken) {
    const prompted = await promptForConnection();
    if (!prompted) return;
    config = prompted;
  }

  updateStatusBar('connecting');

  try {
    client = new AnimusClient(config);

    // Test connection by listing agents
    const agents = await client.listAgents();

    // Start polling sessions
    startPolling();

    // Initial data load
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
  sessionProvider.updateData([], []);
  updateStatusBar('disconnected');
}

function startPolling(): void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    refreshSessions().catch(() => {});
  }, 15000); // 15 second poll
}

// ---- Session Management ----

async function refreshSessions(): Promise<void> {
  if (!client) return;

  try {
    const [agents, sessions] = await Promise.all([
      client.listAgents(),
      client.listSessions(),
    ]);
    sessionProvider.updateData(agents, sessions);
  } catch (e) {
    // Silent fail for polling — only show errors on manual refresh
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

  try {
    const config = getConfig();
    const result = await client.createSession(config.agentId || undefined);
    const sessionId = result.session_id;

    await refreshSessions();

    // Open chat for the new session
    const extensionUri = vscode.extensions.getExtension('artificers.animus')?.extensionUri;
    if (extensionUri) {
      ChatPanel.createOrShow(extensionUri, client, sessionId, 'New Session');
    }
  } catch (e) {
    vscode.window.showErrorMessage(
      `Animus: Failed to create session — ${(e as Error).message}`
    );
  }
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

  const extensionUri = vscode.extensions.getExtension('artificers.animus')?.extensionUri;
  if (!extensionUri) return;

  const title = item?.session?.conversation_id || `Session ${sessionId}`;
  ChatPanel.createOrShow(extensionUri, client, sessionId, title);
}

// ---- Agent Selection ----

async function selectAgent(): Promise<void> {
  if (!client) {
    vscode.window.showWarningMessage('Animus: Not connected');
    return;
  }

  try {
    const agents = await client.listAgents();
    const items = agents.map(a => ({
      label: a.name || a.id,
      description: a.model,
      detail: a.description,
      id: a.id,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select default agent',
    });

    if (picked) {
      const { updateConfig } = await import('./config');
      await updateConfig({ agentId: picked.id });
      vscode.window.showInformationMessage(`Animus: Default agent set to ${picked.label}`);
    }
  } catch (e) {
    vscode.window.showErrorMessage(`Animus: ${(e as Error).message}`);
  }
}

// ---- Configuration ----

async function configureConnection(): Promise<void> {
  await promptForConnection();
  // Reconnect with new config
  if (client) {
    disconnect();
    const context = vscode.extensions.getExtension('artificers.animus')?.activationKind;
    await connect(
      vscode.extensions.getExtension('artificers.animus')?.extensionUri ?? vscode.Uri.file('.')
    );
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
