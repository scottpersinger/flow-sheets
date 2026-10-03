import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentTurnRequest } from '../shared/agent/protocol.ts';
import { CELL_IMAGE_TYPES, MAX_CELL_IMAGE_BYTES, type Workbook } from '../shared/types.ts';
import { AgentError, AgentService, type AgentOptions } from './agent/agent.ts';
import { JobRunner, JobStore, publicJob, workerLauncher, type Launcher } from './agent/jobs.ts';
import { AgentStore } from './agent/store.ts';
import { AuthService, SESSION_TTL_MS, validateCredentials, type User } from './auth.ts';
import { openDb } from './db.ts';
import { ImageStore } from './images.ts';
import { SheetStore, validateWorkbook } from './sheets.ts';
import { ImportError, importExcel } from './xlsxImport.ts';

const SESSION_COOKIE = 'sid';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AppOptions {
  dataDir: string;
  staticDir?: string;
  secureCookies?: boolean;
  logger?: boolean;
  agent?: AgentOptions;
  /** Starts the worker for an app-change job. Tests pass a stub; the default runs server/agent/worker.ts. */
  launchJob?: Launcher;
}

function cleanTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.trim().slice(0, 200);
  return s || null;
}

function agentErrorMessage(e: unknown): string {
  if (e instanceof AgentError) return e.message;
  if (e instanceof Anthropic.RateLimitError) return 'The assistant is getting too many requests right now. Try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError) return 'The assistant is not configured correctly on this server (API key).';
  if (e instanceof Anthropic.APIError && e.status && e.status >= 500) return 'The AI service had a problem. Try again in a moment.';
  if (e instanceof Anthropic.AnthropicError && /api ?key|authentication/i.test(e.message)) return 'The assistant is not configured on this server (no API key).';
  return 'Something went wrong while the assistant was working. Try again.';
}

export async function buildApp(opts: AppOptions) {
  const db = openDb(path.join(opts.dataDir, 'app.db'));
  const auth = new AuthService(db);
  const sheets = new SheetStore(db, path.join(opts.dataDir, 'sheets'));
  await sheets.init();
  const images = new ImageStore(db, path.join(opts.dataDir, 'images'));
  await images.init();
  auth.purgeExpiredSessions();
  const agent = new AgentService(new AgentStore(db), sheets, opts.agent);
  const jobs = new JobStore(db);
  const jobRunner = new JobRunner(jobs, opts.launchJob ?? workerLauncher(opts.dataDir));
  // A previous server process may have died (or been restarted by the job itself) with a job in flight.
  jobRunner.reconcile();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 100 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  // Raw file uploads (xlsx import).
  app.addContentTypeParser([XLSX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  // Raw cell image uploads. Images are stored as files and cells only reference them, so workbook saves
  // (JSON, under the default body limit) stay small however large the images are.
  app.addContentTypeParser(CELL_IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_CELL_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    req.user = auth.userForSession(req.cookies[SESSION_COOKIE]);
  });
  app.addHook('onClose', async () => db.close());

  const setSessionCookie = (reply: FastifyReply, userId: string) => {
    const { token } = auth.createSession(userId);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      maxAge: SESSION_TTL_MS / 1000,
    });
  };

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
  };

  // --- Auth ----------------------------------------------------------------
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const problem = validateCredentials(email, password);
    if (problem) return reply.code(400).send({ error: problem });
    const user = await auth.register(email as string, password as string);
    if (user === 'exists') return reply.code(409).send({ error: 'An account with this email already exists.' });
    setSessionCookie(reply, user.id);
    return { user };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Email and password are required.' });
    }
    const user = await auth.login(email, password);
    if (!user) return reply.code(401).send({ error: 'Invalid email or password.' });
    setSessionCookie(reply, user.id);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) auth.destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  // Liveness/readiness for the hosting platform: verifies the database is reachable.
  app.get('/api/health', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // --- Sheets ----------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/sheets', async (req) => ({ sheets: sheets.list(req.user!.id) }));

    r.post('/api/sheets', async (req) => {
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title) ?? 'Untitled spreadsheet';
      return { sheet: await sheets.create(req.user!.id, title) };
    });

    /** Parse an uploaded .xlsx body; sends a 400 and returns null on failure. */
    const convertUpload = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400).send({ error: 'Upload an Excel file (.xlsx or .xls) as the request body.' });
        return null;
      }
      let result;
      try {
        result = await importExcel(body);
      } catch (e) {
        if (!(e instanceof ImportError)) req.log.warn({ err: e }, 'xlsx import failed');
        const msg = e instanceof ImportError ? e.message : 'This file could not be imported. Make sure it is a valid Excel workbook (.xlsx or .xls).';
        reply.code(400).send({ error: msg });
        return null;
      }
      const problem = validateWorkbook(result.workbook);
      if (problem) {
        reply.code(400).send({ error: `Import produced an invalid workbook: ${problem}` });
        return null;
      }
      return result;
    };

    // Import as a brand-new spreadsheet.
    r.post('/api/sheets/import', async (req, reply) => {
      const result = await convertUpload(req, reply);
      if (!result) return reply;
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported spreadsheet';
      const sheet = await sheets.create(req.user!.id, title, result.workbook);
      return { sheet, warnings: result.warnings };
    });

    // Convert only (nothing is stored); the client adds the tabs to an open spreadsheet.
    r.post('/api/import/xlsx', async (req, reply) => {
      const result = await convertUpload(req, reply);
      if (!result) return reply;
      return result;
    });

    r.get('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.load(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: res.meta, workbook: res.workbook };
    });

    // Branch: a copy that stays connected to its original for comparison.
    r.post('/api/sheets/:id/branch', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      const source = sheets.get(req.user!.id, id);
      if (!source) return reply.code(404).send({ error: 'Sheet not found' });
      const sheet = await sheets.branch(req.user!.id, id, title ?? `${source.title} (branch)`);
      return { sheet };
    });

    r.get('/api/sheets/:id/compare', async (req, reply) => {
      const { id } = req.params as { id: string };
      const data = await sheets.compareData(req.user!.id, id);
      if (data === null) return reply.code(404).send({ error: 'Sheet not found' });
      if (data === 'not-branch') return reply.code(400).send({ error: 'This spreadsheet is not a branch.' });
      return data;
    });

    r.put('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const workbook = (req.body as { workbook?: Workbook } | undefined)?.workbook;
      const problem = validateWorkbook(workbook);
      if (problem) return reply.code(400).send({ error: problem });
      const meta = await sheets.save(req.user!.id, id, workbook!);
      if (!meta) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: meta };
    });

    r.patch('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title);
      if (!meta) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: meta };
    });

    r.delete('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id))) return reply.code(404).send({ error: 'Sheet not found' });
      return { ok: true };
    });
  });

  // --- Cell images -------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // Upload an image (the raw file as the body, with its image/* content type); returns its URL for a cell.
    r.post('/api/images', async (req, reply) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const body = req.body;
      if (!CELL_IMAGE_TYPES.includes(type) || !Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'Upload a PNG, JPEG, GIF or WebP image as the request body.' });
      }
      return { url: await images.create(req.user!.id, type, body) };
    });

    r.get('/api/images/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const img = /^[0-9a-f-]{36}$/.test(id) ? images.get(req.user!.id, id) : null;
      if (!img) return reply.code(404).send({ error: 'Image not found' });
      // Images never change once uploaded.
      reply.header('Content-Type', img.type).header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff');
      return reply.send(createReadStream(img.file));
    });
  });

  // --- Agent ---------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/agent', async (req) => ({ items: agent.transcript(req.user!.id) }));

    r.post('/api/agent/reset', async (req, reply) => {
      try {
        agent.reset(req.user!.id);
      } catch (e) {
        if (e instanceof AgentError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      return { ok: true };
    });

    // Runs or resumes a turn, streaming AgentEvents as server-sent events.
    r.post('/api/agent/turn', async (req, reply) => {
      const body = (req.body ?? {}) as AgentTurnRequest;
      try {
        agent.checkTurn(req.user!.id, body);
      } catch (e) {
        if (e instanceof AgentError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const abort = new AbortController();
      // The browser stopped the request (Stop button, navigation): abort the model call too.
      res.on('close', () => {
        if (!res.writableEnded) abort.abort();
      });
      const emit = (e: AgentEvent) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      try {
        await agent.runTurn(req.user!.id, body, emit, abort.signal);
      } catch (e) {
        if (!abort.signal.aborted) {
          req.log.error({ err: e }, 'agent turn failed');
          emit({ type: 'error', message: agentErrorMessage(e) });
        }
      } finally {
        res.end();
        // Jobs queued during the turn start only now: the worker's edits restart the dev server, which would
        // cut off a reply still streaming.
        jobRunner.startQueued();
      }
    });

    // --- App-change jobs (self-improvement) ---
    r.post('/api/agent/jobs', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; spec?: unknown };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const spec = typeof body.spec === 'string' ? body.spec.trim() : '';
      if (!title || !spec) return reply.code(400).send({ error: 'A title and a spec are required.' });
      const active = jobs.active();
      if (active) return reply.code(409).send({ error: `A change is already in progress: "${active.title}". Wait for it to finish.` });
      return { job: publicJob(jobs.create(req.user!.id, title.slice(0, 120), spec.slice(0, 8000), { requestedBy: req.user!.email })) };
    });

    // The app's change history, for the Changes page.
    r.get('/api/agent/jobs', async () => ({ jobs: jobs.list().map(publicJob) }));

    // Undo a change: a job that applies its patch in reverse (or has the coding agent undo it), then goes
    // through the same verify, restart and publish steps. Starts right away; nothing is streaming to this user.
    r.post('/api/agent/jobs/:id/revert', async (req, reply) => {
      const { id } = req.params as { id: string };
      const target = jobs.get(id);
      if (!target) return reply.code(404).send({ error: 'Change not found' });
      if (target.kind !== 'change') return reply.code(400).send({ error: 'Only changes can be reverted, not reverts.' });
      if (target.status !== 'done') return reply.code(400).send({ error: 'Only a finished change can be reverted.' });
      if (target.revertedByJobId) return reply.code(400).send({ error: 'That change has already been reverted.' });
      const active = jobs.active();
      if (active) return reply.code(409).send({ error: `A change is already in progress: "${active.title}". Wait for it to finish.` });
      const job = jobs.create(req.user!.id, target.title, `Revert the change "${target.title}" (job ${target.id}).`, {
        kind: 'revert',
        requestedBy: req.user!.email,
        revertsJobId: target.id,
      });
      jobRunner.startQueued();
      return { job: publicJob(jobs.get(job.id)!) };
    });

    r.get('/api/agent/jobs/latest', async (req) => {
      const job = jobs.latest(req.user!.id);
      return { job: job ? publicJob(job) : null };
    });

    r.post('/api/agent/jobs/:id/ack', async (req, reply) => {
      const { id } = req.params as { id: string };
      const job = jobs.get(id);
      if (!job || job.userId !== req.user!.id) return reply.code(404).send({ error: 'Job not found' });
      jobs.acknowledge(id, req.user!.id);
      return { ok: true };
    });
  });

  // --- Static client (production) ----------------------------------------------
  if (opts.staticDir && existsSync(opts.staticDir)) {
    await app.register(fastifyStatic, { root: opts.staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
