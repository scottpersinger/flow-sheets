import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AgentTurnRequest } from '../shared/agent/protocol.ts';
import { newDeck, validateDeck, type Deck } from '../shared/deck.ts';
import { newDoc, validateDoc, type Doc } from '../shared/doc.ts';
import { importDocx } from './docxImport.ts';
import { CELL_IMAGE_TYPES, MAX_CELL_IMAGE_BYTES, type Workbook } from '../shared/types.ts';
import { AgentError, AgentService, type AgentOptions } from './agent/agent.ts';
import { JobRunner, JobStore, publicJob, workerLauncher, type Launcher } from './agent/jobs.ts';
import { AgentStore } from './agent/store.ts';
import { registerConnectorService } from './agent/tools.ts';
import { ConnectorService, type ConnectorServiceOptions } from './connectors/service.ts';
import { ConnectorError } from './connectors/types.ts';
import { AuthService, RESET_TTL_MS, SESSION_TTL_MS, VERIFY_TTL_MS, validateCredentials, type User } from './auth.ts';
import { openDb } from './db.ts';
import { ImageStore } from './images.ts';
import { googleFromEnv, GoogleLogin, GoogleLoginError, GOOGLE_STATE_TTL_MS, type GoogleOptions } from './googleAuth.ts';
import { mailerFromEnv, type Mailer } from './mail.ts';
import { SheetStore, validateWorkbook } from './sheets.ts';
import { importPptx } from './pptxImport.ts';
import { ImportError, importExcel } from './xlsxImport.ts';

const SESSION_COOKIE = 'sid';
// Ties a Google sign-in callback to the browser that started it (login CSRF).
const GOOGLE_STATE_COOKIE = 'gstate';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    connectors: ConnectorService;
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
  /** Sends email (password reset links). Tests pass a stub; the default comes from the environment. */
  sendMail?: Mailer;
  /** Google sign-in. Defaults to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET; unset leaves the button off. */
  google?: GoogleOptions;
  /** Public origin for links in email, e.g. https://sheets.example.com. Defaults to the request's own origin. */
  appUrl?: string;
  /**
   * Old host names that should redirect (301) to appUrl, keeping the path. Defaults to LEGACY_HOSTS
   * (comma-separated). Lets the app move to a new domain while old links keep working.
   */
  legacyHosts?: string[];
  /** Connector overrides (tests pass a fake fetch). */
  connectors?: Partial<Omit<ConnectorServiceOptions, 'keyFile'>>;
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
  const sendMail = opts.sendMail ?? mailerFromEnv((msg) => app.log.info(msg));
  const googleOpts = opts.google ?? googleFromEnv();
  const google = googleOpts ? new GoogleLogin(googleOpts) : null;
  // Emails sent per kind and address (password resets, verification links), to keep the mailbox and the
  // mailer quiet under abuse: at most 5 an hour.
  const mailRequests = new Map<string, number[]>();
  const tooManyMails = (kind: string, email: string): boolean => {
    const key = `${kind}:${email.trim().toLowerCase()}`;
    const now = Date.now();
    const recent = (mailRequests.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= 5) return true;
    mailRequests.set(key, [...recent, now]);
    return false;
  };
  const sheets = new SheetStore(db, path.join(opts.dataDir, 'sheets'));
  await sheets.init();
  const images = new ImageStore(db, path.join(opts.dataDir, 'images'));
  await images.init();
  auth.purgeExpiredSessions();
  const connectors = new ConnectorService(db, { keyFile: path.join(opts.dataDir, 'connector.key'), ...opts.connectors });
  // Lets the agent's server tools (list_connections, fetch_connector_data) reach the user's connections.
  registerConnectorService(sheets, connectors);
  const agent = new AgentService(new AgentStore(db), sheets, opts.agent);
  const jobs = new JobStore(db);
  const jobRunner = new JobRunner(jobs, opts.launchJob ?? workerLauncher(opts.dataDir));
  // A previous server process may have died (or been restarted by the job itself) with a job in flight.
  jobRunner.reconcile();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 100 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  // Raw file uploads (xlsx import).
  app.addContentTypeParser([XLSX_MIME, PPTX_MIME, DOCX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  // Raw cell image uploads. Images are stored as files and cells only reference them, so workbook saves
  // (JSON, under the default body limit) stay small however large the images are.
  app.addContentTypeParser(CELL_IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_CELL_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.decorate('connectors', connectors);
  app.decorateRequest('user', null);

  // Requests to a retired host name go to the current one (same path and query).
  const appUrl = (opts.appUrl ?? process.env.APP_URL)?.replace(/\/$/, '');
  const legacyHosts = new Set((opts.legacyHosts ?? process.env.LEGACY_HOSTS?.split(',') ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (appUrl && legacyHosts.size) {
    const current = new URL(appUrl).host.toLowerCase();
    app.addHook('onRequest', async (req, reply) => {
      const host = String(req.headers.host ?? '').toLowerCase();
      if (legacyHosts.has(host) && host !== current) return reply.code(301).redirect(`${appUrl}${req.url}`);
    });
  }

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

  /** Public origin of the app, for links and OAuth redirect URIs. */
  const originOf = (req: FastifyRequest) =>
    (opts.appUrl ?? process.env.APP_URL ?? `${req.headers['x-forwarded-proto'] ?? req.protocol}://${req.headers.host}`).replace(/\/$/, '');

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not signed in' });
  };

  // --- Auth ----------------------------------------------------------------
  /** Email the link that verifies a new account's address. */
  const sendVerification = async (req: FastifyRequest, user: User) => {
    const { token } = auth.createEmailVerification(user.id);
    const link = `${originOf(req)}/verify?token=${token}`;
    const hours = Math.round(VERIFY_TTL_MS / 3600000);
    await sendMail({
      to: user.email,
      subject: 'Verify your email for Sheets',
      text: `Welcome to Sheets! Confirm that ${user.email} is your address by opening this link (it expires in ${hours} hours):\n${link}\n\nIf you didn't create a Sheets account, you can ignore this email.`,
    });
  };

  // Sign-up creates the account but no session: the user is signed in by the link in the verification email.
  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    const problem = validateCredentials(email, password);
    if (problem) return reply.code(400).send({ error: problem });
    if (tooManyMails('verify', email as string)) return reply.code(429).send({ error: 'Too many sign-up attempts for this address. Try again in an hour.' });
    const user = await auth.register(email as string, password as string);
    if (user === 'exists') return reply.code(409).send({ error: 'An account with this email already exists.' });
    try {
      await sendVerification(req, user);
    } catch (e) {
      req.log.error({ err: e }, 'verification email failed');
      return reply.code(500).send({ error: 'The verification email could not be sent. Try again later.' });
    }
    return { pending: true, email: user.email };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Email and password are required.' });
    }
    const user = await auth.login(email, password);
    if (!user) return reply.code(401).send({ error: 'Invalid email or password.' });
    if (user === 'unverified') {
      return reply.code(403).send({ error: 'Please verify your email address first. Check your inbox for the link we sent you.', code: 'unverified' });
    }
    setSessionCookie(reply, user.id);
    return { user };
  });

  // Send the verification link again. Always answers OK so the response doesn't reveal account state.
  app.post('/api/auth/verify/resend', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || !email.trim()) return reply.code(400).send({ error: 'Please enter your email address.' });
    if (tooManyMails('verify', email)) return reply.code(429).send({ error: 'Too many verification emails for this address. Try again in an hour.' });
    const user = auth.unverifiedUser(email);
    if (user) {
      try {
        await sendVerification(req, user);
      } catch (e) {
        req.log.error({ err: e }, 'verification email failed');
        return reply.code(500).send({ error: 'The verification email could not be sent. Try again later.' });
      }
    }
    return { ok: true };
  });

  // The emailed link opens /verify, which posts the token here; a good token signs the user in.
  app.post('/api/auth/verify', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: unknown };
    const user = typeof token === 'string' ? auth.verifyEmail(token) : null;
    if (!user) return reply.code(400).send({ error: 'This verification link is invalid or has expired. Sign in to request a new one.' });
    setSessionCookie(reply, user.id);
    return { user };
  });

  // Password reset: always answers OK so the response doesn't reveal whether an account exists.
  app.post('/api/auth/forgot', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: unknown };
    if (typeof email !== 'string' || !email.trim()) return reply.code(400).send({ error: 'Please enter your email address.' });
    if (tooManyMails('reset', email)) return reply.code(429).send({ error: 'Too many reset requests for this address. Try again in an hour.' });

    const reset = auth.createPasswordReset(email);
    if (reset) {
      const link = `${originOf(req)}/reset?token=${reset.token}`;
      const minutes = Math.round(RESET_TTL_MS / 60000);
      try {
        await sendMail({
          to: reset.user.email,
          subject: 'Reset your Sheets password',
          text: `Someone asked to reset the password for ${reset.user.email} on Sheets.\n\nSet a new password here (the link works once and expires in ${minutes} minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email; your password stays the same.`,
        });
      } catch (e) {
        req.log.error({ err: e }, 'password reset email failed');
        return reply.code(500).send({ error: 'The reset email could not be sent. Try again later.' });
      }
    }
    return { ok: true };
  });

  app.get('/api/auth/reset', async (req, reply) => {
    const { token } = req.query as { token?: string };
    const user = typeof token === 'string' ? auth.userForResetToken(token) : null;
    if (!user) return reply.code(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
    return { email: user.email };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: unknown; password?: unknown };
    if (typeof token !== 'string') return reply.code(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
    const problem = validateCredentials('reset@example.com', password);
    if (problem) return reply.code(400).send({ error: problem });
    const user = await auth.resetPassword(token, password as string);
    if (!user) return reply.code(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
    setSessionCookie(reply, user.id);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) auth.destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user, googleLogin: !!google }));

  // Google sign-in: send the browser to Google; it comes back to the callback, which signs the user in.
  app.get('/api/auth/google/start', async (req, reply) => {
    if (!google) return reply.code(404).send({ error: 'Google sign-in is not set up on this server.' });
    const { next } = req.query as { next?: string };
    const { url, state } = google.start(`${originOf(req)}/api/auth/google/callback`, next);
    reply.setCookie(GOOGLE_STATE_COOKIE, state, {
      path: '/api/auth/google',
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      maxAge: GOOGLE_STATE_TTL_MS / 1000,
    });
    return reply.redirect(url);
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const fail = (message: string) => reply.redirect(`/login?error=${encodeURIComponent(message)}`);
    if (!google) return fail('Google sign-in is not set up on this server.');
    const q = req.query as { state?: string; code?: string; error?: string };
    const expected = req.cookies[GOOGLE_STATE_COOKIE];
    reply.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/auth/google' });
    if (q.error === 'access_denied') return fail('The Google sign-in was cancelled.');
    if (q.error || !q.state || !q.code) return fail('Google sign-in failed. Try again.');
    if (!expected || expected !== q.state) return fail('This sign-in link is invalid or has expired. Try again.');
    try {
      const { identity, next } = await google.finish(q.state, q.code);
      const user = auth.loginWithGoogle(identity);
      if (user === 'unverified') return fail("Your Google account's email address isn't verified, so it can't be used to sign in.");
      setSessionCookie(reply, user.id);
      return reply.redirect(next);
    } catch (e) {
      if (e instanceof GoogleLoginError) return fail(e.message);
      req.log.error({ err: e }, 'google sign-in failed');
      return fail('Google sign-in failed. Try again.');
    }
  });

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
      const source = sheets.get(req.user!.id, id, 'sheet');
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
      const meta = sheets.rename(req.user!.id, id, title, 'sheet');
      if (!meta) return reply.code(404).send({ error: 'Sheet not found' });
      return { sheet: meta };
    });

    r.delete('/api/sheets/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'sheet'))) return reply.code(404).send({ error: 'Sheet not found' });
      return { ok: true };
    });
  });

  // --- Text documents ------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/docs', async (req) => ({ docs: sheets.list(req.user!.id, 'doc') }));

    r.post('/api/docs', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; doc?: unknown };
      const title = cleanTitle(body.title) ?? 'Untitled document';
      const doc = body.doc === undefined ? newDoc() : body.doc;
      const problem = validateDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      return { doc: await sheets.createDoc(req.user!.id, title, doc as Doc) };
    });

    r.get('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.loadDoc(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Document not found' });
      return { meta: res.meta, doc: res.doc };
    });

    r.put('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const doc = (req.body as { doc?: unknown } | undefined)?.doc;
      const problem = validateDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      const meta = await sheets.saveDoc(req.user!.id, id, doc as Doc);
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.patch('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'doc');
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.delete('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'doc'))) return reply.code(404).send({ error: 'Document not found' });
      return { ok: true };
    });

    /** Convert an uploaded .docx body; sends a 400 and returns null on failure. Pictures are stored for the user. */
    const convertDocx = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400).send({ error: 'Upload a Word document (.docx) as the request body.' });
        return null;
      }
      try {
        return await importDocx(body, (type, data) => images.create(req.user!.id, type, data));
      } catch (e) {
        if (!(e instanceof ImportError)) req.log.warn({ err: e }, 'docx import failed');
        reply.code(400).send({ error: e instanceof ImportError ? e.message : 'This file could not be imported. Make sure it is a valid Word document (.docx).' });
        return null;
      }
    };

    // Import as a brand-new document.
    r.post('/api/docs/import', async (req, reply) => {
      const result = await convertDocx(req, reply);
      if (!result) return reply;
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported document';
      const doc = await sheets.createDoc(req.user!.id, title, result.doc);
      return { doc, warnings: result.warnings };
    });

    // Convert only (nothing is stored but the pictures); the client adds the blocks to an open document.
    r.post('/api/import/docx', async (req, reply) => {
      const result = await convertDocx(req, reply);
      if (!result) return reply;
      return result;
    });
  });

  // --- Slide decks ---------------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/decks', async (req) => ({ decks: sheets.list(req.user!.id, 'deck') }));

    r.post('/api/decks', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; deck?: unknown };
      const title = cleanTitle(body.title) ?? 'Untitled presentation';
      const deck = body.deck === undefined ? newDeck() : body.deck;
      const problem = validateDeck(deck);
      if (problem) return reply.code(400).send({ error: problem });
      return { deck: await sheets.createDeck(req.user!.id, title, deck as Deck) };
    });

    r.get('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.loadDeck(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta: res.meta, deck: res.deck };
    });

    r.put('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const deck = (req.body as { deck?: unknown } | undefined)?.deck;
      const problem = validateDeck(deck);
      if (problem) return reply.code(400).send({ error: problem });
      const meta = await sheets.saveDeck(req.user!.id, id, deck as Deck);
      if (!meta) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta };
    });

    r.patch('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'deck');
      if (!meta) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta };
    });

    r.delete('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'deck'))) return reply.code(404).send({ error: 'Presentation not found' });
      return { ok: true };
    });

    /** Convert an uploaded .pptx body; sends a 400 and returns null on failure. Pictures are stored for the user. */
    const convertPptx = async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        reply.code(400).send({ error: 'Upload a PowerPoint file (.pptx) as the request body.' });
        return null;
      }
      try {
        return await importPptx(body, (type, data) => images.create(req.user!.id, type, data));
      } catch (e) {
        if (!(e instanceof ImportError)) req.log.warn({ err: e }, 'pptx import failed');
        reply.code(400).send({ error: e instanceof ImportError ? e.message : 'This file could not be imported. Make sure it is a valid PowerPoint presentation (.pptx).' });
        return null;
      }
    };

    // Import as a brand-new presentation.
    r.post('/api/decks/import', async (req, reply) => {
      const result = await convertPptx(req, reply);
      if (!result) return reply;
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported presentation';
      const deck = await sheets.createDeck(req.user!.id, title, result.deck);
      return { deck, warnings: result.warnings };
    });

    // Convert only (nothing is stored but the pictures); the client adds the slides to an open presentation.
    r.post('/api/import/pptx', async (req, reply) => {
      const result = await convertPptx(req, reply);
      if (!result) return reply;
      return result;
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

  // --- Connectors (external data sources) ---------------------------------------
  const connectorStatus = (e: ConnectorError) => (e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'unavailable' ? 502 : 400);
  /** Run a connector call, answering ConnectorErrors with their (credential-free) message. */
  const connectorCall = async <T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConnectorError) return reply.code(connectorStatus(e)).send({ error: e.message, code: e.code });
      throw e;
    }
  };
  const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const oauthRedirectUri = (req: FastifyRequest) => `${originOf(req)}/api/connectors/oauth/callback`;

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/connectors', async () => ({ connectors: connectors.connectorInfo() }));
    r.get('/api/connections', async (req) => ({ connections: connectors.list(req.user!.id) }));

    r.post('/api/connections', async (req, reply) => {
      const body = asRecord(req.body);
      return connectorCall(reply, async () => ({
        connection: await connectors.create(req.user!.id, {
          connector: String(body.connector ?? ''),
          name: typeof body.name === 'string' ? body.name : undefined,
          fields: asRecord(body.fields),
        }),
      }));
    });

    // Test credentials before saving them; with an id, blank secret fields use the saved ones.
    r.post('/api/connections/test', async (req, reply) => {
      const body = asRecord(req.body);
      return connectorCall(reply, async () => {
        const id = typeof body.id === 'string' && body.id ? { userId: req.user!.id, id: body.id } : undefined;
        const connector = id ? (connectors.get(id.userId, id.id)?.connector ?? '') : String(body.connector ?? '');
        await connectors.testCredentials(connector, asRecord(body.fields), id);
        return { ok: true };
      });
    });

    r.patch('/api/connections/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = asRecord(req.body);
      return connectorCall(reply, async () => {
        const connection = await connectors.update(req.user!.id, id, {
          name: typeof body.name === 'string' ? body.name : undefined,
          fields: body.fields ? asRecord(body.fields) : undefined,
        });
        return connection ? { connection } : reply.code(404).send({ error: 'Connection not found' });
      });
    });

    r.delete('/api/connections/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!connectors.delete(req.user!.id, id)) return reply.code(404).send({ error: 'Connection not found' });
      return { ok: true };
    });

    r.post('/api/connections/:id/test', async (req, reply) => {
      const { id } = req.params as { id: string };
      return connectorCall(reply, async () => ({ connection: await connectors.test(req.user!.id, id) }));
    });

    // Run a dataset query (or return an earlier result by handle); used by the ingest_connector_data tool.
    r.post('/api/connections/:id/fetch', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = asRecord(req.body);
      return connectorCall(reply, async () => {
        const cached = typeof body.handle === 'string' ? connectors.cachedResult(req.user!.id, body.handle) : null;
        return cached ?? (await connectors.fetch(req.user!.id, id, String(body.dataset ?? ''), body.params ?? {}));
      });
    });

    // OAuth 2.0: send the browser to the provider's consent page; it comes back to the callback below.
    r.get('/api/connectors/:connector/oauth/start', async (req, reply) => {
      const { connector } = req.params as { connector: string };
      const { name } = req.query as { name?: string };
      try {
        return reply.redirect(connectors.oauthStart(req.user!.id, connector, name, oauthRedirectUri(req)));
      } catch (e) {
        if (e instanceof ConnectorError) return reply.redirect(`/connectors?error=${encodeURIComponent(e.message)}`);
        throw e;
      }
    });

    r.get('/api/connectors/oauth/callback', async (req, reply) => {
      const q = req.query as { state?: string; code?: string; error?: string; error_description?: string };
      if (q.error || !q.state || !q.code) {
        return reply.redirect(`/connectors?error=${encodeURIComponent(q.error_description || q.error || 'The sign-in was cancelled.')}`);
      }
      try {
        const connection = await connectors.oauthCallback(req.user!.id, q.state, q.code);
        return reply.redirect(`/connectors?connected=${encodeURIComponent(connection.id)}`);
      } catch (e) {
        if (e instanceof ConnectorError) return reply.redirect(`/connectors?error=${encodeURIComponent(e.message)}`);
        throw e;
      }
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
    // A change to the app (kind "change") or a research task (kind "research"), both run by the worker.
    r.post('/api/agent/jobs', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; spec?: unknown; kind?: unknown; sheetId?: unknown };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const spec = typeof body.spec === 'string' ? body.spec.trim() : '';
      if (!title || !spec) return reply.code(400).send({ error: 'A title and a spec are required.' });
      const kind = body.kind === 'research' ? 'research' : 'change';
      let sheetId: string | undefined;
      if (kind === 'research' && typeof body.sheetId === 'string' && body.sheetId) {
        if (!sheets.get(req.user!.id, body.sheetId, 'sheet')) return reply.code(404).send({ error: 'Sheet not found' });
        sheetId = body.sheetId;
      }
      const active = jobs.active();
      if (active) return reply.code(409).send({ error: `A job is already in progress: "${active.title}". Wait for it to finish.` });
      return { job: publicJob(jobs.create(req.user!.id, title.slice(0, 120), spec.slice(0, 8000), { kind, sheetId, requestedBy: req.user!.email })) };
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
