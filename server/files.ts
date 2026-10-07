// Stored files (generated PDFs, uploads). The bytes live next to the sheets as files named by id; the table
// holds the metadata. Files are only readable by their owner.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoredFile } from '../shared/types.ts';
import type { DB } from './db.ts';

interface Row {
  id: string;
  filename: string;
  type: string;
  size: number;
  created_at: string;
}

const toMeta = (r: Row): StoredFile => ({
  id: r.id,
  filename: r.filename,
  type: r.type,
  size: r.size,
  createdAt: r.created_at,
  url: `/api/files/${r.id}`,
  downloadUrl: `/api/files/${r.id}/download`,
});

export class FileStore {
  private db: DB;
  private dir: string;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async create(ownerId: string, filename: string, type: string, data: Buffer): Promise<StoredFile> {
    const id = randomUUID();
    const target = path.join(this.dir, id);
    await writeFile(`${target}.tmp`, data);
    await rename(`${target}.tmp`, target);
    const row = { id, filename, type, size: data.length, created_at: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO stored_files (id, owner_id, filename, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, filename, type, data.length, row.created_at);
    return toMeta(row);
  }

  /** The user's files, most recent first. */
  list(ownerId: string): StoredFile[] {
    const rows = this.db.prepare('SELECT id, filename, type, size, created_at FROM stored_files WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC').all(ownerId) as unknown as Row[];
    return rows.map(toMeta);
  }

  get(ownerId: string, id: string): { meta: StoredFile; file: string } | null {
    const r = this.db.prepare('SELECT id, filename, type, size, created_at FROM stored_files WHERE id = ? AND owner_id = ?').get(id, ownerId) as unknown as Row | undefined;
    return r ? { meta: toMeta(r), file: path.join(this.dir, id) } : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const r = this.db.prepare('DELETE FROM stored_files WHERE id = ? AND owner_id = ?').run(id, ownerId);
    if (!r.changes) return false;
    await rm(path.join(this.dir, id), { force: true });
    return true;
  }
}
