import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Workbook } from '../shared/types.ts';
import { AuthService, SESSION_TTL_MS, validateCredentials, type User } from './auth.ts';
import { openDb } from './db.ts';
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
}

function cleanTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.trim().slice(0, 200);
  return s || null;
}

export async function buildApp(opts: AppOptions) {
  const db = openDb(path.join(opts.dataDir, 'app.db'));
  const auth = new AuthService(db);
  const sheets = new SheetStore(db, path.join(opts.dataDir, 'sheets'));
  await sheets.init();
  auth.purgeExpiredSessions();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 100 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  // Raw file uploads (xlsx import).
  app.addContentTypeParser([XLSX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );

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
