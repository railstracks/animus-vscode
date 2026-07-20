// types.ts — Shared types for the Animus VSCode extension

export interface Agent {
  id: string;
  name: string;
  description: string;
  provider_id: string;
  model: string;
  avatar?: string;
}

export interface SessionSummary {
  id: string;
  source: string;
  conversation_id: string;
  thread_id: string;
  message_count: number;
  last_active_unix_ms: number;
  session_type?: string;
}

export interface SessionTurn {
  turn_id: number;
  role: string;
  content: string;
  unix_ms: number;
  is_summary: boolean;
  is_compacted: boolean;
  thinking_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  attachments?: Attachment[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  filepath: string;
  has_inline_data?: boolean;
  access_token?: string;
}

export interface ConnectionConfig {
  daemonUrl: string;
  authToken: string;
  agentId: string;
  node: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'tool_call';
  content: string;
  timestamp: number;
  streaming: boolean;
  thinking?: string;
  toolName?: string;
  attachments?: Attachment[];
}
