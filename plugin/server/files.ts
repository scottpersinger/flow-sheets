// Access to the user's documents and presentations for the ChatGPT plugin: the same SQLite database and JSON
// files the app uses, scoped to one account, plus the headless editing the model's tools need. Edits run the
// app's own tools (client/src/agent/docTools.ts and deckTools.ts) against a controller that has no editor
// view, so a tool behaves exactly as it does inside the app, then the result is saved.
import { openGettingStarted } from '../../server/gettingStarted.ts';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { runClientTool, type ClientToolEnv } from '../../client/src/agent/clientTools.ts';
import { runDeckTool } from '../../client/src/agent/deckTools.ts';
import { importExcel, ImportError } from '../../server/xlsxImport.ts';
import { runDocTool } from '../../client/src/agent/docTools.ts';
import { ToolError } from '../../client/src/agent/toolError.ts';
import { DeckController } from '../../client/src/deck/controller.ts';
import { DocController } from '../../client/src/doc/controller.ts';
import { SheetController } from '../../client/src/state/controller.ts';
import { openDb, type DB } from '../../server/db.ts';
import { ImageStore } from '../../server/images.ts';
import { SheetStore, validateWorkbook } from '../../server/sheets.ts';
import { buildSlide, newId, validateDeck, type Deck, type LayoutId, type SlideContent, type ThemeId } from '../../shared/deck.ts';
import { docFromNode, newDoc, validateDoc, type Doc } from '../../shared/doc.ts';
import { markdownToDoc } from '../../shared/docMarkdown.ts';
import { CELL_IMAGE_TYPES, MAX_CELL_IMAGE_BYTES, type SheetMeta, type StoredFile, type Workbook } from '../../shared/types.ts';
import { FileStore } from '../../server/files.ts';
import { importBytes, ImportFileError } from '../../server/importFile.ts';

export { ToolError };

export type FileKind = 'doc' | 'deck' | 'sheet';
export const FILE_KINDS: readonly FileKind[] = ['doc', 'deck', 'sheet'];
export type FileData = Doc | Deck | Workbook;
/** Everything the library lists: the three editable kinds, and stored files (PDFs and videos) that are only shown. */
export type LibraryKind = FileKind | 'file';
export const LIBRARY_KINDS: readonly LibraryKind[] = [...FILE_KINDS, 'file'];

export { importLimit, MAX_IMPORT_BYTES, MAX_PDF_BYTES, sniffImageType } from '../../server/importFile.ts';
/** How long a link to a stored file's bytes works (the player asks for the file in pieces as it plays). */
const FILE_LINK_MS = 6 * 60 * 60 * 1000;

/** A save with a stale revision: someone else (the app, the model) changed the file first. */
export class ConflictError extends Error {
  rev: string;
  constructor(rev: string) {
    super('The file changed since it was loaded. Reload it and try again.');
    this.rev = rev;
  }
}

export interface FileSummary {
  kind: LibraryKind;
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
  /** Stored files: the MIME type and the size in bytes. */
  type?: string;
  size?: number;
}

/** Where the user is in the open file, as reported by the app's editor. */
export interface Cursor {
  /** Documents: 1-based block holding the cursor, and the selected text. */
  cursor_block?: number;
  selected_text?: string;
  /** Presentations: 1-based slide being viewed, and ids of the selected elements. */
  slide?: number;
  selection?: string[];
  /** Spreadsheets: the active tab's name (selection holds the selected ranges, e.g. "B2:D9"). */
  tab?: string;
}

export interface OpenFile {
  kind: LibraryKind;
  id: string;
  title: string;
  rev: string;
}

export interface AppState {
  open: OpenFile | null;
}

export interface FileHubOptions {
  db: DB;
  dataDir: string;
  /** Public origin of the plugin server; images are served from it. */
  publicUrl: string | null;
  /** The app's own stores, when the plugin runs inside the app (so writes share one queue). */
  sheets?: SheetStore;
  images?: ImageStore;
  files?: FileStore;
}

/** Tools the model may run on a document, in the app's vocabulary. */
export const DOC_EDIT_TOOLS = ['read_doc', 'get_doc_info', 'insert_content', 'replace_blocks', 'delete_blocks', 'replace_text', 'format_text', 'format_blocks', 'insert_image', 'set_doc_style', 'set_page_setup'] as const;
export type DocEditTool = (typeof DOC_EDIT_TOOLS)[number];
/** Tools the model may run on a presentation (render_slide needs a browser and is left out). */
export const DECK_EDIT_TOOLS = ['read_deck', 'add_slides', 'update_slide', 'edit_elements', 'delete_slides', 'move_slide', 'set_deck_theme'] as const;
export type DeckEditTool = (typeof DECK_EDIT_TOOLS)[number];
/** Tools the model may run on a spreadsheet (select_range only moves the user's cursor and is left out). */
export const SHEET_EDIT_TOOLS = [
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
] as const;
export type SheetEditTool = (typeof SHEET_EDIT_TOOLS)[number];

export interface SlideSpec extends SlideContent {
  layout?: LayoutId;
}

const summary = (m: SheetMeta): FileSummary => ({ kind: m.kind as FileKind, id: m.id, title: m.title, updated_at: m.updatedAt, created_at: m.createdAt });

const fileSummary = (f: StoredFile): FileSummary => ({ kind: 'file', id: f.id, title: f.filename, updated_at: f.createdAt, created_at: f.createdAt, type: f.type, size: f.size });

const noun = (kind: LibraryKind) => (kind === 'doc' ? 'document' : kind === 'deck' ? 'presentation' : kind === 'sheet' ? 'spreadsheet' : 'file');

/** Apply fn to every image address in a document (the content is plain JSON). */
function mapDocImages(doc: Doc, fn: (src: string) => string): Doc {
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    let out = node as { type?: string; attrs?: { src?: unknown }; content?: unknown[] };
    if (out.type === 'image' && typeof out.attrs?.src === 'string') out = { ...out, attrs: { ...out.attrs, src: fn(out.attrs.src) } };
    if (Array.isArray(out.content)) out = { ...out, content: out.content.map(walk) };
    return out;
  };
  return { ...doc, content: walk(doc.content) as Doc['content'] };
}

/** Apply fn to every image element's address in a presentation. */
function mapDeckImages(deck: Deck, fn: (src: string) => string): Deck {
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, elements: s.elements.map((e) => (e.type === 'image' ? { ...e, src: fn(e.src) } : e)) })) };
}

/** Apply fn to every cell image's address in a workbook. */
function mapWorkbookImages(wb: Workbook, fn: (src: string) => string): Workbook {
  return {
    ...wb,
    tabs: wb.tabs.map((t) => ({ ...t, cells: Object.fromEntries(Object.entries(t.cells).map(([k, c]) => [k, c.img ? { ...c, img: fn(c.img) } : c])) })),
  };
}

function mapImages<T extends FileData>(kind: FileKind, data: T, fn: (src: string) => string): T {
  if (kind === 'doc') return mapDocImages(data as Doc, fn) as T;
  if (kind === 'deck') return mapDeckImages(data as Deck, fn) as T;
  return mapWorkbookImages(data as Workbook, fn) as T;
}

/** The app's storage, shared by every account the plugin serves. */
export class FileHub {
  readonly db: DB;
  readonly sheets: SheetStore;
  readonly images: ImageStore;
  readonly files: FileStore;
  readonly publicUrl: string | null;
  private readonly byUser = new Map<string, FileService>();
  /** Links to stored files' bytes: the app's iframe has no credentials, so the address carries a token. */
  private readonly fileLinks = new Map<string, { userId: string; id: string; expires: number }>();
  /** One-time tickets letting the app upload a file for import without a bearer token (it has none). */
  private readonly tickets = new Map<string, { userId: string; expires: number }>();

  constructor(opts: FileHubOptions) {
    this.db = opts.db;
    this.sheets = opts.sheets ?? new SheetStore(opts.db, path.join(opts.dataDir, 'sheets'));
    this.images = opts.images ?? new ImageStore(opts.db, path.join(opts.dataDir, 'images'));
    this.files = opts.files ?? new FileStore(opts.db, path.join(opts.dataDir, 'files'));
    this.publicUrl = opts.publicUrl?.replace(/\/$/, '') ?? null;
  }

  /** Open the app's database in this data directory. */
  static async open(opts: { dataDir: string; publicUrl: string | null }): Promise<FileHub> {
    const hub = new FileHub({ db: openDb(path.join(opts.dataDir, 'app.db')), dataDir: opts.dataDir, publicUrl: opts.publicUrl });
    await hub.init();
    return hub;
  }

  async init(): Promise<void> {
    await this.sheets.init();
    await this.images.init();
    await this.files.init();
  }

  /** The files of one account; the same instance (with its open-file state) for every request of that user. */
  forUser(userId: string): FileService {
    let svc = this.byUser.get(userId);
    if (!svc) {
      svc = new FileService(this, userId);
      this.byUser.set(userId, svc);
    }
    return svc;
  }

  userIdForEmail(email: string): string | null {
    const row = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Who the account is, for ChatGPT's account linking. */
  profile(userId: string): { id: string; email: string } | null {
    const row = this.db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: string; email: string } | undefined;
    return row ?? null;
  }

  /** A ticket the app presents when posting a file to /plugin/import; good for one upload within five minutes. */
  issueTicket(userId: string): string {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { userId, expires: now + 5 * 60 * 1000 });
    return ticket;
  }

  /** The account a ticket was issued to, consuming it; null when unknown or expired. */
  redeemTicket(ticket: string | null | undefined): string | null {
    if (!ticket) return null;
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return t && t.expires >= Date.now() ? t.userId : null;
  }

  /** A token for reading one stored file's bytes for a few hours; the same one while it has plenty of time left. */
  issueFileLink(userId: string, id: string): string {
    const now = Date.now();
    for (const [k, v] of this.fileLinks) {
      if (v.expires < now) this.fileLinks.delete(k);
      else if (v.userId === userId && v.id === id && v.expires - now > FILE_LINK_MS / 2) return k;
    }
    const token = randomBytes(24).toString('base64url');
    this.fileLinks.set(token, { userId, id, expires: now + FILE_LINK_MS });
    return token;
  }

  /** The stored file a link's token is for, or null when the token is unknown, expired or for another file. */
  fileForLink(token: string | null | undefined, id: string): { meta: StoredFile; file: string } | null {
    const link = token ? this.fileLinks.get(token) : undefined;
    if (!link || link.id !== id || link.expires < Date.now()) return null;
    return this.files.get(link.userId, id);
  }

  /** A stored image by id, whoever owns it: the iframe fetches images without credentials, so the id is the secret. */
  /** True for an image address this server stores (either form). */
  isOwnImage(src: string): boolean {
    return src.startsWith('/api/images/') || (!!this.publicUrl && src.startsWith(`${this.publicUrl}/plugin/img/`));
  }

  imageFile(id: string): { file: string; type: string } | null {
    const row = this.db.prepare('SELECT owner_id FROM images WHERE id = ?').get(id) as { owner_id: string } | undefined;
    return row ? this.images.get(row.owner_id, id) : null;
  }
}

export class FileService {
  readonly hub: FileHub;
  readonly sheets: SheetStore;
  readonly images: ImageStore;
  readonly userId: string;
  readonly publicUrl: string | null;
  /** The file shown in the app, which the model's tools act on by default. */
  open: { kind: LibraryKind; id: string } | null = null;
  cursor: Cursor = {};

  constructor(hub: FileHub, userId: string) {
    this.hub = hub;
    this.sheets = hub.sheets;
    this.images = hub.images;
    this.userId = userId;
    this.publicUrl = hub.publicUrl;
  }

  profile(): { id: string; email: string } {
    return this.hub.profile(this.userId) ?? { id: this.userId, email: '' };
  }

  // --- Listing and lifecycle --------------------------------------------------------

  list(kind?: LibraryKind, query?: string): FileSummary[] {
    const q = query?.trim().toLowerCase();
    const kinds = kind ? [kind] : LIBRARY_KINDS;
    return kinds
      .flatMap((k) => (k === 'file' ? this.hub.files.list(this.userId).map(fileSummary) : this.sheets.list(this.userId, k).map(summary)))
      .filter((m) => !q || m.title.toLowerCase().includes(q))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  async createDoc(title: string, markdown?: string): Promise<FileSummary> {
    const doc = markdown ? markdownToDoc(markdown) : newDoc();
    const problem = validateDoc(doc);
    if (problem) throw new ToolError(problem);
    return summary(await this.sheets.createDoc(this.userId, title.trim() || 'Untitled document', doc));
  }

  async createSheet(title: string): Promise<FileSummary> {
    return summary(await this.sheets.create(this.userId, title.trim() || 'Untitled spreadsheet'));
  }

  async createDeck(title: string, theme?: ThemeId, slides: SlideSpec[] = []): Promise<FileSummary> {
    const deck: Deck = {
      version: 1,
      theme: theme ?? 'light',
      slides: slides.length ? slides.map((s, i) => buildSlide(s.layout ?? (i === 0 ? 'title' : 'title-body'), s, newId)) : [buildSlide('title', {}, newId)],
    };
    const problem = validateDeck(deck);
    if (problem) throw new ToolError(problem);
    return summary(await this.sheets.createDeck(this.userId, title.trim() || 'Untitled presentation', deck));
  }

  /** The user's copy of the Getting started guide; the first call makes it. */
  async gettingStarted(): Promise<FileSummary> {
    return summary(await openGettingStarted(this.sheets, this.images, this.userId));
  }

  /**
   * Create a document from a Word file or a presentation from a PowerPoint file, with the app's own
   * converters (pictures are stored for the account). The kind comes from the bytes, not the name.
   */
  async importFile(bytes: Buffer, name: string | undefined, title: string | undefined): Promise<{ file: FileSummary; warnings: string[] }> {
    try {
      const made = await importBytes({ sheets: this.sheets, images: this.images, files: this.hub.files }, this.userId, bytes, name, title);
      return { file: made.sheet ? summary(made.sheet) : fileSummary(made.file), warnings: made.warnings };
    } catch (e) {
      if (e instanceof ImportFileError) throw new ToolError(e.message);
      throw e;
    }
  }

  rename(kind: LibraryKind, id: string, title: string): FileSummary {
    if (kind === 'file') throw new ToolError('A PDF or video keeps the name it was uploaded with.');
    const meta = this.sheets.rename(this.userId, id, title.trim(), kind);
    if (!meta) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return summary(meta);
  }

  async delete(kind: LibraryKind, id: string): Promise<void> {
    if (!(kind === 'file' ? await this.hub.files.delete(this.userId, id) : await this.sheets.delete(this.userId, id, kind))) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    if (this.open?.id === id) this.setOpen(null);
  }

  /** A stored file (a PDF or a video) of this account. */
  storedFile(id: string): FileSummary {
    const f = this.hub.files.get(this.userId, id);
    if (!f) throw new ToolError(`There is no file ${id}.`);
    return fileSummary(f.meta);
  }

  /** A stored file with an address the app's iframe can load it from (and seek in) for the next few hours. */
  fileLink(id: string): { file: FileSummary; url: string } {
    const file = this.storedFile(id);
    return { file, url: `${this.publicUrl ?? ''}/plugin/file/${id}?t=${this.hub.issueFileLink(this.userId, id)}` };
  }

  setOpen(file: { kind: LibraryKind; id: string } | null, cursor: Cursor = {}): void {
    if (file && !(file.kind === 'file' ? this.hub.files.get(this.userId, file.id) : this.sheets.get(this.userId, file.id, file.kind))) throw new ToolError(`There is no ${noun(file.kind)} ${file.id}.`);
    this.open = file;
    this.cursor = file ? cursor : {};
  }

  /** The id to act on for a tool of this kind: the given one, else the open file if it is of that kind. */
  target(kind: FileKind, id: string | undefined): string | null {
    if (id) return id;
    return this.open?.kind === kind ? this.open.id : null;
  }

  state(): AppState {
    if (this.open?.kind === 'file') {
      const f = this.hub.files.get(this.userId, this.open.id)?.meta;
      if (!f) this.open = null;
      return { open: f ? { kind: 'file', id: f.id, title: f.filename, rev: f.createdAt } : null };
    }
    const meta = this.open ? this.sheets.get(this.userId, this.open.id, this.open.kind) : null;
    if (this.open && !meta) this.open = null;
    return { open: meta ? { kind: this.open!.kind, id: meta.id, title: meta.title, rev: meta.updatedAt } : null };
  }

  // --- Whole files for the app's editors --------------------------------------------------

  /** An Excel file as workbook tabs, for adding to an open spreadsheet. */
  async convertExcel(bytes: Buffer, name?: string): Promise<{ workbook: Workbook; warnings: string[] }> {
    if (name && !/\.xlsx?$/i.test(name)) throw new ToolError('Choose an Excel workbook (.xlsx or .xls).');
    try {
      const { workbook, warnings } = await importExcel(bytes);
      const problem = validateWorkbook(workbook);
      if (problem) throw new ToolError(problem);
      return { workbook, warnings };
    } catch (e) {
      if (e instanceof ImportError) throw new ToolError(e.message);
      throw e;
    }
  }

  /** The stored file of a kind, or null. */
  private async load(kind: FileKind, id: string): Promise<{ meta: SheetMeta; data: FileData } | null> {
    if (kind === 'doc') {
      const r = await this.sheets.loadDoc(this.userId, id);
      return r && { meta: r.meta, data: r.doc };
    }
    if (kind === 'deck') {
      const r = await this.sheets.loadDeck(this.userId, id);
      return r && { meta: r.meta, data: r.deck };
    }
    const r = await this.sheets.load(this.userId, id);
    return r && r.meta.kind === 'sheet' ? { meta: r.meta, data: r.workbook } : null;
  }

  /** A file with image addresses the app's iframe can load. The revision is the save time. */
  async get(kind: FileKind, id: string): Promise<{ meta: FileSummary; rev: string; data: FileData }> {
    const loaded = await this.load(kind, id);
    if (!loaded) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return { meta: summary(loaded.meta), rev: loaded.meta.updatedAt, data: this.toPublic(kind, loaded.data) };
  }

  /** Save a whole file. With ifRev, the save only happens when nobody else saved first. */
  async save(kind: FileKind, id: string, data: FileData, ifRev?: string): Promise<{ rev: string }> {
    const stored = this.toStored(kind, data);
    const problem = kind === 'doc' ? validateDoc(stored) : kind === 'deck' ? validateDeck(stored) : validateWorkbook(stored);
    if (problem) throw new ToolError(problem);
    const meta = this.sheets.get(this.userId, id, kind);
    if (!meta) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    if (ifRev && meta.updatedAt !== ifRev) throw new ConflictError(meta.updatedAt);
    const saved =
      kind === 'doc' ? await this.sheets.saveDoc(this.userId, id, stored as Doc) : kind === 'deck' ? await this.sheets.saveDeck(this.userId, id, stored as Deck) : await this.sheets.save(this.userId, id, stored as Workbook);
    if (!saved) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return { rev: saved.updatedAt };
  }

  // --- Headless editing for the model's tools --------------------------------------------

  /**
   * Run one of the app's document tools on a stored document and save the result. Returns what the tool
   * returned (parsed), with the document id and its new revision.
   */
  async editDoc(id: string, tool: DocEditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const loaded = await this.sheets.loadDoc(this.userId, id);
    if (!loaded) throw new ToolError(`There is no document ${id}.`);
    const before = JSON.stringify(loaded.doc);
    const ctl = new DocController(loaded.doc, async () => {});
    try {
      const result = JSON.parse(runDocTool({ id: 'mcp', name: tool, input }, { doc: ctl, group: `mcp-${Date.now()}` })) as Record<string, unknown>;
      const after = docFromNode(ctl.doc);
      let rev = loaded.meta.updatedAt;
      if (JSON.stringify(after) !== before) rev = (await this.save('doc', id, after, loaded.meta.updatedAt)).rev;
      if (this.open?.id === id && (tool === 'read_doc' || tool === 'get_doc_info')) {
        // The headless controller has no cursor; report the one the app's editor told us about.
        if (this.cursor.cursor_block) result.cursor_block = this.cursor.cursor_block;
        if (this.cursor.selected_text) result.selected_text = this.cursor.selected_text;
        else delete result.selected_text;
      }
      return { doc_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  /** The same for a presentation and the app's deck tools. */
  async editDeck(id: string, tool: DeckEditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const loaded = await this.sheets.loadDeck(this.userId, id);
    if (!loaded) throw new ToolError(`There is no presentation ${id}.`);
    const before = JSON.stringify(loaded.deck);
    const ctl = new DeckController(loaded.deck, async () => {});
    try {
      if (this.open?.id === id) {
        // Start where the user is, so "the current slide" and the outline's marker are right.
        if (this.cursor.slide) ctl.goTo(this.cursor.slide - 1);
        if (this.cursor.selection?.length) ctl.select(this.cursor.selection);
      }
      const result = JSON.parse(runDeckTool({ id: 'mcp', name: tool, input }, { deck: ctl, group: `mcp-${Date.now()}` })) as Record<string, unknown>;
      const after = ctl.deck;
      let rev = loaded.meta.updatedAt;
      if (JSON.stringify(after) !== before) rev = (await this.save('deck', id, after, loaded.meta.updatedAt)).rev;
      return { deck_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  /** The same for a spreadsheet and the app's sheet tools (which run against a SheetController). */
  async editSheet(id: string, tool: SheetEditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const loaded = await this.sheets.load(this.userId, id);
    if (!loaded || loaded.meta.kind !== 'sheet') throw new ToolError(`There is no spreadsheet ${id}.`);
    const before = JSON.stringify(loaded.workbook);
    const ctl = new SheetController(loaded.workbook, async () => {});
    try {
      if (this.open?.id === id && this.cursor.tab) {
        // Start on the tab the user is looking at, so tools that default to "the active tab" agree with them.
        const tab = ctl.store.workbook.tabs.find((t) => t.name === this.cursor.tab);
        if (tab && tab.id !== ctl.activeTabId) ctl.switchTab(tab.id);
      }
      const unavailable = (what: string) => async () => {
        throw new ToolError(`${what} is not available here.`);
      };
      const env = {
        ctl,
        deck: null,
        doc: null,
        group: `mcp-${Date.now()}`,
        openSheet: unavailable('Opening another spreadsheet'),
        openDeck: unavailable('Opening a presentation'),
        openDoc: unavailable('Opening a document'),
        requestAppChange: unavailable('Changing the app'),
        requestResearch: unavailable('Research'),
        uploadImage: async (blob: Blob) => this.storeImage(blob.type, Buffer.from(await blob.arrayBuffer())),
      } as unknown as ClientToolEnv;
      const result = JSON.parse(await runClientTool({ id: 'mcp', name: tool, input }, env)) as Record<string, unknown>;
      const after = ctl.store.workbook;
      let rev = loaded.meta.updatedAt;
      if (JSON.stringify(after) !== before) rev = (await this.save('sheet', id, after, loaded.meta.updatedAt)).rev;
      if (this.open?.id === id && tool === 'get_sheet_overview' && this.cursor.selection?.length) result.selection = this.cursor.selection;
      return { sheet_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  // --- Images ---------------------------------------------------------------------------

  /** Store an image uploaded from the app; returns an address the iframe can load. */
  uploadImage(type: string, base64: string): Promise<string> {
    return this.storeImage(type, Buffer.from(base64, 'base64'));
  }

  /** Store image bytes (an upload, an attachment, an inline image); returns an address the iframe can load. */
  async storeImage(type: string, data: Buffer): Promise<string> {
    if (!CELL_IMAGE_TYPES.includes(type)) throw new ToolError('Please choose a PNG, JPEG, GIF or WebP image.');
    if (data.length > MAX_CELL_IMAGE_BYTES) throw new ToolError(`Images must be under ${Math.round(MAX_CELL_IMAGE_BYTES / 1e6)} MB.`);
    return this.publicSrc(await this.images.create(this.userId, type, data));
  }

  /** True for an image address this server stores (either form). */
  isOwnImage(src: string): boolean {
    return src.startsWith('/api/images/') || (!!this.publicUrl && src.startsWith(`${this.publicUrl}/plugin/img/`));
  }

  imageFile(id: string): { file: string; type: string } | null {
    return this.images.get(this.userId, id);
  }

  /** Stored "/api/images/<id>" addresses become "<publicUrl>/plugin/img/<id>" for the iframe. */
  publicSrc(src: string): string {
    return this.publicUrl && src.startsWith('/api/images/') ? `${this.publicUrl}/plugin/img/${src.slice('/api/images/'.length)}` : src;
  }

  storedSrc(src: string): string {
    const prefix = this.publicUrl ? `${this.publicUrl}/plugin/img/` : null;
    return prefix && src.startsWith(prefix) ? `/api/images/${src.slice(prefix.length)}` : src;
  }

  toPublic<T extends FileData>(kind: FileKind, data: T): T {
    return this.publicUrl ? mapImages(kind, data, (s) => this.publicSrc(s)) : data;
  }

  toStored<T extends FileData>(kind: FileKind, data: T): T {
    return this.publicUrl ? mapImages(kind, data, (s) => this.storedSrc(s)) : data;
  }
}
