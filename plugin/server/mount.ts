// Runs the plugin inside the app's own Fastify server, so one Railway service with one volume serves both.
// The plugin owns a few paths (/mcp, /oauth/*, /plugin/*, the OAuth well-known documents); a hook at the
// start of the request answers those with the plugin's handler and leaves everything else to the app.
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuthService } from '../../server/auth.ts';
import type { DB } from '../../server/db.ts';
import type { GoogleLogin } from '../../server/googleAuth.ts';
import type { ImageStore } from '../../server/images.ts';
import type { SheetStore } from '../../server/sheets.ts';
import { FileHub } from './files.ts';
import { createPluginHandler } from './http.ts';
import { OAuthServer } from './oauth.ts';

export interface MountOptions {
  db: DB;
  dataDir: string;
  sheets: SheetStore;
  images: ImageStore;
  auth: AuthService;
  google: GoogleLogin | null;
  /** Public origin of the app (the OAuth issuer and where images come from), e.g. https://docs.example.com. */
  publicUrl: string;
  /** Directory with the built plugin app (plugin/dist/web). */
  webDir: string;
  /** The app session cookie's name, to skip the sign-in page for a browser already signed in to the app. */
  sessionCookie: string;
  production: boolean;
}

export async function mountPlugin(app: FastifyInstance, opts: MountOptions): Promise<void> {
  const publicUrl = opts.publicUrl.replace(/\/$/, '');
  const hub = new FileHub({ db: opts.db, dataDir: opts.dataDir, publicUrl, sheets: opts.sheets, images: opts.images });
  const oauth = new OAuthServer({
    db: new DatabaseSync(path.join(opts.dataDir, 'plugin.db')),
    issuer: publicUrl,
    resource: `${publicUrl}/mcp`,
    auth: opts.auth,
    profile: (id) => hub.profile(id),
    google: opts.google,
  });
  const handler = createPluginHandler({
    hub,
    oauth,
    publicUrl,
    webDir: opts.webDir,
    production: opts.production,
    sessionUser: (req) => {
      const cookie = parseCookie(req.headers.cookie)[opts.sessionCookie];
      return opts.auth.userForSession(cookie)?.id ?? null;
    },
  });
  app.addHook('onRequest', (req, reply, done) => {
    const pathname = (req.raw.url ?? '/').split('?')[0];
    if (!handler.handles(pathname)) return done();
    reply.hijack();
    handler.handle(req.raw, reply.raw).catch((e: unknown) => {
      req.log.error({ err: e }, 'plugin request failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(500).end();
    });
  });
  app.log.info(`ChatGPT plugin mounted at ${publicUrl}/mcp (OAuth issuer ${publicUrl})`);
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

