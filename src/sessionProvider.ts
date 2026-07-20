// sessionProvider.ts — TreeDataProvider for the sidebar session list

import * as vscode from 'vscode';
import type { SessionSummary, Agent } from './types';

type TreeItem = SessionItem | AgentItem;

class AgentItem extends vscode.TreeItem {
  constructor(
    public readonly agent: Agent,
    public readonly sessions: SessionSummary[]
  ) {
    super(
      agent.name || agent.id,
      sessions.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.description = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;
    this.tooltip = `${agent.name}\n${agent.model}\n${agent.description ?? ''}`;
    this.iconPath = new vscode.ThemeIcon('symbol-color');
    this.contextValue = 'agent';
  }
}

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

export class SessionProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChange = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private agents: Agent[] = [];
  private sessions: SessionSummary[] = [];

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  updateData(agents: Agent[], sessions: SessionSummary[]): void {
    this.agents = agents;
    this.sessions = sessions;
    this.refresh();
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): Thenable<TreeItem[]> {
    if (!element) {
      // Top level: show agents (or ungrouped sessions if no agents)
      if (this.agents.length === 0) {
        return Promise.resolve(this.sessions.map(s => new SessionItem(s)));
      }
      const items: AgentItem[] = this.agents.map(agent => {
        const agentSessions = this.sessions.filter(s =>
          s.source.includes(agent.id) || s.source === 'admin_ws'
        );
        return new AgentItem(agent, agentSessions);
      });
      return Promise.resolve(items);
    }

    if (element instanceof AgentItem) {
      return Promise.resolve(element.sessions.map(s => new SessionItem(s)));
    }

    return Promise.resolve([]);
  }
}
