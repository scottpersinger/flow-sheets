import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS sheets (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sheets_owner ON sheets(owner_id, updated_at);
  `);
  migrate(db);
  return db;
}

/** Additive schema changes for databases created by earlier versions. */
function migrate(db: DB): void {
  const cols = new Set((db.prepare('PRAGMA table_info(sheets)').all() as { name: string }[]).map((c) => c.name));
  // Branches: parent_id deliberately has no foreign key, so deleting the original leaves its branches "detached".
  if (!cols.has('parent_id')) db.exec('ALTER TABLE sheets ADD COLUMN parent_id TEXT');
  if (!cols.has('parent_title')) db.exec('ALTER TABLE sheets ADD COLUMN parent_title TEXT');
  if (!cols.has('branched_at')) db.exec('ALTER TABLE sheets ADD COLUMN branched_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS sheets_parent ON sheets(parent_id)');
}
