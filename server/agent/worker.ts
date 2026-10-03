// Worker process for one app-change job: `node server/agent/worker.ts <jobId>`.
// Runs Claude Code (through the Claude Agent SDK) in the repository with the job's spec, then verifies the
// result with typecheck and tests, and records progress in the agent_jobs table. Launched detached by
// JobRunner so it survives the dev server restarting as files change.
import '../env.ts';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { openDb } from '../db.ts';
import { JobStore, REPO_ROOT, type JobRecord } from './jobs.ts';

const run = promisify(execFile);

const TIMEOUT_MS = 25 * 60 * 1000;
/** How many times the coding agent is sent back to fix failing checks. */
const MAX_FIX_ROUNDS = 2;
const MAX_CODING_TURNS = 150;

const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: worker.ts <jobId>');
  process.exit(2);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data'));
const store = new JobStore(openDb(path.join(dataDir, 'app.db')));
const job = store.get(jobId);
if (!job) {
  console.error(`no job ${jobId}`);
  process.exit(2);
}

const log = (line: string) => {
  console.log(`[${new Date().toISOString()}] ${line}`);
  store.appendLog(jobId, line);
};

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

try {
  store.setStatus(jobId, 'coding', { pid: process.pid });
  const dirtyBefore = await dirtyFiles();
  const startedAt = Date.now();
  const outcome = await code(job);
  if (outcome.aborted) throw new Error('The job took too long and was stopped.');

  let summary = outcome.summary;
  let sessionId = outcome.sessionId;
  let cost = outcome.cost;
  for (let round = 0; ; round++) {
    store.setStatus(jobId, 'verifying');
    const problem = await verify();
    if (!problem) break;
    if (round >= MAX_FIX_ROUNDS || !sessionId) throw new Error(`The checks failed after the change:\n${problem}`);
    log('Checks failed; asking the coding agent to fix them…');
    store.setStatus(jobId, 'coding');
    const fix = await code(job, { resume: sessionId, problem });
    if (fix.aborted) throw new Error('The job took too long and was stopped.');
    summary = fix.summary || summary;
    sessionId = fix.sessionId ?? sessionId;
    cost += fix.cost;
  }

  const files = await changedFiles(dirtyBefore, startedAt);
  log(files.length ? `Changed ${files.length} file${files.length === 1 ? '' : 's'}.` : 'No files were changed.');
  store.setStatus(jobId, 'done', { summary: summary || 'The change was made.', files, costUsd: cost });
  log('Done.');
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  log(`Failed: ${message}`);
  store.setStatus(jobId, 'failed', { error: message, files: await changedFiles(new Set(), 0).catch(() => []) });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  // The SDK's CLI subprocess can keep the event loop alive; the job is recorded, so leave explicitly.
  process.exit();
}

/** One Claude Code session (or a resumed one) over the repository. */
async function code(job: JobRecord, opts: { resume?: string; problem?: string } = {}): Promise<{ summary: string; sessionId?: string; cost: number; aborted: boolean }> {
  const prompt = opts.problem ? fixPrompt(opts.problem) : changePrompt(job);
  const options: Options = {
    cwd: REPO_ROOT,
    abortController: abort,
    // Loads CLAUDE.md, which explains the codebase and how to add an assistant tool.
    settingSources: ['project'],
    permissionMode: 'acceptEdits',
    allowedTools: [
      'Read',
      'Edit',
      'Write',
      'MultiEdit',
      'Glob',
      'Grep',
      'Bash(npm run typecheck)',
      'Bash(npm run typecheck:*)',
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npx vitest:*)',
      'Bash(npx tsc:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
    ],
    maxTurns: MAX_CODING_TURNS,
    ...(opts.resume ? { resume: opts.resume } : {}),
  };

  let summary = '';
  let sessionId: string | undefined;
  let cost = 0;
  let failure: string | null = null;
  try {
    for await (const m of query({ prompt, options })) {
      const line = describe(m);
      if (line) log(line);
      if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
      if (m.type === 'result') {
        cost = m.total_cost_usd;
        if (m.subtype === 'success') summary = m.result.trim();
        else failure = m.errors.join('\n') || `The coding agent stopped (${m.subtype.replace(/_/g, ' ')}).`;
      }
    }
  } catch (e) {
    if (abort.signal.aborted) return { summary, sessionId, cost, aborted: true };
    throw e;
  }
  if (abort.signal.aborted) return { summary, sessionId, cost, aborted: true };
  if (failure) throw new Error(failure);
  return { summary, sessionId, cost, aborted: false };
}

function changePrompt(job: JobRecord): string {
  return `You are making a change to this app that its built-in assistant requested on behalf of a user. Read CLAUDE.md first: it explains the codebase and exactly how to add an assistant tool.

## Change requested: ${job.title}

${job.spec}

## Requirements

- Make the smallest change that fully implements the request, following the patterns in CLAUDE.md and the existing code.
- Add or update tests for what you change.
- Run \`npm run typecheck\` and \`npm test\`, and fix any failures before you finish.
- Do not commit. Leave the changes in the working tree.
- Do not modify files under data/, any .env file, server/auth.ts, server/agent/jobs.ts or server/agent/worker.ts.
- When you are done, reply with only a short summary (two to four sentences) of what you changed. Name any new assistant tool and say what it does and what its inputs are. This summary is shown to the user and given to the assistant so it can use the new capability.`;
}

function fixPrompt(problem: string): string {
  return `After your change, the project checks fail. Fix the problems, run \`npm run typecheck\` and \`npm test\` again until both pass, then reply with the same kind of short summary as before.

\`\`\`
${problem.slice(0, 12_000)}
\`\`\``;
}

/** A one-line progress description of a Claude Code message, or null for messages not worth showing. */
function describe(m: SDKMessage): string | null {
  if (m.type === 'system' && m.subtype === 'init') return `Claude Code ${m.claude_code_version} started.`;
  if (m.type !== 'assistant') return null;
  const lines: string[] = [];
  for (const block of m.message.content) {
    if (block.type === 'text') {
      const t = block.text.trim().replace(/\s+/g, ' ');
      if (t) lines.push(t.length > 160 ? `${t.slice(0, 157)}…` : t);
    } else if (block.type === 'tool_use') {
      lines.push(describeTool(block.name, block.input as Record<string, unknown>));
    }
  }
  return lines.length ? lines.join(' ') : null;
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? path.relative(REPO_ROOT, input.file_path) : '';
  switch (name) {
    case 'Read':
      return `Read ${file}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${file}`;
    case 'Write':
      return `Wrote ${file}`;
    case 'Glob':
    case 'Grep':
      return `Searched for ${String(input.pattern ?? '')}`;
    case 'Bash': {
      const cmd = String(input.command ?? '').replace(/\s+/g, ' ');
      return `Ran ${cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd}`;
    }
    default:
      return name;
  }
}

/** Run the project checks; returns the failure output, or null when everything passes. */
async function verify(): Promise<string | null> {
  for (const [label, args] of [
    ['Typecheck', ['run', 'typecheck']],
    ['Tests', ['test']],
  ] as const) {
    log(`${label}: running…`);
    try {
      await run('npm', [...args], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, signal: abort.signal, env: { ...process.env, CI: '1' } });
      log(`${label}: passed.`);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || err.message || 'unknown error';
      log(`${label}: failed.`);
      return `${label} failed:\n${tail(out, 6000)}`;
    }
  }
  return null;
}

/** Files that are modified or new in the working tree. */
async function dirtyFiles(): Promise<Set<string>> {
  const { stdout } = await run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO_ROOT });
  return new Set(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim()),
  );
}

/** Files this job changed: newly dirty since it started, or already dirty but written since it started. */
async function changedFiles(dirtyBefore: Set<string>, startedAt: number): Promise<string[]> {
  const out: string[] = [];
  for (const f of await dirtyFiles()) {
    if (!dirtyBefore.has(f)) out.push(f);
    else if ((statSync(path.join(REPO_ROOT, f), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= startedAt) out.push(f);
  }
  return out.sort();
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}
