// Cell images uploaded or pasted by users. The bytes are stored as files next to the sheets, so a cell only
// holds a short "/api/images/<id>" reference: large images don't bloat autosaves, undo history or the
// workbook JSON. Images are only readable by the user who uploaded them.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CELL_IMAGE_TYPES } from '../shared/types.ts';
import type { DB } from './db.ts';

export class ImageStore {
  private db: DB;
  private dir: string;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Store an image; returns its URL. */
  async create(ownerId: string, type: string, data: Buffer): Promise<string> {
    if (!CELL_IMAGE_TYPES.includes(type)) throw new Error(`Unsupported image type ${type}`);
    const id = randomUUID();
    const target = path.join(this.dir, id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
    this.db
      .prepare('INSERT INTO images (id, owner_id, type, size, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ownerId, type, data.length, new Date().toISOString());
    return `/api/images/${id}`;
  }

  /** The file and content type of one of the user's images, or null. */
  get(ownerId: string, id: string): { file: string; type: string } | null {
    const r = this.db.prepare('SELECT type FROM images WHERE id = ? AND owner_id = ?').get(id, ownerId) as { type: string } | undefined;
    return r ? { file: path.join(this.dir, id), type: r.type } : null;
  }
}
