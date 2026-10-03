// Types shared by the agent's server loop and the browser panel.

/** What the user is looking at, sent with every agent request. */
export type AgentContext =
  | { page: 'home' }
  | {
      page: 'sheet';
      sheetId: string;
      title: string;
      /** Title of the original when the open spreadsheet is a branch. */
      branchOf?: string;
      tabs: string[];
      activeTab: string;
      /** Selected ranges in A1 notation, primary range last. */
      selection: string[];
    };

/** A tool call the browser must run (sheet tools and navigation), forwarded by the server. */
export interface ClientToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClientToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** Body of POST /api/agent/turn: a new user message, results of client tool calls, or both. */
export interface AgentTurnRequest {
  message?: string;
  context: AgentContext;
  toolResults?: ClientToolResult[];
}

/** Server-sent events streamed by POST /api/agent/turn. */
export type AgentEvent =
  | { type: 'text'; text: string }
  /** A tool the server runs itself (account tools). */
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; ok: boolean }
  /** The turn is paused until the browser runs these and posts their results. */
  | { type: 'client_tools'; calls: ClientToolCall[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** One entry in the chat transcript, as shown in the panel. */
export type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: 'running' | 'ok' | 'error';
      error?: string;
    };

export type AgentJobStatus = 'queued' | 'starting' | 'coding' | 'verifying' | 'done' | 'failed';

/** A change to the app's own code requested through the assistant, as shown in the panel. */
export interface AgentJob {
  id: string;
  title: string;
  status: AgentJobStatus;
  /** Progress lines, oldest first. */
  log: string[];
  /** What changed, written by the coding agent (when done). */
  summary?: string;
  error?: string;
  /** Files changed in the working tree. */
  files?: string[];
  costUsd?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The browser has shown the outcome and told the assistant. */
  acknowledged: boolean;
}

export const JOB_ACTIVE_STATUSES: ReadonlySet<AgentJobStatus> = new Set(['queued', 'starting', 'coding', 'verifying']);

/** Tools the browser executes; every other tool runs on the server. */
export const CLIENT_TOOLS = new Set([
  'get_sheet_overview',
  'read_range',
  'write_range',
  'clear_range',
  'format_range',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'sort_range',
  'set_cell_image',
  'set_filter',
  'set_filter_criteria',
  'set_column_width',
  'set_row_height',
  'freeze',
  'add_tab',
  'rename_tab',
  'delete_tab',
  'select_range',
  'open_sheet',
  // Runs in the browser so the user can confirm it there; the server then queues the job.
  'request_app_change',
]);
