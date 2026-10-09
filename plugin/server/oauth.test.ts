import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService, hashPassword } from '../../server/auth.ts';
import { openDb } from '../../server/db.ts';
import { FileHub } from './files.ts';
import { createPluginServer } from './http.ts';
import { OAuthServer, redirectMatches } from './oauth.ts';

const CLIENT_DOC_URL = 'https://chatgpt.example/oauth/client.json';
const REDIRECT = 'https://chatgpt.example/connector/callback';

let dir: string;
let base: string;
let close: () => Promise<void>;
let oauth: OAuthServer;

/** Serves the client metadata document; everything else is refused. */
const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  if (url === CLIENT_DOC_URL) return new Response(JSON.stringify({ client_id: CLIENT_DOC_URL, client_name: 'ChatGPT', redirect_uris: [REDIRECT] }), { headers: { 'content-type': 'application/json' } });
  return new Response('nope', { status: 404 });
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-oauth-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)').run('u1', 'a@example.com', await hashPassword('secret-pw'), new Date().toISOString(), new Date().toISOString());
  const hub = new FileHub({ db, dataDir: dir, publicUrl: null });
  await hub.init();
  await hub.forUser('u1').createDoc('Mine', 'Hello.\n');
  oauth = new OAuthServer({ db: new DatabaseSync(path.join(dir, 'plugin.db')), issuer: 'https://plugin.example', resource: 'https://plugin.example/mcp', auth: new AuthService(db), profile: (id) => hub.profile(id), fetchFn: fakeFetch });
  const server = createPluginServer({ hub, oauth, publicUrl: null, webDir: dir, production: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'manual' as const });
const mcp = (token: string | null, body: unknown) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

/** The whole browser side of the code flow with PKCE, as ChatGPT would drive it. */
async function obtainCode(opts: { clientId?: string; verifier: string; signIn?: (pendingId: string) => Promise<void> } = { verifier: 'v' }) {
  const clientId = opts.clientId ?? CLIENT_DOC_URL;
  const challenge = createHash('sha256').update(opts.verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'files:read files:write', state: 'st8', resource: 'https://plugin.example/mcp' });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  expect(page.status).toBe(200);
  const htmlText = await page.text();
  const pendingId = /name="p" value="([^"]+)"/.exec(htmlText)![1];
  if (opts.signIn) await opts.signIn(pendingId);
  else {
    const login = await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'secret-pw' }));
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe(`/oauth/consent?p=${encodeURIComponent(pendingId)}`);
  }
  const consent = await fetch(`${base}/oauth/consent?p=${pendingId}`);
  expect(await consent.text()).toContain('a@example.com');
  const decision = await fetch(`${base}/oauth/decision`, form({ p: pendingId, allow: 'yes' }));
  expect(decision.status).toBe(302);
  const back = new URL(decision.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st8');
  expect(back.searchParams.get('iss')).toBe('https://plugin.example');
  return { code: back.searchParams.get('code')!, clientId };
}

describe('OAuth', () => {
  it('publishes discovery documents at every path ChatGPT probes', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/mcp/.well-known/oauth-protected-resource']) {
      const r = await fetch(base + p).then((r) => r.json());
      expect(r).toMatchObject({ resource: 'https://plugin.example/mcp', authorization_servers: ['https://plugin.example'] });
    }
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/mcp']) {
      const r = await fetch(base + p).then((r) => r.json());
      expect(r).toMatchObject({ issuer: 'https://plugin.example', code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
    }
  });

  it('refuses the MCP endpoint without a token, pointing at the resource metadata', async () => {
    const r = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://plugin.example/.well-known/oauth-protected-resource/mcp"');
    const bad = await mcp('nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('runs the code flow with a client metadata document and PKCE, then serves that account', async () => {
    const { code } = await obtainCode({ verifier: 'the-verifier-value-1234567890' });
    const wrong = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'wrong', redirect_uri: REDIRECT, client_id: CLIENT_DOC_URL }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_grant');
    const ok = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'the-verifier-value-1234567890', redirect_uri: REDIRECT, client_id: CLIENT_DOC_URL, resource: 'https://plugin.example/mcp' }));
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as { access_token: string; refresh_token: string; token_type: string; scope: string };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('files:read files:write');
    const files = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_files', arguments: {} } }).then((r) => r.json());
    expect((files.result.structuredContent.files as { title: string }[]).map((f) => f.title)).toEqual(['Mine']);
    const profile = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_profile', arguments: {} } }).then((r) => r.json());
    expect(profile.result.structuredContent).toMatchObject({ id: 'u1', email: 'a@example.com' });
    // The code is single use; replaying it kills what it issued.
    const replay = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'the-verifier-value-1234567890', redirect_uri: REDIRECT }));
    expect(replay.status).toBe(400);
    expect((await mcp(tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(401);
  });

  it('rotates refresh tokens and revokes a family on reuse or revocation', async () => {
    const { code } = await obtainCode({ verifier: 'another-verifier-value-123456' });
    const first = (await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'another-verifier-value-123456' })).then((r) => r.json())) as { access_token: string; refresh_token: string };
    const second = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).then((r) => r.json());
    expect(second.access_token).not.toBe(first.access_token);
    expect((await mcp(second.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    const reuse = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token }));
    expect(reuse.status).toBe(400);
    expect((await mcp(second.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    const { code: code2 } = await obtainCode({ verifier: 'third-verifier-value-1234567' });
    const third = (await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code: code2, code_verifier: 'third-verifier-value-1234567' })).then((r) => r.json())) as { access_token: string; refresh_token: string };
    expect((await fetch(`${base}/oauth/revoke`, form({ token: third.refresh_token }))).status).toBe(200);
    expect((await mcp(third.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('lets an app on this computer come back on any port, and only there', () => {
    const registered = 'http://localhost/callback';
    expect(redirectMatches(registered, 'http://localhost:53712/callback')).toBe(true);
    expect(redirectMatches(registered, 'http://localhost/callback')).toBe(true);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:8080/callback')).toBe(true);
    for (const other of ['http://localhost:53712/other', 'http://127.0.0.1:53712/callback', 'http://localhost.evil.example:53712/callback', 'https://localhost:53712/callback', 'http://user@localhost:53712/callback', 'http://localhost:53712/callback?x=1', 'not a url']) {
      expect(redirectMatches(registered, other)).toBe(false);
    }
    // Anything that is not a loopback address must match exactly.
    expect(redirectMatches('https://claude.example/cb', 'https://claude.example:8443/cb')).toBe(false);
    expect(redirectMatches('https://claude.example/cb', 'https://claude.example/cb')).toBe(true);
  });

  it('registers clients dynamically and checks their redirect URIs', async () => {
    const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.example/cb'], token_endpoint_auth_method: 'none' }) });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };
    const bad = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' })}`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('not registered');
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.example/cb', code_challenge: 'x', code_challenge_method: 'S256' })}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Claude');
  });

  it('sends parameter problems back to a genuine client as redirects, and rejects wrong passwords and denials', async () => {
    const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: REDIRECT, state: 's' })}`, { redirect: 'manual' });
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s');
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: REDIRECT, code_challenge: 'c', code_challenge_method: 'S256' });
    const pendingId = /name="p" value="([^"]+)"/.exec(await fetch(`${base}/oauth/authorize?${q}`).then((r) => r.text()))![1];
    const wrong = await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'nope' }));
    expect(await wrong.text()).toContain('Wrong email or password');
    const consentTooEarly = await fetch(`${base}/oauth/consent?p=${pendingId}`).then((r) => r.text());
    expect(consentTooEarly).toContain('expired');
    await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'secret-pw' }));
    const deny = await fetch(`${base}/oauth/decision`, form({ p: pendingId, allow: 'no' }));
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
});
