import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Deck } from '../shared/deck.ts';
import type { Doc } from '../shared/doc.ts';
import type { MarkdownDoc } from '../shared/markdown.ts';
import { csvProblem, csvStyle, csvToWorkbook, isCsvDoc, newCsvDoc, workbookToCsv, type CsvDoc } from '../shared/csv.ts';
import { migrateDeck } from '../shared/lines.ts';
import { checkCellImage, newWorkbook, type DocKind, type SheetMeta, type Workbook } from '../shared/types.ts';
import type { Backup } from './backup.ts';
import type { DB } from './db.ts';

export interface SheetRow {
  id: string;
  owner_id: string;
  kind: DocKind;
  /** 'csv' for a spreadsheet stored as CSV text; null otherwise. */
  format: string | null;
  title: string;
  /** Path of the folder the document is in; '' at the top. */
  folder: string;
  file: string;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
  parent_title: string | null;
  branched_at: string | null;
  /** Joined: the parent's current title (null if the parent no longer exists). */
  live_parent_title: string | null;
}

// Every metadata read joins the parent so branch info (current title, detached) is always fresh.
const SELECT_SHEETS = `
  SELECT s.*, p.title AS live_parent_title
  FROM sheets s LEFT JOIN sheets p ON p.id = s.parent_id AND p.owner_id = s.owner_id`;

const toMeta = (r: SheetRow): SheetMeta => ({
  id: r.id,
  kind: r.kind,
  ...(r.format === 'csv' ? { format: 'csv' as const } : {}),
  title: r.title,
  ...(r.folder ? { folder: r.folder } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.parent_id
    ? {
        branch: {
          parentId: r.parent_id,
          parentTitle: r.live_parent_title ?? r.parent_title ?? 'Deleted spreadsheet',
          branchedAt: r.branched_at ?? r.created_at,
          detached: r.live_parent_title === null,
        },
      }
    : {}),
});

const baseFileOf = (id: string) => `${id}.base.json`;

export type Stored = Workbook | Deck | Doc | MarkdownDoc | CsvDoc;

/** Structural validation of an uploaded workbook (guards against malformed saves, not a full schema). */
export function validateWorkbook(wb: unknown): string | null {
  if (!wb || typeof wb !== 'object') return 'Workbook must be an object';
  const w = wb as Workbook;
  if (w.version !== 1) return 'Unsupported workbook version';
  if (!Array.isArray(w.tabs) || w.tabs.length === 0) return 'Workbook must have at least one tab';
  if (w.tabs.length > 200) return 'Too many tabs';
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const t of w.tabs) {
    if (!t || typeof t !== 'object') return 'Invalid tab';
    if (typeof t.id !== 'string' || !t.id || ids.has(t.id)) return 'Invalid or duplicate tab id';
    if (typeof t.name !== 'string' || !t.name.trim()) return 'Invalid tab name';
    const lower = t.name.toLowerCase();
    if (names.has(lower)) return `Duplicate tab name "${t.name}"`;
    ids.add(t.id);
    names.add(lower);
    if (!Number.isInteger(t.rows) || !Number.isInteger(t.cols) || t.rows < 1 || t.cols < 1) return 'Invalid tab size';
    if (!t.cells || typeof t.cells !== 'object' || Array.isArray(t.cells)) return 'Invalid cells';
    for (const key in t.cells) {
      if (!/^[A-Z]{1,3}\d+$/.test(key)) return `Invalid cell address "${key}"`;
      const c = t.cells[key];
      if (!c || typeof c.v !== 'string') return `Invalid cell at ${key}`;
      if (c.img !== undefined) {
        const problem = checkCellImage(c.img);
        if (problem) return `Invalid image at ${key}: ${problem}`;
      }
    }
    if (!t.colWidths || typeof t.colWidths !== 'object') return 'Invalid column widths';
    if (!t.rowHeights || typeof t.rowHeights !== 'object') return 'Invalid row heights';
  }
  return null;
}

/**
 * Spreadsheets, slide decks, text documents and Markdown documents, stored as one JSON file each with their
 * metadata in SQLite. The workbook methods (load, save, branch, ...) only see spreadsheets; the deck, doc and
 * markdown methods likewise. A spreadsheet can be stored as CSV text instead of a workbook (format "csv"):
 * load still returns a workbook, and save writes CSV for as long as the workbook fits in one.
 */
export class SheetStore {
  protected db: DB;
  protected dir: string;
  // Serialize writes per document so concurrent saves can't interleave on disk.
  private writeChains = new Map<string, Promise<void>>();
  /** The off-box copy (backup.ts): every write, base and delete is reported to it when set. */
  backup: Backup | null = null;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  protected filePath(file: string): string {
    return path.join(this.dir, file);
  }

  // --- How documents are laid out on disk. The folder-backed store of the desktop app (server/localStore.ts)
  // overrides these to keep real files (.md, .csv, ...) under the names the user gave them. ---

  /** The file for a new document, relative to the store's directory, and the title it ends up with. */
  protected newFile(id: string, _kind: DocKind, _format: 'csv' | null, title: string, _folder: string): { file: string; title: string } {
    return { file: `${id}.json`, title };
  }

  /** The text written to a document's file. */
  protected encode(_file: string, doc: Stored): string {
    return JSON.stringify(doc);
  }

  /** The document read from the text of its file. */
  protected decode(_file: string, text: string): Stored {
    return JSON.parse(text) as Stored;
  }

  /** Where a branch's snapshot of its original is kept. */
  protected basePath(id: string): string {
    return this.filePath(baseFileOf(id));
  }

  /** The modification time recorded for a file that was just written. */
  protected stamp(_file: string): string {
    return new Date().toISOString();
  }

  /** Remove a deleted document's file. */
  protected async removeFile(r: SheetRow): Promise<void> {
    await rm(this.filePath(r.file), { force: true });
  }

  /** Documents of one kind (spreadsheets by default), most recently edited first. */
  list(ownerId: string, kind: DocKind = 'sheet'): SheetMeta[] {
    const rows = this.db
      .prepare(`${SELECT_SHEETS} WHERE s.owner_id = ? AND s.kind = ? ORDER BY s.updated_at DESC`)
      .all(ownerId, kind) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  protected row(ownerId: string, id: string, kind?: DocKind): SheetRow | undefined {
    const r = this.db.prepare(`${SELECT_SHEETS} WHERE s.id = ? AND s.owner_id = ?`).get(id, ownerId) as SheetRow | undefined;
    return r && (!kind || r.kind === kind) ? r : undefined;
  }

  /** Metadata of a document of any kind. */
  get(ownerId: string, id: string, kind?: DocKind): SheetMeta | null {
    const r = this.row(ownerId, id, kind);
    return r ? toMeta(r) : null;
  }

  private async insert(ownerId: string, kind: DocKind, wanted: string, doc: Stored, folder = '', format: 'csv' | null = null): Promise<SheetMeta> {
    const id = randomUUID();
    const { file, title } = this.newFile(id, kind, format, wanted, folder);
    const json = await this.writeDoc(file, doc);
    const now = this.stamp(file);
    this.db
      .prepare('INSERT INTO sheets (id, owner_id, kind, format, title, folder, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, kind, format, title, folder, file, now, now);
    this.backup?.putFile(ownerId, kind, id, now, json);
    return { id, kind, ...(format ? { format } : {}), title, ...(folder ? { folder } : {}), createdAt: now, updatedAt: now };
  }

  /** Documents of every kind in one folder, most recently edited first. */
  listIn(ownerId: string, folder: string): SheetMeta[] {
    const rows = this.db.prepare(`${SELECT_SHEETS} WHERE s.owner_id = ? AND s.folder = ? ORDER BY s.updated_at DESC`).all(ownerId, folder) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  /** Documents of every kind, in any folder, whose title contains the text; most recently edited first. */
  async search(ownerId: string, text: string, limit = 200): Promise<SheetMeta[]> {
    const rows = this.db
      .prepare(`${SELECT_SHEETS} WHERE s.owner_id = ? AND instr(lower(s.title), lower(?)) > 0 ORDER BY s.updated_at DESC LIMIT ?`)
      .all(ownerId, text, limit) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  /** Put a document in another folder. */
  move(ownerId: string, id: string, folder: string): SheetMeta | null {
    const r = this.row(ownerId, id);
    if (!r) return null;
    this.db.prepare('UPDATE sheets SET folder = ? WHERE id = ?').run(folder, id);
    return toMeta({ ...r, folder });
  }

  /** Create a spreadsheet stored as CSV text. Throws CsvError if the text cannot be opened as one. */
  async createCsv(ownerId: string, title: string, csv: string, folder = ''): Promise<SheetMeta> {
    csvToWorkbook(csv);
    return this.insert(ownerId, 'sheet', title, newCsvDoc(csv), folder, 'csv');
  }

  async create(ownerId: string, title: string, workbook?: Workbook, folder = ''): Promise<SheetMeta> {
    return this.insert(ownerId, 'sheet', title, workbook ?? newWorkbook(randomUUID()), folder);
  }

  /** Create a branch: a copy of the sheet that remembers its original and keeps a snapshot (base) of it. */
  async branch(ownerId: string, sourceId: string, wanted: string): Promise<SheetMeta | null> {
    const src = await this.load(ownerId, sourceId);
    if (!src) return null;
    const id = randomUUID();
    // A branch starts next to its original.
    const folder = src.meta.folder ?? '';
    const { file, title } = this.newFile(id, 'sheet', null, wanted, folder);
    const json = await this.writeDoc(file, src.workbook);
    await writeAtomic(this.basePath(id), JSON.stringify(src.workbook));
    const now = this.stamp(file);
    this.db
      .prepare(
        `INSERT INTO sheets (id, owner_id, kind, title, folder, file, created_at, updated_at, parent_id, parent_title, branched_at)
         VALUES (?, ?, 'sheet', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ownerId, title, folder, file, now, now, sourceId, src.meta.title, now);
    this.backup?.putFile(ownerId, 'sheet', id, now, json);
    this.backup?.putBase(ownerId, id, json);
    return this.get(ownerId, id);
  }

  /** Everything needed to compare a branch: its base snapshot and the original's current state. */
  async compareData(ownerId: string, id: string): Promise<{ meta: SheetMeta; base: Workbook; original: Workbook | null; parent: SheetMeta | null } | 'not-branch' | null> {
    const r = this.row(ownerId, id, 'sheet');
    if (!r) return null;
    if (!r.parent_id) return 'not-branch';
    const base = JSON.parse(await readFile(this.basePath(id), 'utf8')) as Workbook;
    const parent = await this.load(ownerId, r.parent_id);
    return { meta: toMeta(r), base, original: parent?.workbook ?? null, parent: parent?.meta ?? null };
  }

  private async read<T>(r: SheetRow): Promise<T> {
    await this.writeChains.get(r.id);
    return this.decode(r.file, await readFile(this.filePath(r.file), 'utf8')) as T;
  }

  async load(ownerId: string, id: string): Promise<{ meta: SheetMeta; workbook: Workbook } | null> {
    const r = this.row(ownerId, id, 'sheet');
    if (!r) return null;
    const stored = await this.read<Workbook | CsvDoc>(r);
    const csv = isCsvDoc(stored);
    // The file says what it is; bring the column in line if they disagree (e.g. after a restore).
    if (csv !== (r.format === 'csv')) this.setFormat(r, csv ? 'csv' : null);
    return { meta: toMeta(r), workbook: csv ? csvToWorkbook(stored.csv) : stored };
  }

  protected setFormat(r: SheetRow, format: 'csv' | null): void {
    this.db.prepare('UPDATE sheets SET format = ? WHERE id = ?').run(format, r.id);
    r.format = format;
  }

  private async write(r: SheetRow, doc: Stored): Promise<SheetMeta> {
    const prev = this.writeChains.get(r.id) ?? Promise.resolve();
    const next = prev.then(() => this.writeDoc(r.file, doc));
    this.writeChains.set(r.id, next.then(() => {}, () => {}));
    const json = await next;
    const now = this.stamp(r.file);
    this.db.prepare('UPDATE sheets SET updated_at = ? WHERE id = ?').run(now, r.id);
    this.backup?.putFile(r.owner_id, r.kind, r.id, now, json);
    return { ...toMeta(r), updatedAt: now };
  }

  async save(ownerId: string, id: string, workbook: Workbook): Promise<SheetMeta | null> {
    const r = this.row(ownerId, id, 'sheet');
    if (!r) return null;
    if (r.format !== 'csv') return this.write(r, workbook);
    // A CSV file stays CSV while the workbook holds nothing CSV cannot store; otherwise it becomes a native
    // spreadsheet rather than lose what was added.
    if (csvProblem(workbook)) {
      this.setFormat(r, null);
      return this.write(r, workbook);
    }
    const before = await this.read<Workbook | CsvDoc>(r);
    return this.write(r, newCsvDoc(workbookToCsv(workbook, isCsvDoc(before) ? csvStyle(before.csv) : undefined)));
  }

  /** Turn a CSV file into a native spreadsheet (same id and content). No-op for one that already is. */
  async convertToNative(ownerId: string, id: string): Promise<SheetMeta | null> {
    const res = await this.load(ownerId, id);
    if (!res) return null;
    if (res.meta.format !== 'csv') return res.meta;
    const r = this.row(ownerId, id, 'sheet')!;
    this.setFormat(r, null);
    return this.write(r, res.workbook);
  }

  // --- Slide decks -------------------------------------------------------------

  async createDeck(ownerId: string, title: string, deck: Deck, folder = ''): Promise<SheetMeta> {
    return this.insert(ownerId, 'deck', title, deck, folder);
  }

  async loadDeck(ownerId: string, id: string): Promise<{ meta: SheetMeta; deck: Deck } | null> {
    const r = this.row(ownerId, id, 'deck');
    if (!r) return null;
    return { meta: toMeta(r), deck: migrateDeck(await this.read<Deck>(r)) };
  }

  /** A presentation whoever owns it, with the owner. Only for content the app itself hands out (the Getting started guide). */
  async loadDeckOfAnyOwner(id: string): Promise<{ meta: SheetMeta; deck: Deck; ownerId: string } | null> {
    const r = this.db.prepare(`${SELECT_SHEETS} WHERE s.id = ? AND s.kind = 'deck'`).get(id) as SheetRow | undefined;
    if (!r) return null;
    return { meta: toMeta(r), deck: migrateDeck(await this.read<Deck>(r)), ownerId: r.owner_id };
  }

  async saveDeck(ownerId: string, id: string, deck: Deck): Promise<SheetMeta | null> {
    const r = this.row(ownerId, id, 'deck');
    return r ? this.write(r, deck) : null;
  }

  // --- Text documents ------------------------------------------------------------

  async createDoc(ownerId: string, title: string, doc: Doc, folder = ''): Promise<SheetMeta> {
    return this.insert(ownerId, 'doc', title, doc, folder);
  }

  async loadDoc(ownerId: string, id: string): Promise<{ meta: SheetMeta; doc: Doc } | null> {
    const r = this.row(ownerId, id, 'doc');
    if (!r) return null;
    return { meta: toMeta(r), doc: await this.read<Doc>(r) };
  }

  async saveDoc(ownerId: string, id: string, doc: Doc): Promise<SheetMeta | null> {
    const r = this.row(ownerId, id, 'doc');
    return r ? this.write(r, doc) : null;
  }

  // --- Markdown documents --------------------------------------------------------

  async createMarkdown(ownerId: string, title: string, doc: MarkdownDoc, folder = ''): Promise<SheetMeta> {
    return this.insert(ownerId, 'markdown', title, doc, folder);
  }

  async loadMarkdown(ownerId: string, id: string): Promise<{ meta: SheetMeta; doc: MarkdownDoc } | null> {
    const r = this.row(ownerId, id, 'markdown');
    if (!r) return null;
    return { meta: toMeta(r), doc: await this.read<MarkdownDoc>(r) };
  }

  async saveMarkdown(ownerId: string, id: string, doc: MarkdownDoc): Promise<SheetMeta | null> {
    const r = this.row(ownerId, id, 'markdown');
    return r ? this.write(r, doc) : null;
  }

  // --- Any kind ------------------------------------------------------------------

  rename(ownerId: string, id: string, title: string, kind?: DocKind): SheetMeta | null {
    const r = this.row(ownerId, id, kind);
    if (!r) return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sheets SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    return { ...toMeta(r), title, updatedAt: now };
  }

  async delete(ownerId: string, id: string, kind?: DocKind): Promise<boolean> {
    const r = this.row(ownerId, id, kind);
    if (!r) return false;
    this.db.prepare('DELETE FROM sheets WHERE id = ?').run(id);
    await this.writeChains.get(id);
    this.writeChains.delete(id);
    await this.removeFile(r);
    await rm(this.basePath(id), { force: true });
    this.backup?.markDeleted(r.owner_id, r.kind, id, r.title);
    return true;
  }

  /** Puts a deleted file back (from the off-box copy), under its old id. Fails if the id is taken. */
  async restore(ownerId: string, kind: DocKind, id: string, title: string, json: string): Promise<SheetMeta> {
    if (this.db.prepare('SELECT 1 FROM sheets WHERE id = ?').get(id)) throw new Error('A file with this id already exists');
    const file = `${id}.json`;
    await writeAtomic(this.filePath(file), json);
    const now = new Date().toISOString();
    // CSV files are written as {"version":1,"csv":...}; load corrects the column if this guess is ever wrong.
    const format = kind === 'sheet' && /^\s*\{"version":1,"csv":/.test(json) ? 'csv' : null;
    this.db
      .prepare('INSERT INTO sheets (id, owner_id, kind, format, title, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, kind, format, title, file, now, now);
    this.backup?.putFile(ownerId, kind, id, now, json);
    return { id, kind, ...(format ? { format } : {}), title, createdAt: now, updatedAt: now };
  }

  /** Writes the document to its file and returns the text written. */
  private async writeDoc(file: string, doc: Stored): Promise<string> {
    const text = this.encode(file, doc);
    await writeAtomic(this.filePath(file), text);
    return text;
  }
}

/** Writes a file so a reader never sees half of it: a temp file next to it, then a rename. */
export async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
}
