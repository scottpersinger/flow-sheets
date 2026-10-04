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

    -- Password reset links: the token is emailed, only its hash is stored. One use, short expiry.
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
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

    -- Cell images uploaded or pasted by a user; the bytes are stored as files (see server/images.ts).
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    -- Agent chat. Each user has one active conversation (ended_at IS NULL); resetting ends it and starts a new one.
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      -- JSON: tool calls of the last assistant message that still need results (see server/agent/store.ts).
      pending TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_conversations_user ON agent_conversations(user_id, ended_at);

    -- Messages exactly as sent to the Claude API, append-only.
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_conv ON agent_messages(conversation_id, id);

    -- Changes to the app's own code requested through the assistant, run by server/agent/worker.ts.
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      -- queued | starting | coding | verifying | done | failed
      status TEXT NOT NULL,
      pid INTEGER,
      -- JSON array of progress lines
      log TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      error TEXT,
      -- JSON array of changed file paths
      files TEXT,
      cost_usd REAL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      -- Set once the browser has shown the outcome to the user (and told the assistant).
      acknowledged_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_jobs_user ON agent_jobs(user_id, created_at);

    -- Connections to external data sources (server/connectors). credentials is AES-256-GCM ciphertext.
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector TEXT NOT NULL,
      name TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      credentials TEXT NOT NULL,
      -- JSON object of non-secret field values
      settings TEXT NOT NULL DEFAULT '{}',
      masked TEXT,
      -- connected | error | needs_reauth
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_usage (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );
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

  // Agent jobs: the record of a change (who asked, what was committed and merged) and revert links.
  const jobCols = new Set((db.prepare('PRAGMA table_info(agent_jobs)').all() as { name: string }[]).map((c) => c.name));
  const jobAdds: [string, string][] = [
    ['kind', "TEXT NOT NULL DEFAULT 'change'"],
    ['requested_by', 'TEXT'],
    ['branch', 'TEXT'],
    ['commit_sha', 'TEXT'],
    ['pr_number', 'INTEGER'],
    ['pr_url', 'TEXT'],
    ['merged_sha', 'TEXT'],
    // The job's changes as a unified diff, so a revert can apply it in reverse.
    ['patch', 'TEXT'],
    ['reverts_job_id', 'TEXT'],
    ['reverted_by_job_id', 'TEXT'],
    ['sheet_id', 'TEXT'],
  ];
  for (const [name, type] of jobAdds) if (!jobCols.has(name)) db.exec(`ALTER TABLE agent_jobs ADD COLUMN ${name} ${type}`);
}
