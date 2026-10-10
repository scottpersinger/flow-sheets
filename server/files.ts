// Stored files (generated PDFs, uploads). The bytes live next to the sheets as files named by id; the table
// holds the metadata. Files are only readable by their owner.
import { newFileId } from './ids.ts';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** True if the bytes start as a picture of this type does (PNG, JPEG or WebP). */
export function isImageOfType(data: Buffer, type: string): boolean {
  if (type === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (type === 'image/webp') return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

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

  /** An id no stored file has yet. */
  protected newId(): string {
    return newFileId((id) => !!this.db.prepare('SELECT 1 FROM stored_files WHERE id = ?').get(id));
  }

  async create(ownerId: string, filename: string, type: string, data: Buffer, folder = ''): Promise<StoredFile> {
    const id = this.newId();
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

  /** Where the version before the last rewrite of a file is kept, or null when this store keeps none. */
  protected previousPath(file: string): string | null {
    return `${file}.prev`;
  }

  /** Replace a file's bytes (a text file the assistant edited, a picture from the image editor). The version it replaces is kept, for one step of undo. */
  async update(ownerId: string, id: string, data: Buffer): Promise<StoredFile | null> {
    const f = this.get(ownerId, id);
    if (!f) return null;
    const prev = this.previousPath(f.file);
    if (prev) await copyFile(f.file, prev);
    await writeFile(`${f.file}.tmp`, data);
    await rename(`${f.file}.tmp`, f.file);
    this.db.prepare('UPDATE stored_files SET size = ? WHERE id = ?').run(data.length, id);
    return { ...f.meta, size: data.length };
  }

  /** Swap a file with the version before its last rewrite. Null when there is no file, or no earlier version of it. */
  async revert(ownerId: string, id: string): Promise<StoredFile | null> {
    const f = this.get(ownerId, id);
    const prev = f && this.previousPath(f.file);
    if (!f || !prev || !existsSync(prev)) return null;
    await rename(f.file, `${f.file}.tmp`);
    await rename(prev, f.file);
    await rename(`${f.file}.tmp`, prev);
    const size = (await stat(f.file)).size;
    this.db.prepare('UPDATE stored_files SET size = ? WHERE id = ?').run(size, id);
    return { ...f.meta, size };
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM stored_files WHERE id = ? AND owner_id = ?').run(id, ownerId);
    if (!r.changes) return false;
    await rm(path.join(this.dir, id), { force: true });
    await rm(path.join(this.dir, `${id}.prev`), { force: true });
    return true;
  }
}
