// Worker process for one app-change job: `node server/agent/worker.ts <jobId>`.
//
// Steps: make sure the source tree is a git checkout (production has no .git) → snapshot the tree → run
// Claude Code with the job's spec (or apply the original change's patch in reverse for a revert) → verify
// with typecheck and tests → in production rebuild the client and ask the server to restart → publish the
// change to GitHub as a pull request that is merged at once → record the change. Progress goes to the
// agent_jobs table. Launched detached by JobRunner so it survives the server restarting.
import '../env.ts';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { openDb } from '../db.ts';
import { Git, GitHub, githubConfig } from './git.ts';
import { JobStore, REPO_ROOT, type JobRecord } from './jobs.ts';

const run = promisify(execFile);

const TIMEOUT_MS = 25 * 60 * 1000;
/** How many times the coding agent is sent back to fix failing checks. */
const MAX_FIX_ROUNDS = 2;
const MAX_CODING_TURNS = 150;
const CHANGELOG = 'CHANGELOG.md';

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

const production = process.env.NODE_ENV === 'production';
/** The server runs under server/supervise.ts and can be asked to restart. */
const supervised = process.env.SUPERVISED === '1' && !!process.env.AGENT_SERVER_PID;
const github = githubConfig();
const git = new Git(REPO_ROOT);

const log = (line: string) => {
  console.log(`[${new Date().toISOString()}] ${line}`);
  store.appendLog(jobId, line);
};

const RULES = `## Requirements

- Make the smallest change that fully implements the request, following the patterns in CLAUDE.md and the existing code.
- Add or update tests for what you change.
- Run \`npm run typecheck\` and \`npm test\`, and fix any failures before you finish.
- Do not commit. Leave the changes in the working tree.
- Do not modify ${CHANGELOG}, files under data/, any .env file, server/auth.ts, or anything under server/agent/ other than tools.ts and prompt.ts.
- When you are done, reply with only a short summary (two to four sentences) of what you changed. Name any new assistant tool and say what it does and what its inputs are. This summary is shown to the user and given to the assistant so it can use the new capability.`;

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

try {
  store.setStatus(jobId, 'coding', { pid: process.pid });
  const original = job.kind === 'revert' && job.revertsJobId ? store.get(job.revertsJobId) : null;
  if (job.kind === 'revert' && !original) throw new Error('The change to revert no longer exists.');

  // 1. A git checkout to work in. In production the container has the deployed files but no .git.
  if (github) {
    const hub = new GitHub(github);
    await git.ensureRepo(hub.remoteUrl, process.env.RAILWAY_GIT_COMMIT_SHA);
    if (await git.syncMain({ url: hub.remoteUrl, token: github.token })) log('Source tree matches the latest main.');
  } else if (!git.hasRepo()) {
    throw new Error('The source tree is not a git repository and GITHUB_TOKEN is not set, so changes could not be recorded.');
  }
  const before = await git.snapshotTree();

  // 2. Make the change.
  let summary = '';
  let cost = 0;
  let sessionId: string | undefined;
  if (job.kind === 'revert') {
    summary = await revert(original!);
  } else {
    const outcome = await code(changePrompt(job));
    if (outcome.aborted) throw new Error('The job took too long and was stopped.');
    ({ summary, cost, sessionId } = outcome);
  }

  // 3. Verify, sending the coding agent back to fix failures.
  for (let round = 0; ; round++) {
    store.setStatus(jobId, 'verifying');
    const problem = await verify();
    if (!problem) break;
    if (round >= MAX_FIX_ROUNDS) throw new Error(`The checks failed after the change:\n${problem}`);
    log('Checks failed; asking the coding agent to fix them…');
    store.setStatus(jobId, 'coding');
    const fix = await code(fixPrompt(problem), sessionId);
    if (fix.aborted) throw new Error('The job took too long and was stopped.');
    summary = fix.summary || summary;
    sessionId = fix.sessionId ?? sessionId;
    cost += fix.cost;
  }

  // 4. What changed, as the record for the Changes page and for a later revert.
  const after = await git.snapshotTree();
  const files = await git.changedFiles(before, after);
  const patch = files.length ? await git.diff(before, after) : '';
  log(files.length ? `Changed ${files.length} file${files.length === 1 ? '' : 's'}.` : 'No files were changed.');
  summary = summary || (job.kind === 'revert' ? `Reverted "${original!.title}".` : 'The change was made.');
  store.setStatus(jobId, 'verifying', { summary, files, patch, costUsd: cost });

  // 5. Production: rebuild the client and restart the server so the change is live right away.
  if (production) {
    store.setStatus(jobId, 'building');
    log('Building the client…');
    await run('npm', ['run', 'build'], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, signal: abort.signal });
    log('Build finished.');
  }
  if (supervised) {
    store.setStatus(jobId, 'restarting');
    await restartServer();
  }

  // 6. Publish: commit on a branch, push, open a pull request and merge it. The change is already live, so a
  // failure here is recorded on the job rather than failing it.
  if (github) {
    store.setStatus(jobId, 'publishing');
    try {
      await publish(job, original, summary, files);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Publishing failed: ${message}`);
      store.setStatus(jobId, 'done', { error: `The change is live but could not be published to GitHub: ${message}` });
      if (original) store.markReverted(original.id, jobId);
      process.exit();
    }
  } else {
    log('GITHUB_TOKEN is not set; leaving the change uncommitted in the working tree.');
  }

  if (original) store.markReverted(original.id, jobId);
  store.setStatus(jobId, 'done');
  log('Done.');
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  log(`Failed: ${message}`);
  store.setStatus(jobId, 'failed', { error: message });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  // The SDK's CLI subprocess can keep the event loop alive; the job is recorded, so leave explicitly.
  process.exit();
}

// ---------------------------------------------------------------------------
// Coding

/** One Claude Code session (or a resumed one) over the repository. */
async function code(prompt: string, resume?: string): Promise<{ summary: string; sessionId?: string; cost: number; aborted: boolean }> {
  // The coding agent never needs the GitHub token.
  const { GITHUB_TOKEN: _token, ...env } = process.env;
  const options: Options = {
    cwd: REPO_ROOT,
    abortController: abort,
    env: env as Record<string, string>,
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
    ...(resume ? { resume } : {}),
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

${RULES}`;
}

function fixPrompt(problem: string): string {
  return `After your change, the project checks fail. Fix the problems, run \`npm run typecheck\` and \`npm test\` again until both pass, then reply with the same kind of short summary as before.

\`\`\`
${problem.slice(0, 12_000)}
\`\`\``;
}

function revertPrompt(original: JobRecord): string {
  return `Undo an earlier change to this app. The change is described below, with the exact patch it made. Reverse it completely: remove what it added (tools, schemas, labels, tests, UI) and restore what it altered, while keeping anything added since then working. Read CLAUDE.md first for the codebase layout.

## Change to undo: ${original.title}

${original.summary ?? ''}

Files it changed: ${(original.files ?? []).join(', ') || 'unknown'}

## The original patch

\`\`\`diff
${(original.patch ?? '').slice(0, 60_000)}
\`\`\`

${RULES.replace('Name any new assistant tool and say what it does and what its inputs are. ', '')}`;
}

/** Undo an earlier change: apply its patch in reverse, or have the coding agent do it when the code has moved on. */
async function revert(original: JobRecord): Promise<string> {
  if (!original.patch) throw new Error('No patch was recorded for that change, so it cannot be reverted automatically.');
  log(`Reverting "${original.title}"…`);
  try {
    await git.revertPatch(original.patch);
    log('The original patch applied in reverse.');
    return `Reverted "${original.title}" by applying its patch in reverse.`;
  } catch (e) {
    log(`The patch no longer applies cleanly (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); asking the coding agent to undo it.`);
  }
  const outcome = await code(revertPrompt(original));
  if (outcome.aborted) throw new Error('The job took too long and was stopped.');
  store.setStatus(jobId, 'coding', { costUsd: outcome.cost });
  return outcome.summary || `Reverted "${original.title}".`;
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

// ---------------------------------------------------------------------------
// Verify, restart, publish

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

/** Ask the supervised server to restart, then wait until it answers again on its port. */
async function restartServer(): Promise<void> {
  const pid = Number(process.env.AGENT_SERVER_PID);
  const port = process.env.PORT ?? '3001';
  log('Restarting the server…');
  try {
    process.kill(pid, 'SIGUSR2');
  } catch {
    log('The server process was not found; it may already have restarted.');
    return;
  }
  // Wait for it to go away and come back.
  const deadline = Date.now() + 90_000;
  let wentDown = false;
  while (Date.now() < deadline) {
    await sleep(500);
    const up = await healthy(port);
    if (!up) wentDown = true;
    else if (wentDown) {
      log('The server is back with the new code.');
      return;
    }
  }
  log(wentDown ? 'The server did not come back in time.' : 'The server never went down; continuing anyway.');
}

async function healthy(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function publish(job: JobRecord, original: JobRecord | null, summary: string, files: string[]): Promise<void> {
  const hub = new GitHub(github!);
  const branch = `assistant/${job.createdAt.slice(0, 10)}-${slug(job.title)}-${job.id.slice(0, 8)}`;
  const title = job.kind === 'revert' ? `Revert: ${original!.title}` : job.title;
  const record = changeRecord(job, original, summary, files);
  prependChangelog(record);

  log(`Committing on ${branch}…`);
  const commitSha = await git.commitOnBranch(branch, [...files, CHANGELOG], `${title}\n\n${record}\n`, { url: hub.remoteUrl, token: github!.token });
  store.setStatus(jobId, 'publishing', { branch, commitSha });
  try {
    log('Opening a pull request…');
    const pr = await hub.createPullRequest({ branch, title, body: record });
    store.setStatus(jobId, 'publishing', { prNumber: pr.number, prUrl: pr.url });
    log(`Merging pull request #${pr.number}…`);
    const mergedSha = await hub.mergePullRequest(pr.number, `${title} (#${pr.number})`);
    store.setStatus(jobId, 'publishing', { mergedSha });
    await hub.deleteBranch(branch);
    await git.finishBranch(branch, { url: hub.remoteUrl, token: github!.token });
    log(`Merged as ${mergedSha.slice(0, 7)}.`);
  } catch (e) {
    await git.abandonBranch(branch).catch((err) => log(`Could not clean up the branch: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`));
    throw e;
  }
}

/** The assistant's own record of the change: goes into the pull request, the commit and CHANGELOG.md. */
function changeRecord(job: JobRecord, original: JobRecord | null, summary: string, files: string[]): string {
  const lines = [
    job.kind === 'revert' ? `Reverts the change "${original!.title}"${original!.prUrl ? ` (${original!.prUrl})` : ''}.` : summary,
    '',
    `Requested by ${job.requestedBy ?? 'a user'} through the in-app assistant on ${job.createdAt.slice(0, 10)}.`,
  ];
  if (job.kind === 'revert' && summary) lines.splice(1, 0, '', summary);
  else if (job.kind === 'change') lines.push('', '### Request', '', job.spec.trim());
  lines.push('', `Files: ${files.join(', ') || 'none'}`, '', `Job: ${job.id}`);
  return lines.join('\n');
}

function prependChangelog(record: string): void {
  const file = path.join(REPO_ROOT, CHANGELOG);
  const title = job!.kind === 'revert' ? `Revert: ${job!.title}` : job!.title;
  const entry = `## ${job!.createdAt.slice(0, 10)} — ${title}\n\n${record}\n\n`;
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '# Changes made by the assistant\n\nEach entry is written by the app itself when a change requested through the assistant goes live.\n\n';
  }
  const headerEnd = existing.indexOf('\n## ');
  const next = headerEnd >= 0 ? `${existing.slice(0, headerEnd + 1)}${entry}${existing.slice(headerEnd + 1)}` : `${existing.trimEnd()}\n\n${entry}`;
  writeFileSync(file, next);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
