import type { AgentEvent, AgentJob, AgentTurnRequest, AssistantSettings, AssistantSettingsUpdate, ChatItem } from '../../shared/agent/protocol.ts';
import type { ConnectionInfo, ConnectorInfo, FetchResult } from '../../shared/connectors.ts';
import type { Deck } from '../../shared/deck.ts';
import type { Doc } from '../../shared/doc.ts';
import type { MarkdownDoc } from '../../shared/markdown.ts';
import type { FilePreview } from '../../shared/preview.ts';
import { CELL_IMAGE_TOO_LARGE, type DeletedFile, type SheetMeta, type StoredFile, type Workbook } from '../../shared/types.ts';

export interface User {
  id: string;
  email: string;
}

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable reason, when the server gives one (e.g. 'unverified'). */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, url: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, code } = data as { error?: string; code?: string };
    throw new ApiError(res.status, error ?? `Request failed (${res.status})`, code);
  }
  return data as T;
}

async function uploadExcel<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    // The server detects .xlsx vs .xls from the file contents.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 413 ? 'This file is too large to import (20 MB maximum).' : (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? `Import failed (${res.status})`);
  }
  return data as T;
}

/** Store a cell image on the server; resolves to its URL. */
async function uploadImage(file: Blob): Promise<string> {
  const res = await fetch('/api/images', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = res.status === 413 ? `${CELL_IMAGE_TOO_LARGE}.` : (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? `Image upload failed (${res.status})`);
  }
  return (data as { url: string }).url;
}

/** Store a file (generated PDF, upload) on the server. */
async function uploadFile(name: string, file: Blob, folder?: string): Promise<StoredFile> {
  const res = await fetch(`/api/files${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, res.status === 413 ? 'This file is too large to upload.' : ((data as { error?: string }).error ?? `File upload failed (${res.status})`));
  return (data as { file: StoredFile }).file;
}

/** A folder of the library (shared/folders.ts): its name and its path from the top. */
export interface FolderInfo {
  name: string;
  path: string;
}

/** `&folder=...` (or `?folder=...`) for an upload that goes into a folder; nothing at the top. */
const inFolder = (folder: string | undefined, first = false) => (folder ? `${first ? '?' : '&'}folder=${encodeURIComponent(folder)}` : '');

export const api = {
  /** What is in a folder ('' is the top): its folders, documents of every kind and stored files. */
  library: (folder = '') => request<{ folder: string; folders: FolderInfo[]; docs: SheetMeta[]; files: StoredFile[] }>('GET', `/api/library${inFolder(folder, true)}`),
  /** A small picture of a document, for the thumbnail view. */
  preview: (id: string) => request<{ preview: FilePreview }>('GET', `/api/library/preview/${encodeURIComponent(id)}`),
  /** Folders, documents and stored files whose name contains the text, in every folder. */
  searchLibrary: (q: string) => request<{ folders: FolderInfo[]; docs: SheetMeta[]; files: StoredFile[]; truncated: boolean }>('GET', `/api/library/search?q=${encodeURIComponent(q)}`),
  createFolder: (parent: string, name: string) => request<{ folder: FolderInfo }>('POST', '/api/folders', { name, folder: parent || undefined }),
  /** Delete an empty folder. */
  deleteFolder: (path: string) => request<{ ok: true }>('DELETE', `/api/folders${inFolder(path, true)}`),
  /** Move a document (any kind) or a stored file ('file') into a folder. */
  moveToFolder: (kind: SheetMeta['kind'] | 'file', id: string, folder: string) => request<{ ok: true }>('POST', '/api/library/move', { kind, id, folder }),
  uploadImage,
  uploadFile,
  listFiles: () => request<{ files: StoredFile[] }>('GET', '/api/files'),
  /** Replace a stored text file's contents. */
  updateFile: async (id: string, text: string): Promise<StoredFile> => {
    const res = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([text]) });
    const data = (await res.json().catch(() => ({}))) as { file?: StoredFile; error?: string };
    if (!res.ok || !data.file) throw new ApiError(res.status, res.status === 413 ? 'This file is too large to save.' : (data.error ?? `Saving the file failed (${res.status})`));
    return data.file;
  },
  /** Make an edited copy of a stored picture with the image model; resolves with the new file. */
  editImage: (id: string, prompt: string) => request<{ file: StoredFile }>('POST', `/api/files/${encodeURIComponent(id)}/edit-image`, { prompt }),
  revertFile: (id: string) => request<{ file: StoredFile }>('POST', `/api/files/${encodeURIComponent(id)}/revert`),
  getFile: (id: string) => request<{ file: StoredFile }>('GET', `/api/files/${encodeURIComponent(id)}/meta`),
  deleteFile: (id: string) => request<{ ok: true }>('DELETE', `/api/files/${encodeURIComponent(id)}`),
  me: () => request<{ user: User | null; googleLogin: boolean; local?: { dir: string } }>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, password: string) => request<{ pending: true; email: string }>('POST', '/api/auth/register', { email, password }),
  verifyEmail: (token: string) => request<{ user: User }>('POST', '/api/auth/verify', { token }),
  resendVerification: (email: string) => request<{ ok: true }>('POST', '/api/auth/verify/resend', { email }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  forgotPassword: (email: string) => request<{ ok: true }>('POST', '/api/auth/forgot', { email }),
  checkResetToken: (token: string) => request<{ email: string }>('GET', `/api/auth/reset?token=${encodeURIComponent(token)}`),
  resetPassword: (token: string, password: string) => request<{ user: User }>('POST', '/api/auth/reset', { token, password }),

  listSheets: () => request<{ sheets: SheetMeta[] }>('GET', '/api/sheets'),
  createSheet: (title: string, folder?: string) => request<{ sheet: SheetMeta }>('POST', '/api/sheets', { title, folder: folder || undefined }),
  /** Create a CSV file from the text of an uploaded .csv file; it opens in the spreadsheet editor. */
  importCsv: (title: string, csv: string, folder?: string) => request<{ sheet: SheetMeta }>('POST', '/api/sheets', { title, csv, folder: folder || undefined }),
  /** Turn a CSV file into a native spreadsheet. */
  convertSheet: (id: string) => request<{ sheet: SheetMeta }>('POST', `/api/sheets/${encodeURIComponent(id)}/convert`, {}),
  getSheet: (id: string) => request<{ sheet: SheetMeta; workbook: Workbook }>('GET', `/api/sheets/${encodeURIComponent(id)}`),
  saveSheet: (id: string, workbook: Workbook, keepalive = false) =>
    request<{ sheet: SheetMeta }>('PUT', `/api/sheets/${encodeURIComponent(id)}`, { workbook }, keepalive ? { keepalive: true } : undefined),
  /** Import an Excel file (.xlsx or .xls) as a new spreadsheet. */
  importXlsx: (file: File, title: string, folder?: string) =>
    uploadExcel<{ sheet: SheetMeta; warnings: string[] }>(`/api/sheets/import?title=${encodeURIComponent(title)}${inFolder(folder)}`, file),
  /** Convert an Excel file (.xlsx or .xls) to workbook tabs without creating a spreadsheet. */
  convertXlsx: (file: File) => uploadExcel<{ workbook: Workbook; warnings: string[] }>('/api/import/xlsx', file),
  branchSheet: (id: string, title?: string) => request<{ sheet: SheetMeta }>('POST', `/api/sheets/${encodeURIComponent(id)}/branch`, { title }),
  compareSheet: (id: string) =>
    request<{ meta: SheetMeta; base: Workbook; original: Workbook | null; parent: SheetMeta | null }>('GET', `/api/sheets/${encodeURIComponent(id)}/compare`),
  renameSheet: (id: string, title: string) => request<{ sheet: SheetMeta }>('PATCH', `/api/sheets/${encodeURIComponent(id)}`, { title }),
  deleteSheet: (id: string) => request<{ ok: true }>('DELETE', `/api/sheets/${encodeURIComponent(id)}`),

  listDecks: () => request<{ decks: SheetMeta[] }>('GET', '/api/decks'),
  /** The user's copy of the Getting started guide; the first call makes it. */
  gettingStarted: () => request<{ deck: SheetMeta }>('POST', '/api/getting-started'),
  createDeck: (title: string, deck?: Deck, folder?: string) => request<{ deck: SheetMeta }>('POST', '/api/decks', { title, deck, folder: folder || undefined }),
  getDeck: (id: string) => request<{ meta: SheetMeta; deck: Deck }>('GET', `/api/decks/${encodeURIComponent(id)}`),
  /** rev is the updatedAt the editor loaded; the server refuses (409) when the presentation changed since. */
  saveDeck: (id: string, deck: Deck, rev?: string, keepalive = false) =>
    request<{ meta: SheetMeta }>('PUT', `/api/decks/${encodeURIComponent(id)}`, { deck, rev }, keepalive ? { keepalive: true } : undefined),
  /** Import a PowerPoint file (.pptx) as a new presentation. */
  importPptx: (file: File, title: string, folder?: string) => uploadExcel<{ deck: SheetMeta; warnings: string[] }>(`/api/decks/import?title=${encodeURIComponent(title)}${inFolder(folder)}`, file),
  /** Convert a PowerPoint file (.pptx) to slides without creating a presentation. */
  convertPptx: (file: File) => uploadExcel<{ deck: Deck; warnings: string[] }>('/api/import/pptx', file),
  renameDeck: (id: string, title: string) => request<{ meta: SheetMeta }>('PATCH', `/api/decks/${encodeURIComponent(id)}`, { title }),
  deleteDeck: (id: string) => request<{ ok: true }>('DELETE', `/api/decks/${encodeURIComponent(id)}`),

  listDocs: () => request<{ docs: SheetMeta[] }>('GET', '/api/docs'),
  createDoc: (title: string, doc?: Doc, folder?: string) => request<{ doc: SheetMeta }>('POST', '/api/docs', { title, doc, folder: folder || undefined }),
  getDoc: (id: string) => request<{ meta: SheetMeta; doc: Doc }>('GET', `/api/docs/${encodeURIComponent(id)}`),
  /** rev is the updatedAt the editor loaded; the server refuses (409) when the document changed since. */
  saveDoc: (id: string, doc: Doc, rev?: string, keepalive = false) =>
    request<{ meta: SheetMeta }>('PUT', `/api/docs/${encodeURIComponent(id)}`, { doc, rev }, keepalive ? { keepalive: true } : undefined),
  /** Import a Word file (.docx) as a new document. */
  importPdf: (file: File, folder?: string) => uploadExcel<{ file: StoredFile }>(`/api/import/pdf?filename=${encodeURIComponent(file.name)}${inFolder(folder)}`, file),
  importDocx: (file: File, title: string, folder?: string) => uploadExcel<{ doc: SheetMeta; warnings: string[] }>(`/api/docs/import?title=${encodeURIComponent(title)}${inFolder(folder)}`, file),
  /** Convert a Word file (.docx) to document blocks without creating a document. */
  convertDocx: (file: File) => uploadExcel<{ doc: Doc; warnings: string[] }>('/api/import/docx', file),
  renameDoc: (id: string, title: string) => request<{ meta: SheetMeta }>('PATCH', `/api/docs/${encodeURIComponent(id)}`, { title }),
  deleteDoc: (id: string) => request<{ ok: true }>('DELETE', `/api/docs/${encodeURIComponent(id)}`),

  listMarkdown: () => request<{ docs: SheetMeta[] }>('GET', '/api/markdown'),
  /** Create a Markdown document, empty or from the text of an uploaded .md file. */
  createMarkdown: (title: string, text = '', folder?: string) => request<{ doc: SheetMeta }>('POST', '/api/markdown', { title, text, folder: folder || undefined }),
  getMarkdown: (id: string) => request<{ meta: SheetMeta; doc: MarkdownDoc }>('GET', `/api/markdown/${encodeURIComponent(id)}`),
  /** `rev` is the revision loaded; the server answers 409 when the document was saved elsewhere since. */
  saveMarkdown: (id: string, doc: MarkdownDoc, rev?: string, keepalive = false) =>
    request<{ meta: SheetMeta }>('PUT', `/api/markdown/${encodeURIComponent(id)}`, { doc, rev }, keepalive ? { keepalive: true } : undefined),
  renameMarkdown: (id: string, title: string) => request<{ meta: SheetMeta }>('PATCH', `/api/markdown/${encodeURIComponent(id)}`, { title }),
  deleteMarkdown: (id: string) => request<{ ok: true }>('DELETE', `/api/markdown/${encodeURIComponent(id)}`),
  listTrash: () => request<{ files: DeletedFile[]; available: boolean }>('GET', '/api/trash'),
  restoreFromTrash: (id: string) => request<{ file: SheetMeta }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`),

  agentTranscript: () => request<{ items: ChatItem[] }>('GET', '/api/agent'),
  agentReset: () => request<{ ok: true }>('POST', '/api/agent/reset', {}),
  agentTurn: streamAgentTurn,
  createJob: (title: string, spec: string, opts: { kind?: 'change' | 'research'; sheetId?: string | null } = {}) =>
    request<{ job: AgentJob }>('POST', '/api/agent/jobs', { title, spec, ...opts }),
  latestJob: () => request<{ job: AgentJob | null }>('GET', '/api/agent/jobs/latest'),
  acknowledgeJob: (id: string) => request<{ ok: true }>('POST', `/api/agent/jobs/${encodeURIComponent(id)}/ack`, {}),
  listJobs: () => request<{ jobs: AgentJob[] }>('GET', '/api/agent/jobs'),
  listConnectors: () => request<{ connectors: ConnectorInfo[] }>('GET', '/api/connectors'),
  listConnections: () => request<{ connections: ConnectionInfo[] }>('GET', '/api/connections'),
  createConnection: (connector: string, name: string, fields: Record<string, string>) =>
    request<{ connection: ConnectionInfo }>('POST', '/api/connections', { connector, name, fields }),
  updateConnection: (id: string, name: string, fields: Record<string, string>) =>
    request<{ connection: ConnectionInfo }>('PATCH', `/api/connections/${encodeURIComponent(id)}`, { name, fields }),
  deleteConnection: (id: string) => request<{ ok: true }>('DELETE', `/api/connections/${encodeURIComponent(id)}`),
  /** Test credentials before saving (with an id, blank secret fields use the saved ones). */
  testCredentials: (connector: string, fields: Record<string, string>, id?: string) => request<{ ok: true }>('POST', '/api/connections/test', { connector, fields, id }),
  testConnection: (id: string) => request<{ connection: ConnectionInfo }>('POST', `/api/connections/${encodeURIComponent(id)}/test`, {}),
  fetchConnectorData: (id: string, body: { dataset: string; params: Record<string, unknown>; handle?: string }) =>
    request<FetchResult>('POST', `/api/connections/${encodeURIComponent(id)}/fetch`, body),
  assistantSettings: () => request<{ settings: AssistantSettings }>('GET', '/api/settings/assistant'),
  saveAssistantSettings: (body: AssistantSettingsUpdate) => request<{ settings: AssistantSettings }>('PUT', '/api/settings/assistant', body),
  revertJob: (id: string) => request<{ job: AgentJob }>('POST', `/api/agent/jobs/${encodeURIComponent(id)}/revert`, {}),
};

/** Run or resume an agent turn, calling onEvent for each server-sent event until the stream ends. */
async function streamAgentTurn(body: AgentTurnRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void): Promise<void> {
  const res = await fetch('/api/agent/turn', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  // The server always ends a turn with done, client_tools or error; a stream that stops without one was cut
  // off (for example by the server restarting).
  let ended = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, end);
      buf = buf.slice(end + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6)) as AgentEvent;
        if (event.type === 'done' || event.type === 'client_tools' || event.type === 'error') ended = true;
        onEvent(event);
      }
    }
  }
  if (!ended) throw new ApiError(0, 'The connection to the server was interrupted. Send your message again.');
}
