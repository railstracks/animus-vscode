// sessionProvider.ts — Flat TreeDataProvider for the sidebar session list

import * as vscode from 'vscode';
import type { SessionSummary } from './types';

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionSummary
  ) {
    super(
      session.conversation_id || session.id,
      vscode.TreeItemCollapsibleState.None
    );
    const date = new Date(session.last_active_unix_ms);
    const ago = formatTimeAgo(date);
    this.description = `${session.message_count} msgs · ${ago}`;
    this.tooltip = `Session ${session.id}\n${session.source} · ${session.conversation_id}\n${session.message_count} messages\nLast active: ${date.toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon('comment');
    this.contextValue = 'session';
  }
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export class SessionProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChange = new vscode.EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private sessions: SessionSummary[] = [];

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  updateData(sessions: SessionSummary[]): void {
    this.sessions = sessions;
    this.refresh();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): Thenable<SessionItem[]> {
    return Promise.resolve(this.sessions.map(s => new SessionItem(s)));
  }
}
