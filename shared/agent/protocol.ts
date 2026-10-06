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
    }
  | {
      page: 'deck';
      deckId: string;
      title: string;
      slideCount: number;
      /** 1-based number of the slide being edited. */
      currentSlide: number;
      /** Ids of the selected elements on that slide. */
      selectedElements: string[];
    }
  | {
      page: 'doc';
      docId: string;
      title: string;
      blockCount: number;
      /** 1-based number of the block holding the cursor. */
      cursorBlock: number;
      /** The selected text, if any (shortened). */
      selectedText?: string;
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
/** An image attached to a user message (pasted or dropped screenshot), already downscaled by the browser. */
export interface AgentImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64, no data: prefix. */
  data: string;
  /**
   * Where the browser stored the image (/api/images/<id>), so the assistant can put the picture itself into a
   * cell or a slide with the image tools. Missing when the upload failed.
   */
  url?: string;
}

export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Per image, decoded bytes (the API allows 5 MB). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface AgentTurnRequest {
  message?: string;
  context: AgentContext;
  toolResults?: ClientToolResult[];
  images?: AgentImage[];
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
  | { kind: 'user'; text: string; /** data: URLs of attached images */ images?: string[] }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: 'running' | 'ok' | 'error';
      error?: string;
    };

/**
 * queued → starting → coding → verifying → building (production: rebuild the client) → restarting (production:
 * the server restarts itself) → publishing (commit, push, PR, merge) → done. A job is "live" (the change is
 * running) from publishing on.
 */
export type AgentJobStatus = 'queued' | 'starting' | 'coding' | 'verifying' | 'building' | 'restarting' | 'publishing' | 'done' | 'failed';

/** A change to the app's own code requested through the assistant: the record of the change. */
export interface AgentJob {
  id: string;
  /** A change to the app, the revert of an earlier change, or a research task whose result comes back to the chat. */
  kind: 'change' | 'revert' | 'research';
  title: string;
  /** The request given to the coding agent. */
  spec: string;
  /** For research: the spreadsheet exported for the task, if any. */
  sheetId?: string;
  status: AgentJobStatus;
  /** Progress lines, oldest first. */
  log: string[];
  /** What changed, written by the coding agent (when done). */
  summary?: string;
  error?: string;
  /** Files the job changed. */
  files?: string[];
  costUsd?: number;
  /** Email of the user who asked for it. */
  requestedBy?: string;
  /** Git branch, commit and pull request, when the change was published to GitHub. */
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  /** The commit on main after the pull request was merged. */
  mergedSha?: string;
  /** For a revert: the job it undoes. */
  revertsJobId?: string;
  /** Set on a change once a revert of it has succeeded. */
  revertedByJobId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The browser has shown the outcome and told the assistant. */
  acknowledged: boolean;
}

export const JOB_ACTIVE_STATUSES: ReadonlySet<AgentJobStatus> = new Set(['queued', 'starting', 'coding', 'verifying', 'building', 'restarting', 'publishing']);

/** The change is running in the app (publishing to GitHub may still be in progress). */
export function isJobLive(job: AgentJob): boolean {
  return job.status === 'publishing' || job.status === 'done';
}

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
  'move_columns',
  'sort_range',
  'set_cell_image',
  'set_cell_link',
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
  // Slide decks: act on the open presentation (client/src/agent/deckTools.ts).
  'open_deck',
  'read_deck',
  'add_slides',
  'update_slide',
  'edit_elements',
  'delete_slides',
  'move_slide',
  'set_deck_theme',
  // Drawn by the browser with the app's own slide renderer; the picture is attached to the resumed turn.
  'render_slide',
  // Text documents: act on the open document (client/src/agent/docTools.ts).
  'open_doc',
  'read_doc',
  'get_doc_info',
  'insert_content',
  'replace_blocks',
  'delete_blocks',
  'replace_text',
  'format_text',
  'format_blocks',
  'insert_image',
  // Fetches through the server (which holds the credentials) and writes into the live spreadsheet.
  'ingest_connector_data',
  // Runs in the browser so the user can confirm it there; the server then queues the job.
  'request_app_change',
  'request_research',
]);
