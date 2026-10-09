// Stored files (generated PDFs, uploads). The bytes live next to the sheets as files named by id; the table
// holds the metadata. Files are only readable by their owner.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredFile } from '../shared/types.ts';
import type { DB } from './db.ts';

export interface StoredFileRow {
  id: string;
  filename: string;
  /** Path of the folder the file is in; '' (or absent) at the top. */
  folder?: string;
  type: string;
  size: number;
  created_at: string;
}

export const toFileMeta = (r: StoredFileRow): StoredFile => ({
  id: r.id,
  filename: r.filename,
  ...(r.folder ? { folder: r.folder } : {}),
  type: r.type,
  size: r.size,
  createdAt: r.created_at,
  url: `/api/files/${r.id}`,
  downloadUrl: `/api/files/${r.id}/download`,
});

export class FileStore {
  protected db: DB;
  protected dir: string;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(ownerId: string, filename: string, type: string, data: Buffer, folder = ''): Promise<StoredFile> {
    const id = randomUUID();
    const target = path.join(this.dir, id);
    await writeFile(`${target}.tmp`, data);
    await rename(`${target}.tmp`, target);
    const row = { id, filename, folder, type, size: data.length, created_at: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO stored_files (id, owner_id, filename, folder, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, filename, folder, type, data.length, row.created_at);
    return toFileMeta(row);
  }

  /** The user's files, most recent first. */
  list(ownerId: string): StoredFile[] {
    const rows = this.db.prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC').all(ownerId) as unknown as StoredFileRow[];
    return rows.map(toFileMeta);
  }

  /** The user's files in one folder, most recent first. */
  listIn(ownerId: string, folder: string): StoredFile[] {
    const rows = this.db.prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ? AND folder = ? ORDER BY created_at DESC, rowid DESC').all(ownerId, folder) as unknown as StoredFileRow[];
    return rows.map(toFileMeta);
  }

  /** The user's files, in any folder, whose name contains the text; most recent first. */
  async search(ownerId: string, text: string, limit = 200): Promise<StoredFile[]> {
    const rows = this.db
      .prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ? AND instr(lower(filename), lower(?)) > 0 ORDER BY created_at DESC LIMIT ?')
      .all(ownerId, text, limit) as unknown as StoredFileRow[];
    return rows.map(toFileMeta);
  }

  /** Put a file in another folder. */
  move(ownerId: string, id: string, folder: string): StoredFile | null {
    const f = this.get(ownerId, id);
    if (!f) return null;
    this.db.prepare('UPDATE stored_files SET folder = ? WHERE id = ?').run(folder, id);
    return { ...f.meta, folder: folder || undefined };
  }

  get(ownerId: string, id: string): { meta: StoredFile; file: string } | null {
    const r = this.db.prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE id = ? AND owner_id = ?').get(id, ownerId) as unknown as StoredFileRow | undefined;
    return r ? { meta: toFileMeta(r), file: path.join(this.dir, id) } : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM stored_files WHERE id = ? AND owner_id = ?').run(id, ownerId);
    if (!r.changes) return false;
    await rm(path.join(this.dir, id), { force: true });
    return true;
  }
}
