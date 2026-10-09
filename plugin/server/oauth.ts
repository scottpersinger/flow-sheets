// OAuth 2.1 authorization server for the plugin, the way ChatGPT (and Claude) connect to a remote MCP server:
// discovery documents, client identification by metadata document or dynamic registration, the
// authorization code flow with PKCE, a sign-in page that checks the app's own accounts (password or Google),
// a consent page, opaque access and refresh tokens, and bearer validation for /mcp.
//
// State lives in a small SQLite file of its own (plugin.db); only hashes of codes and tokens are stored.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthService } from '../../server/auth.ts';
import { GoogleLoginError, type GoogleLogin } from '../../server/googleAuth.ts';

export const SCOPES = ['files:read', 'files:write'] as const;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
const CLIENT_DOC_TTL_MS = 60 * 60 * 1000;

export interface OAuthOptions {
  db: DatabaseSync;
  /** Public origin of the plugin server, e.g. https://docs-mcp.example.com. */
  issuer: string;
  /** The resource tokens are for: the MCP endpoint. */
  resource: string;
  auth: AuthService;
  /** The email behind an account id, for the consent page. */
  profile: (userId: string) => { email: string } | null;
  google?: GoogleLogin | null;
  /** Tests pass a fake, to serve client metadata documents. */
  fetchFn?: typeof fetch;
  appName?: string;
}

/** An OAuth error with the code the spec names; the HTTP layer maps it to a status and JSON body. */
export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  state?: string;
  resource?: string;
}

interface Pending {
  id: string;
  params: AuthorizeParams & { client_id: string; redirect_uri: string; code_challenge: string; scope: string };
  client_name: string;
  user_id: string | null;
}

export type AuthorizeOutcome = { kind: 'page'; pendingId: string } | { kind: 'redirect'; url: string };

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const token = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class OAuthServer {
  private readonly db: DatabaseSync;
  readonly issuer: string;
  readonly resource: string;
  private readonly auth: AuthService;
  private readonly profile: OAuthOptions['profile'];
  private readonly google: GoogleLogin | null;
  private readonly fetchFn: typeof fetch;
  private readonly appName: string;
  private readonly clientDocs = new Map<string, { doc: ClientDoc; expires: number }>();

  constructor(opts: OAuthOptions) {
    this.db = opts.db;
    this.issuer = opts.issuer.replace(/\/$/, '');
    this.resource = opts.resource;
    this.auth = opts.auth;
    this.profile = opts.profile;
    this.google = opts.google ?? null;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.appName = opts.appName ?? 'Universal Docs';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, params TEXT NOT NULL, client_name TEXT NOT NULL, user_id TEXT, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, family TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);
    `);
  }

  get googleEnabled(): boolean {
    return !!this.google;
  }

  // --- Discovery ----------------------------------------------------------------------

  /** RFC 9728: where the resource server's tokens come from. */
  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: this.appName,
    };
  }

  /** RFC 8414: the authorization server's endpoints and features. */
  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** The challenge for a 401 on the MCP endpoint, which makes ChatGPT start (or redo) the OAuth flow. */
  wwwAuthenticate(error?: string): string {
    const parts = [`Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource/mcp"`];
    if (error) parts.push(`error="${error}"`);
    return parts.join(', ');
  }

  // --- Clients ------------------------------------------------------------------------

  /** Dynamic client registration (RFC 7591), for clients without a metadata document. */
  register(body: unknown) {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || !uris.every(isAllowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https URLs (or http://localhost for development).');
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only token_endpoint_auth_method "none" (public client with PKCE) is supported.');
    const id = `dcr_${randomUUID()}`;
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : new URL(uris[0]).host;
    this.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), iso(now()));
    return {
      client_id: id,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /** Who the client is, and whether it may use this redirect URI. */
  async resolveClient(clientId: string | undefined, redirectUri: string | undefined): Promise<{ name: string }> {
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
    if (!redirectUri) throw new OAuthError('invalid_request', 'redirect_uri is required.');
    let name: string;
    let uris: string[];
    if (/^https:\/\//.test(clientId)) {
      // Client ID metadata document: the id is an https URL to a JSON document describing the client.
      const doc = await this.clientDocument(clientId);
      name = doc.client_name ?? new URL(clientId).host;
      uris = doc.redirect_uris;
    } else {
      const row = this.db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?').get(clientId) as { name: string; redirect_uris: string } | undefined;
      if (!row) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
      name = row.name;
      uris = JSON.parse(row.redirect_uris) as string[];
    }
    if (!uris.includes(redirectUri)) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client.');
    return { name };
  }

  private async clientDocument(url: string): Promise<ClientDoc> {
    const cached = this.clientDocs.get(url);
    if (cached && cached.expires > now()) return cached.doc;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new OAuthError('invalid_client', `Could not fetch the client metadata document: ${(e as Error).message}`, 401);
    }
    if (!res.ok) throw new OAuthError('invalid_client', `The client metadata document returned ${res.status}.`, 401);
    const doc = (await res.json()) as Partial<ClientDoc>;
    if (doc.client_id !== url) throw new OAuthError('invalid_client', 'The client metadata document does not name itself as client_id.', 401);
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((u) => typeof u === 'string' && isAllowedRedirect(u))) throw new OAuthError('invalid_client', 'The client metadata document has no valid redirect_uris.', 401);
    const clean: ClientDoc = { client_id: url, redirect_uris: doc.redirect_uris, client_name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : undefined };
    this.clientDocs.set(url, { doc: clean, expires: now() + CLIENT_DOC_TTL_MS });
    return clean;
  }

  // --- Authorization ------------------------------------------------------------------

  /**
   * Start the flow. Returns a pending sign-in to show a page for, or (once the client and redirect URI are
   * known to be genuine) a redirect carrying an error. Problems with the client itself throw.
   */
  async authorize(q: AuthorizeParams): Promise<AuthorizeOutcome> {
    const client = await this.resolveClient(q.client_id, q.redirect_uri);
    const back = (error: string, description: string) => ({ kind: 'redirect' as const, url: this.redirect(q.redirect_uri!, { error, error_description: description, state: q.state }) });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge) return back('invalid_request', 'code_challenge is required (PKCE).');
    if ((q.code_challenge_method ?? 'plain') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256.');
    if (q.resource && q.resource !== this.resource) return back('invalid_target', `Unknown resource; this server issues tokens for ${this.resource}.`);
    const scope = this.cleanScope(q.scope);
    if (!scope) return back('invalid_scope', `Supported scopes: ${SCOPES.join(' ')}.`);
    this.purge();
    const id = token();
    const params = { ...q, client_id: q.client_id!, redirect_uri: q.redirect_uri!, code_challenge: q.code_challenge, scope };
    this.db.prepare('INSERT INTO oauth_pending (id, params, client_name, user_id, expires_at) VALUES (?, ?, ?, NULL, ?)').run(id, JSON.stringify(params), client.name, iso(now() + PENDING_TTL_MS));
    return { kind: 'page', pendingId: id };
  }

  pending(id: string | undefined): Pending | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT id, params, client_name, user_id, expires_at FROM oauth_pending WHERE id = ?').get(id) as { id: string; params: string; client_name: string; user_id: string | null; expires_at: string } | undefined;
    if (!row || row.expires_at < iso(now())) return null;
    return { id: row.id, params: JSON.parse(row.params) as Pending['params'], client_name: row.client_name, user_id: row.user_id };
  }

  /** The account signed in with email and password. */
  async passwordLogin(pendingId: string, email: unknown, password: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const p = this.pending(pendingId);
    if (!p) return { ok: false, error: 'This sign-in link has expired. Start again from ChatGPT.' };
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) return { ok: false, error: 'Enter your email and password.' };
    const user = await this.auth.login(email.trim(), password);
    if (user === 'unverified') return { ok: false, error: 'This account has not verified its email address yet. Check your inbox for the verification link.' };
    if (!user) return { ok: false, error: 'Wrong email or password.' };
    this.setUser(pendingId, user.id);
    return { ok: true };
  }

  /** Where to send the browser for "Continue with Google"; the callback lands on googleFinish. */
  googleStart(pendingId: string, redirectUri: string): string | null {
    if (!this.google || !this.pending(pendingId)) return null;
    return this.google.start(redirectUri, `/oauth/consent?p=${encodeURIComponent(pendingId)}`).url;
  }

  /** Back from Google: sign the account in (creating it like the app does) and return where to continue. */
  async googleFinish(state: string | undefined, code: string | undefined, error: string | undefined): Promise<{ next: string } | { error: string }> {
    if (!this.google) return { error: 'Google sign-in is not set up on this server.' };
    if (error === 'access_denied') return { error: 'The Google sign-in was cancelled.' };
    if (error || !state || !code) return { error: 'Google sign-in failed. Try again.' };
    try {
      const { identity, next } = await this.google.finish(state, code);
      const pendingId = new URL(next, this.issuer).searchParams.get('p') ?? '';
      if (!this.pending(pendingId)) return { error: 'This sign-in link has expired. Start again from ChatGPT.' };
      const user = this.auth.loginWithGoogle(identity);
      if (user === 'unverified') return { error: "Your Google account's email address isn't verified, so it can't be used to sign in." };
      this.setUser(pendingId, user.id);
      return { next };
    } catch (e) {
      if (e instanceof GoogleLoginError) return { error: e.message };
      throw e;
    }
  }

  setUser(pendingId: string, userId: string): void {
    this.db.prepare('UPDATE oauth_pending SET user_id = ? WHERE id = ?').run(userId, pendingId);
  }

  /** "Not you?": forget the account picked up from the app session and ask for a sign-in instead. */
  clearUser(pendingId: string): void {
    this.db.prepare('UPDATE oauth_pending SET user_id = NULL WHERE id = ?').run(pendingId);
  }

  /** The user allowed or denied: where to send the browser (back to the client). */
  decide(pendingId: string | undefined, allow: boolean): string {
    const p = this.pending(pendingId);
    if (!p) throw new OAuthError('invalid_request', 'This sign-in link has expired. Start again from ChatGPT.');
    this.db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(p.id);
    if (!allow || !p.user_id) return this.redirect(p.params.redirect_uri, { error: 'access_denied', error_description: 'The user declined.', state: p.params.state });
    const code = token();
    this.db
      .prepare('INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha(code), p.params.client_id, p.user_id, p.params.redirect_uri, p.params.code_challenge, p.params.scope, iso(now() + CODE_TTL_MS));
    return this.redirect(p.params.redirect_uri, { code, state: p.params.state });
  }

  private redirect(uri: string, params: Record<string, string | undefined>): string {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set('iss', this.issuer); // RFC 9207: the client checks who answered.
    return url.href;
  }

  // --- Tokens ----------------------------------------------------------------------------

  token(form: Record<string, string>) {
    if (form.grant_type === 'authorization_code') return this.exchangeCode(form);
    if (form.grant_type === 'refresh_token') return this.refresh(form);
    throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
  }

  private exchangeCode(form: Record<string, string>) {
    const { code, code_verifier, redirect_uri, client_id, resource } = form;
    if (!code || !code_verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required.');
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE hash = ?').get(sha(code)) as
      | { hash: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.expires_at < iso(now())) throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired.');
    if (row.used_at) {
      // A replayed code: whoever holds it may have stolen it, so nothing issued from it stays valid.
      this.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").run(iso(now()), row.hash);
      throw new OAuthError('invalid_grant', 'The authorization code was already used.');
    }
    if (client_id && client_id !== row.client_id) throw new OAuthError('invalid_grant', 'client_id does not match the code.');
    if (redirect_uri && redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the code.');
    if (sha(code_verifier) !== row.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge.');
    if (resource && resource !== this.resource) throw new OAuthError('invalid_target', `Unknown resource; this server issues tokens for ${this.resource}.`);
    this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE hash = ?').run(iso(now()), row.hash);
    return this.issue(row.client_id, row.user_id, row.scope, row.hash);
  }

  private refresh(form: Record<string, string>) {
    const { refresh_token, scope: wanted } = form;
    if (!refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required.');
    const row = this.tokenRow(refresh_token, 'refresh');
    if (!row) throw new OAuthError('invalid_grant', 'The refresh token is invalid or has expired.');
    if (row.revoked_at) {
      // Reuse of a rotated refresh token: treat the whole family as compromised.
      this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(iso(now()), row.family);
      throw new OAuthError('invalid_grant', 'The refresh token was already used.');
    }
    const scope = wanted ? this.cleanScope(wanted) : row.scope;
    if (!scope || !scope.split(' ').every((s) => row.scope.split(' ').includes(s))) throw new OAuthError('invalid_scope', 'The requested scope exceeds the original grant.');
    this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ?').run(iso(now()), row.hash);
    return this.issue(row.client_id, row.user_id, scope, row.family);
  }

  private issue(clientId: string, userId: string, scope: string, family: string) {
    const access = token();
    const refresh = token();
    const t = now();
    const ins = this.db.prepare('INSERT INTO oauth_tokens (hash, kind, client_id, user_id, scope, family, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(sha(access), 'access', clientId, userId, scope, family, iso(t + ACCESS_TTL_MS), iso(t));
    ins.run(sha(refresh), 'refresh', clientId, userId, scope, family, iso(t + REFRESH_TTL_MS), iso(t));
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope };
  }

  /** RFC 7009: the client gives a token back. Revoking a refresh token ends its whole family. */
  revoke(form: Record<string, string>): void {
    const given = form.token;
    if (!given) return;
    const row = this.db.prepare('SELECT hash, kind, family FROM oauth_tokens WHERE hash = ?').get(sha(given)) as { hash: string; kind: string; family: string } | undefined;
    if (!row) return;
    if (row.kind === 'refresh') this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(iso(now()), row.family);
    else this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL').run(iso(now()), row.hash);
  }

  /** The account behind a bearer token, or null. */
  authenticate(authorization: string | undefined): { userId: string; scope: string } | null {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) return null;
    const row = this.tokenRow(m[1], 'access');
    if (!row || row.revoked_at) return null;
    return { userId: row.user_id, scope: row.scope };
  }

  private tokenRow(raw: string, kind: 'access' | 'refresh') {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE hash = ? AND kind = ?').get(sha(raw), kind) as
      | { hash: string; kind: string; client_id: string; user_id: string; scope: string; family: string; expires_at: string; revoked_at: string | null }
      | undefined;
    return row && row.expires_at >= iso(now()) ? row : null;
  }

  private cleanScope(requested: string | undefined): string | null {
    if (!requested?.trim()) return SCOPES.join(' ');
    const parts = [...new Set(requested.trim().split(/\s+/))];
    return parts.every((s) => (SCOPES as readonly string[]).includes(s)) ? parts.join(' ') : null;
  }

  private purge(): void {
    const t = iso(now());
    this.db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(t);
  }

  // --- Pages -------------------------------------------------------------------------------

  signInPage(pendingId: string, error?: string): string {
    const p = this.pending(pendingId);
    if (!p) return this.errorPage('This sign-in link has expired. Start again from ChatGPT.');
    const id = escapeHtml(pendingId);
    return page(
      `Sign in to ${this.appName}`,
      `<h1>Sign in to ${escapeHtml(this.appName)}</h1>
<p class="muted"><strong>${escapeHtml(p.client_name)}</strong> wants to read and edit your documents and presentations. Sign in to continue; you can choose what to allow on the next page.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
${this.google ? `<a class="btn google" href="/oauth/google/start?p=${id}">Continue with Google</a><div class="or">or</div>` : ''}
<form method="post" action="/oauth/login">
  <input type="hidden" name="p" value="${id}">
  <label>Email <input type="email" name="email" autocomplete="username" required autofocus></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
  <button class="btn primary" type="submit">Sign in</button>
</form>`,
    );
  }

  consentPage(pendingId: string): string {
    const p = this.pending(pendingId);
    if (!p || !p.user_id) return this.errorPage('This sign-in link has expired. Start again from ChatGPT.');
    const who = this.profile(p.user_id);
    const id = escapeHtml(pendingId);
    const scopes = p.params.scope.split(' ').map((s) => `<li>${escapeHtml({ 'files:read': 'Read your documents and presentations', 'files:write': 'Create, change and delete your documents and presentations' }[s] ?? s)}</li>`).join('');
    return page(
      `Allow ${p.client_name}?`,
      `<h1>Allow ${escapeHtml(p.client_name)}?</h1>
<p class="muted">Signed in as <strong>${escapeHtml(who?.email ?? '')}</strong>. <a href="/oauth/switch?p=${id}">Not you?</a></p>
<p>${escapeHtml(p.client_name)} will be able to:</p>
<ul>${scopes}</ul>
<form method="post" action="/oauth/decision" class="row">
  <input type="hidden" name="p" value="${id}">
  <button class="btn" type="submit" name="allow" value="no">Deny</button>
  <button class="btn primary" type="submit" name="allow" value="yes">Allow</button>
</form>`,
    );
  }

  errorPage(message: string): string {
    return page('Sign-in problem', `<h1>Sign-in problem</h1><p class="error">${escapeHtml(message)}</p>`);
  }
}

interface ClientDoc {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

function isAllowedRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#f0f4f9;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f1f1f}
main{max-width:420px;margin:48px auto;background:#fff;border:1px solid #dadce0;border-radius:12px;padding:28px}
h1{font-size:22px;font-weight:500;margin:0 0 12px}.muted{color:#5f6368}.error{color:#d93025}
label{display:block;margin:12px 0 4px;font-weight:500}input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #dadce0;border-radius:8px;font:inherit}
.btn{display:inline-block;box-sizing:border-box;padding:9px 16px;border:1px solid #dadce0;border-radius:8px;background:#fff;font:inherit;cursor:pointer;text-decoration:none;color:inherit;text-align:center}
.btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}.btn.google{width:100%}form .btn.primary{margin-top:16px;width:100%}
.or{text-align:center;color:#5f6368;margin:14px 0 2px}.row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}.row .btn{width:auto}
</style></head><body><main>${body}</main></body></html>`;
}
