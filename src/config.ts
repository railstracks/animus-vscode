// config.ts — Connection configuration management

import * as vscode from 'vscode';
import type { ConnectionConfig } from './types';

export function getConfig(): ConnectionConfig {
  const cfg = vscode.workspace.getConfiguration('animus');
  return {
    daemonUrl: cfg.get<string>('daemonUrl', 'http://localhost:8080').replace(/\/$/, ''),
    authToken: cfg.get<string>('authToken', ''),
    agentId: cfg.get<string>('agentId', ''),
    node: cfg.get<string>('node', ''),
  };
}

export async function updateConfig(partial: Partial<ConnectionConfig>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('animus');
  if (partial.daemonUrl !== undefined) await cfg.update('daemonUrl', partial.daemonUrl, true);
  if (partial.authToken !== undefined) await cfg.update('authToken', partial.authToken, true);
  if (partial.agentId !== undefined) await cfg.update('agentId', partial.agentId, true);
  if (partial.node !== undefined) await cfg.update('node', partial.node, true);
}

export async function promptForConnection(): Promise<ConnectionConfig | undefined> {
  const current = getConfig();

  const url = await vscode.window.showInputBox({
    prompt: 'Animus daemon URL',
    value: current.daemonUrl,
    placeHolder: 'http://localhost:8080',
  });
  if (!url) return undefined;

  const token = await vscode.window.showInputBox({
    prompt: 'Admin auth token',
    value: current.authToken,
    password: true,
    placeHolder: 'Paste your Animus admin token',
  });

  const agentId = await vscode.window.showInputBox({
    prompt: 'Default agent ID (optional)',
    value: current.agentId,
    placeHolder: 'Leave empty to use the default agent',
  });

  const node = await vscode.window.showInputBox({
    prompt: 'Node name for workspace tool routing (optional)',
    value: current.node,
    placeHolder: 'e.g. workstation',
  });

  const config: ConnectionConfig = {
    daemonUrl: url.replace(/\/$/, ''),
    authToken: token ?? '',
    agentId: agentId ?? '',
    node: node ?? '',
  };

  await updateConfig(config);
  return config;
}
