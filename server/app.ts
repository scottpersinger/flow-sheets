import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, AgentTurnRequest, AssistantSettingsUpdate } from '../shared/agent/protocol.ts';
import { newDeck, validateDeck, type Deck } from '../shared/deck.ts';
import { newDoc, validateDoc, type Doc } from '../shared/doc.ts';
import { MAX_MARKDOWN_CHARS, newMarkdownDoc, validateMarkdownDoc, type MarkdownDoc } from '../shared/markdown.ts';
import { CsvError, MAX_CSV_CHARS } from '../shared/csv.ts';
import { importDocx } from './docxImport.ts';
import { isPdf } from './pdfImport.ts';
import { FileStore } from './files.ts';
import { checkImageEditRate, editedImageName, EDITABLE_IMAGE_TYPES, ImageEditError, MAX_EDIT_IMAGE_BYTES, MAX_EDIT_PROMPT_CHARS, openaiImageEditor, type ImageEditor } from './imageEdit.ts';
import { CELL_IMAGE_TYPES, HTML_TYPE, isHtmlName, isTextFileType, MAX_CELL_IMAGE_BYTES, MAX_VIDEO_BYTES, PREVIEW_FILE_TYPES, videoTypeOf, VIDEO_TYPES, type DocKind, type SheetMeta, type Workbook } from '../shared/types.ts';
import { AgentError, AgentService, type AgentOptions } from './agent/agent.ts';
import { JobRunner, JobStore, publicJob, workerLauncher, type Launcher } from './agent/jobs.ts';
import { checkOpenAIKey, openaiErrorMessage } from './agent/openai.ts';
import { AssistantSettingsStore, SettingsError } from './agent/settings.ts';
import { AgentStore } from './agent/store.ts';
import { registerConnectorService } from './agent/tools.ts';
import { ConnectorService, type ConnectorServiceOptions } from './connectors/service.ts';
import { ConnectorError } from './connectors/types.ts';
import { AuthService, RESET_TTL_MS, SESSION_TTL_MS, VERIFY_TTL_MS, validateCredentials, type User } from './auth.ts';
import { Backup } from './backup.ts';
import { r2FromEnv, S3ObjectStore, type ObjectStore } from './blob.ts';
import { openDb } from './db.ts';
import { EXPORT_FORMATS, ExportError, exportAll, exportFile, imageSource, loadFile, type ExportFormat } from './export.ts';
import { openGettingStarted } from './gettingStarted.ts';
import { ImageStore } from './images.ts';
import { deckPreview, docPreview, markdownPreview, sheetPreview, type FilePreview } from '../shared/preview.ts';
import { cleanFolderName, cleanFolderPath, folderName, joinFolder } from '../shared/folders.ts';
import { FolderStore, type Folders } from './folders.ts';
import { LocalFileStore, LocalFolder, LocalFolders, LocalSheetStore } from './localStore.ts';
import { googleFromEnv, GoogleLogin, GoogleLoginError, GOOGLE_STATE_TTL_MS, type GoogleOptions } from './googleAuth.ts';
import { mountPlugin } from '../plugin/server/mount.ts';
import { mailerFromEnv, type Mailer } from './mail.ts';
import { SheetStore, validateWorkbook } from './sheets.ts';
import { importPptx } from './pptxImport.ts';
import { ImportError, importExcel } from './xlsxImport.ts';

const SESSION_COOKIE = 'sid';
/** Carries the desktop app's per-launch token (see AppOptions.local). */
export const LOCAL_COOKIE = 'local';
// Ties a Google sign-in callback to the browser that started it (login CSRF).
const GOOGLE_STATE_COOKIE = 'gstate';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_STORED_FILE_BYTES = 50 * 1024 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    /** The folder a request names (its "folder" query or body field), checked to exist; '' is the top. */
    folder: string;
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
  /** Checks an OpenAI key before it is saved in Settings. Tests pass a stub; the default asks OpenAI. */
  checkOpenAIKey?: (apiKey: string, model: string) => Promise<void>;
  /** Edits a picture for the assistant's edit_image. Tests pass a stub; the default asks OpenAI's image model. */
  imageEditor?: ImageEditor;
  /** Connector overrides (tests pass a fake fetch). */
  connectors?: Partial<Omit<ConnectorServiceOptions, 'keyFile'>>;
  /**
   * Serve the ChatGPT plugin (plugin/) from this server too: MCP at /mcp, OAuth at /oauth and the well-known
   * documents, the built plugin app from webDir. publicUrl is the origin ChatGPT reaches this server on.
   */
  plugin?: { publicUrl: string; webDir: string };
  /**
   * Object store for the off-box copy of every file (server/backup.ts). Defaults to Cloudflare R2 from the
   * environment (R2_BUCKET and friends); null leaves backups off. Tests pass a MemoryObjectStore.
   */
  blob?: ObjectStore | null;
  /**
   * The desktop app (desktop/): the library is the files of this folder (server/localStore.ts) and there
   * are no accounts, every request is the one local user. With a token, only requests carrying it in the
   * "local" cookie are that user, which keeps other programs and web pages on this machine out.
   */
  local?: { dir: string; token?: string };
}

function cleanTitle(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.trim().slice(0, 200);
  return s || null;
}

function agentErrorMessage(e: unknown): string {
  if (e instanceof AgentError) return e.message;
  const openai = openaiErrorMessage(e);
  if (openai) return openai;
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
  const folder = opts.local ? new LocalFolder(opts.local.dir, path.join(opts.dataDir, 'trash')) : null;
  const sheets = folder ? new LocalSheetStore(db, folder, opts.dataDir) : new SheetStore(db, path.join(opts.dataDir, 'sheets'));
  await sheets.init();
  /**
   * A save may name the revision (updatedAt) the editor loaded. When it does and the file has been saved
   * since, by another editor or the ChatGPT plugin, the current metadata is returned so the save is refused
   * instead of silently overwriting that change.
   */
  const staleRev = (ownerId: string, id: string, kind: DocKind, rev: unknown): SheetMeta | null => {
    if (typeof rev !== 'string') return null;
    const cur = sheets.get(ownerId, id, kind);
    return cur && cur.updatedAt !== rev ? cur : null;
  };
  const images = new ImageStore(db, path.join(opts.dataDir, 'images'));
  await images.init();
  const storedFiles = folder ? new LocalFileStore(db, folder) : new FileStore(db, path.join(opts.dataDir, 'files'));
  await storedFiles.init();
  const folders: Folders = folder ? new LocalFolders(folder) : new FolderStore(db);
  // Every save and upload also goes to the object store, and a daily pass snapshots the database and
  // re-uploads anything missing (backup.ts). Restore with `npm run r2 restore <dir>`.
  const blob = opts.local ? null : opts.blob === undefined ? (() => { const cfg = r2FromEnv(); return cfg ? new S3ObjectStore(cfg) : null; })() : opts.blob;
  const backup = blob ? new Backup(blob, { dataDir: opts.dataDir, db, log: { info: (m) => app.log.info(m), error: (m) => app.log.error(m) } }) : null;
  if (backup) {
    sheets.backup = backup;
    images.backup = backup;
  }
  auth.purgeExpiredSessions();
  const connectors = new ConnectorService(db, { keyFile: path.join(opts.dataDir, 'connector.key'), ...opts.connectors });
  // Lets the agent's server tools (list_connections, fetch_connector_data) reach the user's connections.
  registerConnectorService(sheets, connectors);
  // Created after the connector service, which makes the encryption key file they share.
  const assistantSettings = new AssistantSettingsStore(db, path.join(opts.dataDir, 'connector.key'));
  const agent = new AgentService(new AgentStore(db), sheets, assistantSettings, opts.agent);
  const jobs = new JobStore(db);
  const jobRunner = new JobRunner(jobs, opts.launchJob ?? workerLauncher(opts.dataDir));
  // A previous server process may have died (or been restarted by the job itself) with a job in flight.
  jobRunner.reconcile();

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 100 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  if (opts.plugin) {
    await mountPlugin(app, { db, dataDir: opts.dataDir, sheets, images, files: storedFiles, auth, google, publicUrl: opts.plugin.publicUrl, webDir: opts.plugin.webDir, sessionCookie: SESSION_COOKIE, production: !!opts.staticDir });
  }
  // Raw file uploads (xlsx import).
  app.addContentTypeParser([XLSX_MIME, PPTX_MIME, DOCX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  // Raw cell image uploads. Images are stored as files and cells only reference them, so workbook saves
  // (JSON, under the default body limit) stay small however large the images are.
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_STORED_FILE_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser([...new Set(Object.values(VIDEO_TYPES))], { parseAs: 'buffer', bodyLimit: MAX_VIDEO_BYTES }, (_req, body, done) => done(null, body));
  app.addContentTypeParser(CELL_IMAGE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_CELL_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.decorate('connectors', connectors);
  app.decorateRequest('user', null);
  app.decorateRequest('folder', '');

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

  // The desktop app has one user, who owns the mounted folder's files and is never asked to sign in.
  const localUser: User | null = opts.local ? { id: 'local', email: 'local' } : null;
  if (localUser) db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?)").run(localUser.id, localUser.email, new Date().toISOString());
  app.addHook('onRequest', async (req) => {
    if (localUser) req.user = !opts.local!.token || req.cookies[LOCAL_COOKIE] === opts.local!.token ? localUser : null;
    else req.user = auth.userForSession(req.cookies[SESSION_COOKIE]);
  });
  app.addHook('onClose', async () => {
    if (backup) {
      backup.stop();
      // Let queued uploads finish before the database closes (a redeploy gives 15 s).
      if (!(await backup.drain(8_000))) app.log.error(`backup: ${backup.pending} upload(s) still pending at shutdown`);
    }
    db.close();
  });
  // The daily pass runs for a real deployment (store from the environment), not for tests.
  if (backup && opts.blob === undefined) backup.startDaily();

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
    // New files go into the folder the request names; uploads name it in the query, the rest in the body.
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? (req.body as { folder?: unknown }) : {};
    const named = (req.query as { folder?: unknown } | undefined)?.folder ?? body.folder;
    if (named === undefined) return;
    const path = cleanFolderPath(named);
    if (path === null || !folders.exists(req.user.id, path)) return reply.code(404).send({ error: 'Folder not found' });
    req.folder = path;
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

  app.get('/api/auth/me', async (req) => ({ user: req.user, googleLogin: !!google, ...(folder && req.user ? { local: { dir: folder.root } } : {}) }));

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

    // Create: empty, or a CSV file from its text (an uploaded .csv file, read by the browser).
    r.post('/api/sheets', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; csv?: unknown };
      if (body.csv !== undefined) {
        if (typeof body.csv !== 'string') return reply.code(400).send({ error: 'CSV must be a string' });
        if (body.csv.length > MAX_CSV_CHARS) return reply.code(400).send({ error: 'This file is too large to import (10 MB maximum).' });
        try {
          return { sheet: await sheets.createCsv(req.user!.id, cleanTitle(body.title) ?? 'Imported CSV', body.csv, req.folder) };
        } catch (e) {
          if (e instanceof CsvError) return reply.code(400).send({ error: e.message });
          throw e;
        }
      }
      return { sheet: await sheets.create(req.user!.id, cleanTitle(body.title) ?? 'Untitled spreadsheet', undefined, req.folder) };
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
      const sheet = await sheets.create(req.user!.id, title, result.workbook, req.folder);
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
      try {
        const res = await sheets.load(req.user!.id, id);
        if (!res) return reply.code(404).send({ error: 'Sheet not found' });
        return { sheet: res.meta, workbook: res.workbook };
      } catch (e) {
        // A CSV file from a mounted folder that cannot be opened (too large, for one).
        if (e instanceof CsvError) return reply.code(400).send({ error: e.message });
        throw e;
      }
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

    // Convert a CSV file to a native spreadsheet, so it can hold formatting, more tabs and so on.
    r.post('/api/sheets/:id/convert', async (req, reply) => {
      const { id } = req.params as { id: string };
      const meta = await sheets.convertToNative(req.user!.id, id);
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
      return { doc: await sheets.createDoc(req.user!.id, title, doc as Doc, req.folder) };
    });

    r.get('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.loadDoc(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Document not found' });
      return { meta: res.meta, doc: res.doc };
    });

    r.put('/api/docs/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { doc?: unknown; rev?: unknown } | undefined;
      const doc = body?.doc;
      const problem = validateDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'doc', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The document was changed elsewhere since you loaded it.', meta: stale });
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
      const title = cleanTitle((req.query as { title?: unknown }).title) ?? 'Imported document';
      const result = await convertDocx(req, reply);
      if (!result) return reply;
      const doc = await sheets.createDoc(req.user!.id, title, result.doc, req.folder);
      return { doc, warnings: result.warnings };
    });

    // Convert only (nothing is stored but the pictures); the client adds the blocks to an open document.
    r.post('/api/import/pdf', async (req, reply) => {
      if (!Buffer.isBuffer(req.body) || !isPdf(req.body)) return reply.code(400).send({ error: 'This file is not a valid PDF.' });
      const raw = String((req.query as { filename?: unknown }).filename ?? '');
      const name = raw.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'document.pdf';
      return { file: await storedFiles.create(req.user!.id, /\.pdf$/i.test(name) ? name : `${name}.pdf`, 'application/pdf', req.body, req.folder) };
    });

    r.post('/api/import/docx', async (req, reply) => {
      const result = await convertDocx(req, reply);
      if (!result) return reply;
      return result;
    });
  });

  // --- Markdown documents --------------------------------------------------------
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/markdown', async (req) => ({ docs: sheets.list(req.user!.id, 'markdown') }));

    // Create: empty, or from text (an uploaded .md file, read by the browser).
    r.post('/api/markdown', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; text?: unknown };
      const title = cleanTitle(body.title) ?? 'Untitled Markdown';
      const text = body.text === undefined ? '' : body.text;
      if (typeof text !== 'string') return reply.code(400).send({ error: 'Text must be a string' });
      if (text.length > MAX_MARKDOWN_CHARS) return reply.code(400).send({ error: 'This file is too large to import (5 MB maximum).' });
      return { doc: await sheets.createMarkdown(req.user!.id, title, newMarkdownDoc(text), req.folder) };
    });

    r.get('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.loadMarkdown(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Document not found' });
      return { meta: res.meta, doc: res.doc };
    });

    r.put('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { doc?: unknown; rev?: unknown } | undefined;
      const doc = body?.doc;
      const problem = validateMarkdownDoc(doc);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'markdown', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The document was changed elsewhere since you loaded it.', meta: stale });
      const meta = await sheets.saveMarkdown(req.user!.id, id, doc as MarkdownDoc);
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.patch('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const title = cleanTitle((req.body as { title?: unknown } | undefined)?.title);
      if (!title) return reply.code(400).send({ error: 'Title is required' });
      const meta = sheets.rename(req.user!.id, id, title, 'markdown');
      if (!meta) return reply.code(404).send({ error: 'Document not found' });
      return { meta };
    });

    r.delete('/api/markdown/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!(await sheets.delete(req.user!.id, id, 'markdown'))) return reply.code(404).send({ error: 'Document not found' });
      return { ok: true };
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
      return { deck: await sheets.createDeck(req.user!.id, title, deck as Deck, req.folder) };
    });

    // The user's copy of the Getting started guide, made the first time they ask for it.
    r.post('/api/getting-started', async (req) => ({ deck: await openGettingStarted(sheets, images, req.user!.id) }));

    r.get('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const res = await sheets.loadDeck(req.user!.id, id);
      if (!res) return reply.code(404).send({ error: 'Presentation not found' });
      return { meta: res.meta, deck: res.deck };
    });

    r.put('/api/decks/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { deck?: unknown; rev?: unknown } | undefined;
      const deck = body?.deck;
      const problem = validateDeck(deck);
      if (problem) return reply.code(400).send({ error: problem });
      const stale = staleRev(req.user!.id, id, 'deck', body?.rev);
      if (stale) return reply.code(409).send({ error: 'The presentation was changed elsewhere since you loaded it.', meta: stale });
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
      const deck = await sheets.createDeck(req.user!.id, title, result.deck, req.folder);
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

    // --- Export: one file in a readable format, or everything as a zip (server/export.ts) ---------
    const attachment = (reply: FastifyReply, name: string, type: string) =>
      reply
        .header('Content-Type', type)
        .header('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff');

    r.get('/api/files/:id/export', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { format, tab } = req.query as { format?: string; tab?: string };
      const loaded = await loadFile(sheets, req.user!.id, id);
      if (!loaded) return reply.code(404).send({ error: 'File not found' });
      const fmt = (format ?? (loaded.meta.format === 'csv' ? 'csv' : EXPORT_FORMATS[loaded.meta.kind][0])) as ExportFormat;
      try {
        const out = await exportFile(loaded.meta, loaded.data, fmt, imageSource(images, req.user!.id), tab);
        return attachment(reply, out.name, out.type).send(out.body);
      } catch (e) {
        if (e instanceof ExportError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // --- Stored files (generated PDFs, uploads; server/files.ts) ----------------------------------
    // Upload: the raw bytes as the body with their content type; the name in the x-filename header (URL-encoded).
    r.post('/api/files', async (req, reply) => {
      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Send the file as the request body.' });
      let name = '';
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      } catch {
        // Malformed name: fall back to the default below.
      }
      name = name.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'file';
      // A video or a web page is stored under the type of its extension, whatever the browser called it.
      return { file: await storedFiles.create(req.user!.id, name, videoTypeOf(name) ?? (isHtmlName(name) ? HTML_TYPE : type), body, req.folder) };
    });

    r.get('/api/files', async (req) => ({ files: storedFiles.list(req.user!.id) }));

    const storedFile = (req: { user?: { id: string } | null; params: unknown }) => {
      const { id } = req.params as { id: string };
      return /^[0-9a-f-]{36}$/.test(id) ? storedFiles.get(req.user!.id, id) : null;
    };

    r.get('/api/files/:id/meta', async (req, reply) => {
      const f = storedFile(req);
      return f ? { file: f.meta } : reply.code(404).send({ error: 'File not found' });
    });

    // Inline: only PDFs, images and videos are served with their own type; anything else is a plain download.
    // A Range request gets just that part of the file, which is what lets a video player seek.
    r.get('/api/files/:id', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      if (!PREVIEW_FILE_TYPES.includes(f.meta.type)) return attachment(reply, f.meta.filename, 'application/octet-stream').send(createReadStream(f.file));
      // A stored file never changes; one in a mounted folder can.
      // Browsers that play QuickTime files (H.264) only do so when they are served as MP4.
      const type = f.meta.type === 'video/quicktime' ? 'video/mp4' : f.meta.type;
      reply.header('Content-Type', type).header('Content-Disposition', 'inline').header('Cache-Control', opts.local ? 'no-cache' : 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes');
      const size = statSync(f.file).size;
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (!range || (!range[1] && !range[2])) return reply.header('Content-Length', size).send(createReadStream(f.file));
      // "a-b", "a-" (to the end) or "-n" (the last n bytes).
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', end - start + 1)
        .send(createReadStream(f.file, { start, end }));
    });

    r.get('/api/files/:id/download', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      return attachment(reply, f.meta.filename, f.meta.type || 'application/octet-stream').send(createReadStream(f.file));
    });

    // Rewrite a text file (the assistant's edit_file). PDFs, pictures and videos are never rewritten: they are
    // served as files that do not change.
    r.put('/api/files/:id', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      if (!isTextFileType(f.meta.type) || PREVIEW_FILE_TYPES.includes(f.meta.type)) return reply.code(400).send({ error: 'Only text files can be edited.' });
      if (!Buffer.isBuffer(req.body) || req.body.includes(0)) return reply.code(400).send({ error: 'Send the new text as the request body.' });
      return { file: await storedFiles.update(req.user!.id, f.meta.id, req.body) };
    });

    // Put back the version before the last rewrite (the two swap, so reverting twice redoes it).
    r.post('/api/files/:id/revert', async (req, reply) => {
      const f = storedFile(req);
      const file = f && (await storedFiles.revert(req.user!.id, f.meta.id));
      return file ? { file } : reply.code(404).send({ error: 'There is no earlier version of this file.' });
    });

    // Edit a picture with an image-generation model (the assistant's edit_image). The result is a new file
    // next to the original, which stays as it is.
    r.post('/api/files/:id/edit-image', async (req, reply) => {
      const f = storedFile(req);
      if (!f) return reply.code(404).send({ error: 'File not found' });
      const prompt = String((req.body as { prompt?: unknown } | null)?.prompt ?? '').trim();
      if (!prompt || prompt.length > MAX_EDIT_PROMPT_CHARS) return reply.code(400).send({ error: 'Say what to change in the picture.' });
      if (!EDITABLE_IMAGE_TYPES.includes(f.meta.type)) return reply.code(400).send({ error: 'Only PNG, JPEG and WebP pictures can be edited.' });
      if (f.meta.size > MAX_EDIT_IMAGE_BYTES) return reply.code(400).send({ error: 'This picture is too large to edit (20 MB maximum).' });
      const apiKey = assistantSettings.openaiKey(req.user!.id) ?? process.env.OPENAI_API_KEY;
      if (!apiKey) return reply.code(400).send({ error: 'Image editing needs an OpenAI API key. The user can add theirs on the Settings page; nothing was changed.' });
      try {
        checkImageEditRate(req.user!.id);
        const edited = await (opts.imageEditor ?? openaiImageEditor)({ apiKey, image: await readFile(f.file), filename: f.meta.filename, type: f.meta.type, prompt });
        return { file: await storedFiles.create(req.user!.id, editedImageName(f.meta.filename), 'image/png', edited, f.meta.folder ?? '') };
      } catch (e) {
        if (e instanceof ImageEditError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    r.delete('/api/files/:id', async (req, reply) => {
      const f = storedFile(req);
      if (!f || !(await storedFiles.delete(req.user!.id, f.meta.id))) return reply.code(404).send({ error: 'File not found' });
      return { ok: true };
    });

    // --- The library, one folder at a time (shared/folders.ts) ------------------------------------
    // What is in a folder: its folders, then documents of every kind and stored files.
    r.get('/api/library', async (req, reply) => {
      const id = req.user!.id;
      const problem = folders.problem?.(id, req.folder);
      if (problem) return reply.code(403).send({ error: problem });
      return {
        folder: req.folder,
        folders: folders.children(id, req.folder).map((path) => ({ name: folderName(path), path })),
        docs: sheets.listIn(id, req.folder),
        files: storedFiles.listIn(id, req.folder),
      };
    });

    // A small picture of a document for the thumbnail view (shared/preview.ts).
    r.get('/api/library/preview/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      let loaded;
      try {
        loaded = /^[0-9a-f-]{36}$/.test(id) ? await loadFile(sheets, req.user!.id, id) : null;
      } catch {
        // A file that cannot be read (a CSV too large to open, say) has no picture.
        return { preview: { kind: 'empty' } satisfies FilePreview };
      }
      if (!loaded) return reply.code(404).send({ error: 'File not found' });
      const d = loaded.data;
      const preview: FilePreview = d.kind === 'doc' ? docPreview(d.doc) : d.kind === 'markdown' ? markdownPreview(d.markdown) : d.kind === 'deck' ? deckPreview(d.deck) : sheetPreview(d.workbook);
      return { preview };
    });

    // Find by name through the whole library, every folder (the desktop app: the whole mounted folder).
    r.get('/api/library/search', async (req, reply) => {
      const q = String((req.query as { q?: unknown }).q ?? '').trim().slice(0, 200);
      if (!q) return reply.code(400).send({ error: 'Say what to look for.' });
      const id = req.user!.id;
      const [paths, docs, files] = [await folders.search(id, q), await sheets.search(id, q), await storedFiles.search(id, q)];
      return {
        folders: paths.map((path) => ({ name: folderName(path), path })),
        docs,
        files,
        // Set when a very large folder could not be searched to the end.
        truncated: folder ? (await folder.find(q)).truncated : false,
      };
    });

    // Create a folder called `name` inside the request's folder.
    r.post('/api/folders', async (req, reply) => {
      const name = cleanFolderName((req.body as { name?: unknown } | undefined)?.name);
      if (!name) return reply.code(400).send({ error: 'A folder name cannot be empty, start with a dot, or contain \\ / : * ? " < > |.' });
      const path = cleanFolderPath(joinFolder(req.folder, name));
      if (path === null) return reply.code(400).send({ error: 'Folders cannot be nested this deep.' });
      if (!folders.create(req.user!.id, path)) return reply.code(409).send({ error: `There is already a folder called “${name}” here.` });
      return { folder: { name, path } };
    });

    // Delete the request's folder, which must be empty.
    r.delete('/api/folders', async (req, reply) => {
      const res = folders.remove(req.user!.id, req.folder);
      if (res === 'missing') return reply.code(404).send({ error: 'Folder not found' });
      if (res === 'not-empty') return reply.code(409).send({ error: 'This folder is not empty. Move or delete what is in it first.' });
      return { ok: true };
    });

    // Move a document (any kind) or a stored file into the request's folder.
    r.post('/api/library/move', async (req, reply) => {
      const { id, kind } = (req.body ?? {}) as { id?: unknown; kind?: unknown };
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'File not found' });
      const moved = kind === 'file' ? storedFiles.move(req.user!.id, id, req.folder) : sheets.move(req.user!.id, id, req.folder);
      if (!moved) return reply.code(404).send({ error: 'File not found' });
      return { ok: true };
    });

    // --- Trash: files deleted in the last 30 days, kept in the off-box copy (server/backup.ts) ---------
    r.get('/api/trash', async (req) => ({ files: backup ? await backup.listDeleted(req.user!.id) : [], available: !!backup }));

    r.post('/api/trash/:id/restore', async (req, reply) => {
      if (!backup) return reply.code(404).send({ error: 'No backup store is configured' });
      const { id } = req.params as { id: string };
      if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send({ error: 'File not found' });
      const entry = (await backup.listDeleted(req.user!.id)).find((f) => f.id === id);
      if (!entry) return reply.code(404).send({ error: 'File not found in the trash' });
      if (sheets.get(req.user!.id, id)) return reply.code(409).send({ error: 'This file is not deleted' });
      const json = await backup.latestRevision(req.user!.id, entry.kind, id);
      if (!json) return reply.code(404).send({ error: 'No copy of this file is left' });
      const meta = await sheets.restore(req.user!.id, entry.kind, id, entry.title, json);
      await backup.undelete(req.user!.id, entry.kind, id);
      return { file: meta };
    });

    r.get('/api/export.zip', async (req, reply) => {
      const { body, files, problems } = await exportAll(sheets, req.user!.id, imageSource(images, req.user!.id));
      req.log.info({ files, problems: problems.length }, 'exported account');
      const date = new Date().toISOString().slice(0, 10);
      return attachment(reply, `Universal Docs export ${date}.zip`, 'application/zip').send(body);
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

    // --- Assistant settings: the server's model, or an OpenAI model on the user's own key ---
    r.get('/api/settings/assistant', async (req) => ({ settings: assistantSettings.get(req.user!.id) }));

    r.put('/api/settings/assistant', async (req, reply) => {
      try {
        return { settings: await assistantSettings.update(req.user!.id, (req.body ?? {}) as Partial<AssistantSettingsUpdate>, opts.checkOpenAIKey ?? checkOpenAIKey) };
      } catch (e) {
        if (e instanceof SettingsError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    });

    // --- App-change jobs (self-improvement) ---
    // A change to the app (kind "change") or a research task (kind "research"), both run by the worker.
    r.post('/api/agent/jobs', async (req, reply) => {
      const body = (req.body ?? {}) as { title?: unknown; spec?: unknown; kind?: unknown; sheetId?: unknown };
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const spec = typeof body.spec === 'string' ? body.spec.trim() : '';
      if (!title || !spec) return reply.code(400).send({ error: 'A title and a spec are required.' });
      // Jobs run a worker against the hosted app's checkout, which the desktop app does not have.
      if (opts.local) return reply.code(400).send({ error: 'Background jobs are not available in the desktop app.' });
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
      if (opts.local) return reply.code(400).send({ error: 'Changes to the app are not available in the desktop app.' });
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
