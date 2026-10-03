// Jobs that change the app's own source code. The assistant files one (request_app_change); after the turn
// ends the runner starts a detached worker process (server/agent/worker.ts) that drives Claude Code in the
// repository, verifies the result and records progress here. The worker is detached because editing files
// under server/ or shared/ restarts the dev server, and the job must survive that.
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { AgentJob, AgentJobStatus } from '../../shared/agent/protocol.ts';
import type { DB } from '../db.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const ACTIVE: AgentJobStatus[] = ['queued', 'starting', 'coding', 'verifying'];
/** A job that has not reported progress for this long is considered dead. */
const STALE_MS = 30 * 60 * 1000;
const MAX_LOG_LINES = 200;

interface Row {
  id: string;
  user_id: string;
  title: string;
  spec: string;
  status: AgentJobStatus;
  pid: number | null;
  log: string;
  summary: string | null;
  error: string | null;
  files: string | null;
  cost_usd: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  acknowledged_at: string | null;
  updated_at?: string;
}

export interface JobRecord extends AgentJob {
  userId: string;
  spec: string;
  pid: number | null;
}

const now = () => new Date().toISOString();

function toJob(r: Row): JobRecord {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    spec: r.spec,
    status: r.status,
    pid: r.pid,
    log: JSON.parse(r.log) as string[],
    summary: r.summary ?? undefined,
    error: r.error ?? undefined,
    files: r.files ? (JSON.parse(r.files) as string[]) : undefined,
    costUsd: r.cost_usd ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    acknowledged: !!r.acknowledged_at,
  };
}

/** The part of a job the browser sees. */
export function publicJob(j: JobRecord): AgentJob {
  const { userId: _u, spec: _s, pid: _p, ...pub } = j;
  return pub;
}

export class JobStore {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  create(userId: string, title: string, spec: string): JobRecord {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO agent_jobs (id, user_id, title, spec, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, title, spec, 'queued', now());
    return this.get(id)!;
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** The user's most recent job. */
  latest(userId: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** The job that is queued or running, if any. Only one job at a time: they all edit the same working tree. */
  active(): JobRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_jobs WHERE status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`)
      .get(...ACTIVE) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Atomically take the oldest queued job, marking it as starting. */
  claimQueued(): JobRecord | null {
    const row = this.db.prepare("SELECT id FROM agent_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    if (!row) return null;
    const res = this.db.prepare("UPDATE agent_jobs SET status = 'starting', started_at = ? WHERE id = ? AND status = 'queued'").run(now(), row.id);
    return res.changes ? this.get(row.id) : null;
  }

  setStatus(id: string, status: AgentJobStatus, patch: { pid?: number; summary?: string; error?: string; files?: string[]; costUsd?: number } = {}): void {
    const finished = status === 'done' || status === 'failed';
    this.db
      .prepare(
        `UPDATE agent_jobs SET status = ?, pid = COALESCE(?, pid), summary = COALESCE(?, summary), error = COALESCE(?, error),
         files = COALESCE(?, files), cost_usd = COALESCE(?, cost_usd), finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?`,
      )
      .run(status, patch.pid ?? null, patch.summary ?? null, patch.error ?? null, patch.files ? JSON.stringify(patch.files) : null, patch.costUsd ?? null, finished ? 1 : 0, now(), id);
  }

  appendLog(id: string, line: string): void {
    const job = this.get(id);
    if (!job) return;
    const log = [...job.log, line].slice(-MAX_LOG_LINES);
    this.db.prepare('UPDATE agent_jobs SET log = ? WHERE id = ?').run(JSON.stringify(log), id);
  }

  acknowledge(id: string, userId: string): boolean {
    const res = this.db.prepare('UPDATE agent_jobs SET acknowledged_at = ? WHERE id = ? AND user_id = ? AND acknowledged_at IS NULL').run(now(), id, userId);
    return res.changes > 0;
  }
}

/** Starts a job's worker process; returns its pid. Swappable so tests don't run Claude Code. */
export type Launcher = (job: JobRecord) => number | undefined;

export function workerLauncher(dataDir: string): Launcher {
  return (job) => {
    const logDir = path.join(dataDir, 'jobs');
    mkdirSync(logDir, { recursive: true });
    const out = openSync(path.join(logDir, `${job.id}.log`), 'a');
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'worker.ts'), job.id], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, DATA_DIR: dataDir },
    });
    child.unref();
    return child.pid;
  };
}

export class JobRunner {
  private store: JobStore;
  private launch: Launcher;

  constructor(store: JobStore, launch: Launcher) {
    this.store = store;
    this.launch = launch;
  }

  /** Start the next queued job unless one is already running. Called after each assistant turn and at startup. */
  startQueued(): void {
    const active = this.store.active();
    if (active && active.status !== 'queued') return;
    const job = this.store.claimQueued();
    if (!job) return;
    try {
      const pid = this.launch(job);
      this.store.setStatus(job.id, 'starting', pid === undefined ? {} : { pid });
      this.store.appendLog(job.id, 'Starting the coding agent…');
    } catch (e) {
      this.store.setStatus(job.id, 'failed', { error: `Could not start the coding agent: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  /** On startup: fail jobs whose worker is gone (the machine or process died), then start anything queued. */
  reconcile(): void {
    const job = this.store.active();
    if (job && job.status !== 'queued') {
      const alive = job.pid !== null && isAlive(job.pid);
      const stale = Date.now() - new Date(job.startedAt ?? job.createdAt).getTime() > STALE_MS;
      if (!alive || stale) {
        this.store.setStatus(job.id, 'failed', { error: alive ? 'The job took too long and was abandoned.' : 'The coding agent stopped unexpectedly.' });
      }
    }
    this.startQueued();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
