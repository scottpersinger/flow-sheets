// Persistence for agent conversations: one active conversation per user, messages stored exactly as
// sent to the Claude API. History is append-only (never edited), which keeps prompt caching and
// thinking-block replay valid across turns.
import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';

export type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

/**
 * Tool calls from the last assistant message that don't have results yet. The turn pauses here while the
 * browser runs client tools; results collected so far (server tools) are kept until the next request.
 */
export interface Pending {
  /** Every tool_use id of the assistant message, in order. */
  toolUseIds: string[];
  results: Record<string, ToolResult>;
  /** Ids the browser was asked to run. */
  clientIds: string[];
}

export interface Conversation {
  id: string;
  pending: Pending | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export class AgentStore {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  /** The user's active conversation, created if there is none. */
  active(userId: string): Conversation {
    const row = this.db.prepare('SELECT id, pending FROM agent_conversations WHERE user_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1').get(userId) as
      | { id: string; pending: string | null }
      | undefined;
    if (row) return { id: row.id, pending: row.pending ? (JSON.parse(row.pending) as Pending) : null };
    const id = randomUUID();
    this.db.prepare('INSERT INTO agent_conversations (id, user_id, created_at) VALUES (?, ?, ?)').run(id, userId, new Date().toISOString());
    return { id, pending: null };
  }

  /** End the active conversation; the next message starts a new one. Old conversations are kept. */
  reset(userId: string): void {
    this.db.prepare('UPDATE agent_conversations SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL').run(new Date().toISOString(), userId);
  }

  messages(conversationId: string): MessageParam[] {
    const rows = this.db.prepare('SELECT role, content FROM agent_messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as {
      role: 'user' | 'assistant';
      content: string;
    }[];
    return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
  }

  append(conversationId: string, msg: MessageParam): void {
    this.db
      .prepare('INSERT INTO agent_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(conversationId, msg.role, JSON.stringify(msg.content), new Date().toISOString());
  }

  setPending(conversationId: string, pending: Pending | null): void {
    this.db.prepare('UPDATE agent_conversations SET pending = ? WHERE id = ?').run(pending ? JSON.stringify(pending) : null, conversationId);
  }

  requestsToday(userId: string): number {
    const row = this.db.prepare('SELECT requests FROM agent_usage WHERE user_id = ? AND day = ?').get(userId, today()) as { requests: number } | undefined;
    return row?.requests ?? 0;
  }

  recordUsage(userId: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): void {
    const input = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    this.db
      .prepare(
        `INSERT INTO agent_usage (user_id, day, requests, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (user_id, day) DO UPDATE SET requests = requests + 1, input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(userId, today(), input, usage.output_tokens);
  }
}
