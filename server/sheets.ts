import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Deck } from '../shared/deck.ts';
import { checkCellImage, newWorkbook, type DocKind, type SheetMeta, type Workbook } from '../shared/types.ts';
import type { DB } from './db.ts';

interface SheetRow {
  id: string;
  owner_id: string;
  kind: DocKind;
  title: string;
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
  title: r.title,
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
 * Spreadsheets and slide decks, stored as one JSON file each with their metadata in SQLite. The workbook
 * methods (load, save, branch, ...) only see spreadsheets; the deck methods only see decks.
 */
export class SheetStore {
  private db: DB;
  private dir: string;
  // Serialize writes per document so concurrent saves can't interleave on disk.
  private writeChains = new Map<string, Promise<void>>();

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private filePath(file: string): string {
    return path.join(this.dir, file);
  }

  /** Documents of one kind (spreadsheets by default), most recently edited first. */
  list(ownerId: string, kind: DocKind = 'sheet'): SheetMeta[] {
    const rows = this.db
      .prepare(`${SELECT_SHEETS} WHERE s.owner_id = ? AND s.kind = ? ORDER BY s.updated_at DESC`)
      .all(ownerId, kind) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  private row(ownerId: string, id: string, kind?: DocKind): SheetRow | undefined {
    const r = this.db.prepare(`${SELECT_SHEETS} WHERE s.id = ? AND s.owner_id = ?`).get(id, ownerId) as SheetRow | undefined;
    return r && (!kind || r.kind === kind) ? r : undefined;
  }

  /** Metadata of a document of any kind. */
  get(ownerId: string, id: string, kind?: DocKind): SheetMeta | null {
    const r = this.row(ownerId, id, kind);
    return r ? toMeta(r) : null;
  }

  private async insert(ownerId: string, kind: DocKind, title: string, doc: Workbook | Deck): Promise<SheetMeta> {
    const id = randomUUID();
    const file = `${id}.json`;
    await this.writeAtomic(file, doc);
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO sheets (id, owner_id, kind, title, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, kind, title, file, now, now);
    return { id, kind, title, createdAt: now, updatedAt: now };
  }

  async create(ownerId: string, title: string, workbook?: Workbook): Promise<SheetMeta> {
    return this.insert(ownerId, 'sheet', title, workbook ?? newWorkbook(randomUUID()));
  }

  /** Create a branch: a copy of the sheet that remembers its original and keeps a snapshot (base) of it. */
  async branch(ownerId: string, sourceId: string, title: string): Promise<SheetMeta | null> {
    const src = await this.load(ownerId, sourceId);
    if (!src) return null;
    const id = randomUUID();
    const file = `${id}.json`;
    await this.writeAtomic(file, src.workbook);
    await this.writeAtomic(baseFileOf(id), src.workbook);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sheets (id, owner_id, kind, title, file, created_at, updated_at, parent_id, parent_title, branched_at)
         VALUES (?, ?, 'sheet', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ownerId, title, file, now, now, sourceId, src.meta.title, now);
    return this.get(ownerId, id);
  }

  /** Everything needed to compare a branch: its base snapshot and the original's current state. */
  async compareData(ownerId: string, id: string): Promise<{ meta: SheetMeta; base: Workbook; original: Workbook | null; parent: SheetMeta | null } | 'not-branch' | null> {
    const r = this.row(ownerId, id, 'sheet');
    if (!r) return null;
    if (!r.parent_id) return 'not-branch';
    const base = JSON.parse(await readFile(this.filePath(baseFileOf(id)), 'utf8')) as Workbook;
    const parent = await this.load(ownerId, r.parent_id);
    return { meta: toMeta(r), base, original: parent?.workbook ?? null, parent: parent?.meta ?? null };
  }

  private async read<T>(r: SheetRow): Promise<T> {
    await this.writeChains.get(r.id);
    return JSON.parse(await readFile(this.filePath(r.file), 'utf8')) as T;
  }

  async load(ownerId: string, id: string): Promise<{ meta: SheetMeta; workbook: Workbook } | null> {
    const r = this.row(ownerId, id, 'sheet');
    if (!r) return null;
    return { meta: toMeta(r), workbook: await this.read<Workbook>(r) };
  }

  private async write(r: SheetRow, doc: Workbook | Deck): Promise<SheetMeta> {
    const prev = this.writeChains.get(r.id) ?? Promise.resolve();
    const next = prev.then(() => this.writeAtomic(r.file, doc));
    this.writeChains.set(r.id, next.catch(() => {}));
    await next;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sheets SET updated_at = ? WHERE id = ?').run(now, r.id);
    return { ...toMeta(r), updatedAt: now };
  }

  async save(ownerId: string, id: string, workbook: Workbook): Promise<SheetMeta | null> {
    const r = this.row(ownerId, id, 'sheet');
    return r ? this.write(r, workbook) : null;
  }

  // --- Slide decks -------------------------------------------------------------

  async createDeck(ownerId: string, title: string, deck: Deck): Promise<SheetMeta> {
    return this.insert(ownerId, 'deck', title, deck);
  }

  async loadDeck(ownerId: string, id: string): Promise<{ meta: SheetMeta; deck: Deck } | null> {
    const r = this.row(ownerId, id, 'deck');
    if (!r) return null;
    return { meta: toMeta(r), deck: await this.read<Deck>(r) };
  }

  async saveDeck(ownerId: string, id: string, deck: Deck): Promise<SheetMeta | null> {
    const r = this.row(ownerId, id, 'deck');
    return r ? this.write(r, deck) : null;
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
    await rm(this.filePath(r.file), { force: true });
    await rm(this.filePath(baseFileOf(id)), { force: true });
    return true;
  }

  private async writeAtomic(file: string, doc: Workbook | Deck): Promise<void> {
    const target = this.filePath(file);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, target);
  }
}
