// The plugin's HTTP server: OAuth discovery and endpoints, the MCP endpoint (streamable HTTP, stateless, per
// user), document images, the built app's assets, and a health check. index.ts reads the environment and
// starts it; tests start it on a free port.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { FileHub } from './files.ts';
import { createMcpServer, INSTRUCTIONS, SERVER_CAPABILITIES, SERVER_INFO, type Bundle, type McpOptions } from './mcp.ts';
import { OAuthError, type OAuthServer } from './oauth.ts';
import { adaptTransport, discoverResult, isDiscover, presentAsSdkVersion, readJson } from './stateless.ts';

export interface PluginServerOptions {
  hub: FileHub;
  /** OAuth, or null for development mode where every request acts as devUserId. */
  oauth: OAuthServer | null;
  devUserId?: string;
  publicUrl: string | null;
  /** Directory with the built app (app.js, app.css). */
  webDir: string;
  production: boolean;
  /** Log request bodies on the MCP endpoint. */
  logBodies?: boolean;
  /** When hosted inside the app: the account already signed in to the app in this browser, from its cookie. */
  sessionUser?: (req: http.IncomingMessage) => string | null;
  mcp?: Partial<McpOptions>;
}

/** The plugin's request handler: which paths it owns, and how to serve them. */
export interface PluginHandler {
  handles(pathname: string): boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

/** Paths the plugin serves; anything else belongs to whoever hosts it. */
export const PLUGIN_PATH = /^(\/mcp(\/|$)|\/oauth\/|\/plugin\/|\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/|$))/;

/** A standalone server for the plugin (development, or a host of its own). */
export function createPluginServer(opts: PluginServerOptions): http.Server {
  const handler = createPluginHandler(opts);
  return http.createServer((req, res) => void handler.handle(req, res));
}

export function createPluginHandler(opts: PluginServerOptions): PluginHandler {
  const { hub, oauth, publicUrl, production } = opts;

  /** The built app. Re-read on every request in development so rebuilds show up. */
  let cached: Bundle | null = null;
  const bundle = (): Bundle => {
    if (cached && production) return cached;
    const js = path.join(opts.webDir, 'app.js');
    const css = path.join(opts.webDir, 'app.css');
    if (!existsSync(js)) throw new Error(`The app is not built: run "npm run plugin:build" (looked for ${js}).`);
    const code = readFileSync(js, 'utf8');
    cached = { js: code, css: existsSync(css) ? readFileSync(css, 'utf8') : '', hash: createHash('sha1').update(code).digest('hex').slice(0, 10) };
    return cached;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
  };
  const html = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  };
  const redirect = (res: http.ServerResponse, url: string) => {
    res.writeHead(302, { location: url, 'cache-control': 'no-store' }).end();
  };
  const oauthFailure = (res: http.ServerResponse, e: unknown) => {
    if (e instanceof OAuthError) return json(res, e.status, { error: e.code, error_description: e.message });
    throw e;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p !== '/mcp') logRequest(req, res, undefined);
    // The local harness calls /mcp from the browser; ChatGPT calls it from its servers.
    if (!production) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version');
      res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }
    try {
      // --- OAuth discovery (the paths ChatGPT probes: plain, with the /mcp suffix, and under /mcp) ---
      if (oauth && req.method === 'GET') {
        if (/^(\/mcp)?\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(p)) return json(res, 200, oauth.protectedResourceMetadata(), { 'access-control-allow-origin': '*' });
        if (/^(\/mcp)?\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/mcp)?$/.test(p)) return json(res, 200, oauth.authorizationServerMetadata(), { 'access-control-allow-origin': '*' });
      }

      // --- OAuth endpoints ---
      if (oauth && p.startsWith('/oauth/')) {
        if (p === '/oauth/register' && req.method === 'POST') {
          try {
            return json(res, 201, oauth.register(await readJson(req)));
          } catch (e) {
            return oauthFailure(res, e);
          }
        }
        if (p === '/oauth/authorize' && req.method === 'GET') {
          try {
            const out = await oauth.authorize(Object.fromEntries(url.searchParams));
            if (out.kind === 'redirect') return redirect(res, out.url);
            // Already signed in to the app in this browser: straight to consent.
            const known = opts.sessionUser?.(req) ?? null;
            if (known) {
              oauth.setUser(out.pendingId, known);
              return redirect(res, `/oauth/consent?p=${encodeURIComponent(out.pendingId)}`);
            }
            return html(res, 200, oauth.signInPage(out.pendingId));
          } catch (e) {
            if (e instanceof OAuthError) return html(res, e.status, oauth.errorPage(e.message));
            throw e;
          }
        }
        if (p === '/oauth/login' && req.method === 'POST') {
          const form = await readForm(req);
          const r = await oauth.passwordLogin(form.p ?? '', form.email, form.password);
          if (!r.ok) return html(res, 200, oauth.signInPage(form.p ?? '', r.error));
          return redirect(res, `/oauth/consent?p=${encodeURIComponent(form.p ?? '')}`);
        }
        if (p === '/oauth/google/start' && req.method === 'GET') {
          const to = oauth.googleStart(url.searchParams.get('p') ?? '', `${oauth.issuer}/oauth/google/callback`);
          if (!to) return html(res, 400, oauth.errorPage('Google sign-in is not available, or this sign-in link has expired.'));
          return redirect(res, to);
        }
        if (p === '/oauth/google/callback' && req.method === 'GET') {
          const r = await oauth.googleFinish(url.searchParams.get('state') ?? undefined, url.searchParams.get('code') ?? undefined, url.searchParams.get('error') ?? undefined);
          if ('error' in r) return html(res, 400, oauth.errorPage(r.error));
          return redirect(res, r.next);
        }
        if (p === '/oauth/consent' && req.method === 'GET') return html(res, 200, oauth.consentPage(url.searchParams.get('p') ?? ''));
        if (p === '/oauth/decision' && req.method === 'POST') {
          const form = await readForm(req);
          try {
            return redirect(res, oauth.decide(form.p, form.allow === 'yes'));
          } catch (e) {
            if (e instanceof OAuthError) return html(res, e.status, oauth.errorPage(e.message));
            throw e;
          }
        }
        if (p === '/oauth/token' && req.method === 'POST') {
          try {
            return json(res, 200, oauth.token(await readForm(req)));
          } catch (e) {
            return oauthFailure(res, e);
          }
        }
        if (p === '/oauth/revoke' && req.method === 'POST') {
          oauth.revoke(await readForm(req));
          res.writeHead(200).end();
          return;
        }
        res.writeHead(404).end('Not found');
        return;
      }

      // --- MCP ---
      if (p === '/mcp') {
        let userId = opts.devUserId ?? null;
        if (oauth) {
          const who = oauth.authenticate(req.headers.authorization);
          if (!who) {
            res.writeHead(401, { 'www-authenticate': oauth.wwwAuthenticate(req.headers.authorization ? 'invalid_token' : undefined), 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          userId = who.userId;
        }
        if (!userId) throw new Error('No account to act as: set up OAuth or PLUGIN_USER_EMAIL.');
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        logRequest(req, res, body);
        if (opts.logBodies) console.log('  <-', JSON.stringify(body)?.slice(0, 1500));
        // ChatGPT speaks MCP 2026-07-28 (sessionless: server/discover, no initialize); the SDK speaks 2025-11-25.
        if (isDiscover(body)) {
          const level = opts.mcp?.level;
          const caps = level === 'minimal' || level === 'tools' ? { tools: { listChanged: true } } : SERVER_CAPABILITIES;
          return json(res, 200, discoverResult(body, SERVER_INFO, caps, INSTRUCTIONS));
        }
        presentAsSdkVersion(req);
        const mcp = createMcpServer(hub.forUser(userId), { bundle, publicUrl, ...opts.mcp });
        const transport = adaptTransport(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !process.env.PLUGIN_SSE }), SERVER_INFO, !!process.env.PLUGIN_RESULT_TYPE_ALL);
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // --- Images and the app's assets ---
      if (p.startsWith('/plugin/img/') && req.method === 'GET') {
        const img = hub.imageFile(p.slice('/plugin/img/'.length));
        if (!img || !existsSync(img.file)) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'content-type': img.type, 'content-length': statSync(img.file).size, 'cache-control': 'private, max-age=86400' });
        createReadStream(img.file).pipe(res);
        return;
      }
      if ((p === '/plugin/app.js' || p === '/plugin/app.css') && req.method === 'GET') {
        const b = bundle();
        const js = p === '/plugin/app.js';
        res.writeHead(200, { 'content-type': js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': production ? 'public, max-age=3600' : 'no-cache', 'access-control-allow-origin': '*' }).end(js ? b.js : b.css);
        return;
      }
      if (p === '/plugin/health') return json(res, 200, { ok: true, auth: oauth ? 'oauth' : 'dev' });
      res.writeHead(404).end('Not found');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    }
  };
  return { handles: (pathname) => PLUGIN_PATH.test(pathname), handle };
}

/** A form body (application/x-www-form-urlencoded) or a JSON body, as flat strings. */
async function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string') as [string, string][]);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** One line per request in the log (and the start of the response body when it was not a 2xx). */
function logRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const started = Date.now();
  const rpc = body && typeof body === 'object' ? (body as { method?: string; params?: { name?: string } }) : null;
  let tail = '';
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const keep = (chunk: unknown) => {
    if (tail.length < 400 && chunk) tail += String(chunk).slice(0, 400 - tail.length);
  };
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    keep(chunk);
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    keep(chunk);
    return (end as (...a: unknown[]) => http.ServerResponse)(chunk, ...rest);
  }) as typeof res.end;
  res.on('finish', () => {
    const what = rpc?.method ? `${rpc.method}${rpc.params?.name ? ` ${rpc.params.name}` : ''}` : '';
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 24);
    const ver = req.headers['mcp-protocol-version'] ? ` v=${String(req.headers['mcp-protocol-version'])}` : '';
    const problem = res.statusCode >= 300 && res.statusCode !== 302 ? ` | ${tail.replace(/\s+/g, ' ').slice(0, 200)}` : '';
    console.log(`${new Date().toISOString().slice(11, 23)} ${req.method} ${req.url} ${what} -> ${res.statusCode} ${Date.now() - started}ms [${ua}${ver}]${problem}`);
  });
}
