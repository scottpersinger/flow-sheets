import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app.ts';
import { mailbox, signUp } from '../../server/testing.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
const box = mailbox();

beforeAll(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-plugin-'));
  app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://docs.test', plugin: { publicUrl: 'https://docs.test', webDir: dir } });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('plugin mounted in the app', () => {
  it('proves the domain to OpenAI with the token it issued, as plain text', async () => {
    expect((await app.inject({ method: 'GET', url: '/.well-known/openai-apps-challenge' })).statusCode).toBe(404);
    process.env.OPENAI_APPS_CHALLENGE = ' challenge-token-123 ';
    try {
      const r = await app.inject({ method: 'GET', url: '/.well-known/openai-apps-challenge' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/plain');
      expect(r.body).toBe('challenge-token-123');
    } finally {
      delete process.env.OPENAI_APPS_CHALLENGE;
    }
  });

  it('serves the OAuth discovery documents and challenges the MCP endpoint', async () => {
    const prm = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(prm.statusCode).toBe(200);
    expect(prm.json()).toMatchObject({ resource: 'https://docs.test/mcp', authorization_servers: ['https://docs.test'] });
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(as.json()).toMatchObject({ issuer: 'https://docs.test', token_endpoint: 'https://docs.test/oauth/token' });
    const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(mcp.statusCode).toBe(401);
    expect(mcp.headers['www-authenticate']).toContain('resource_metadata=');
    const health = await app.inject({ method: 'GET', url: '/plugin/health' });
    expect(health.json()).toEqual({ ok: true, auth: 'oauth' });
    // /llms.txt tells an agent where the MCP server is and how to sign in, with or without a browser.
    const llms = await app.inject({ method: 'GET', url: '/llms.txt' });
    expect(llms.headers['content-type']).toContain('text/markdown');
    expect(llms.body).toContain('Endpoint: `https://docs.test/mcp/v2`');
    expect(llms.body).toContain('npx -y mcp-remote https://docs.test/mcp/v2 --device-code');
  });

  it("leaves the app's own routes alone", async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: null });
    const missing = await app.inject({ method: 'GET', url: '/plugin/nothing' });
    expect(missing.statusCode).toBe(404);
  });

  it('skips the sign-in page for a browser already signed in to the app', async () => {
    const { cookie } = await signUp(app, box, 'linked@x.com', 'password-12345');
    const q = new URLSearchParams({ response_type: 'code', client_id: 'dcr', redirect_uri: 'https://chatgpt.test/cb', code_challenge: 'c', code_challenge_method: 'S256' });
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.test/cb'] } });
    expect(reg.statusCode).toBe(201);
    q.set('client_id', reg.json().client_id);
    const anonymous = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.body).toContain('Sign in to');
    const signedIn = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: { cookie } });
    expect(signedIn.statusCode).toBe(302);
    expect(signedIn.headers.location).toMatch(/^\/oauth\/consent\?p=/);
    const consent = await app.inject({ method: 'GET', url: signedIn.headers.location as string });
    expect(consent.body).toContain('linked@x.com');
    // "Not you?" drops the session's account and asks for a sign-in; consent then needs one again.
    const pendingId = new URL(signedIn.headers.location as string, 'https://docs.test').searchParams.get('p')!;
    const switched = await app.inject({ method: 'GET', url: `/oauth/switch?p=${pendingId}` });
    expect(switched.body).toContain('Sign in to');
    const consentAgain = await app.inject({ method: 'GET', url: `/oauth/consent?p=${pendingId}` });
    expect(consentAgain.body).toContain('expired');
  });

  it('lists agents signed in with a device code on Settings, and disconnects them', async () => {
    const { cookie } = await signUp(app, box, 'agents@x.com', 'password-12345');
    const formBody = (b: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(b).toString() });
    const list = async (c = cookie) => (await app.inject({ method: 'GET', url: '/api/settings/agents', headers: { cookie: c } })).json();
    expect(await list()).toEqual({ enabled: true, agents: [] });

    const reg = await app.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: { client_name: 'mcp-remote', grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'] } });
    const clientId = reg.json().client_id as string;
    const issued = (await app.inject({ method: 'POST', url: '/oauth/device_authorization', ...formBody({ client_id: clientId, resource: 'https://docs.test/mcp/v2' }) })).json();
    // Signed in to the app in this browser: the code goes straight to consent.
    const entered = await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...formBody({}).headers, cookie }, payload: new URLSearchParams({ code: issued.user_code }).toString() });
    expect(entered.statusCode).toBe(302);
    const pendingId = new URL(entered.headers.location as string, 'https://docs.test').searchParams.get('p')!;
    await app.inject({ method: 'POST', url: '/oauth/decision', ...formBody({ p: pendingId, allow: 'yes' }) });
    const tokens = (await app.inject({ method: 'POST', url: '/oauth/token', ...formBody({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: issued.device_code, client_id: clientId }) })).json();
    const toolsList = () => app.inject({ method: 'POST', url: '/mcp/v2', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect((await toolsList()).statusCode).toBe(200);

    const { agents } = await list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'mcp-remote', endpoint: 'https://docs.test/mcp/v2' });
    // Another account neither sees it nor can disconnect it.
    const other = await signUp(app, box, 'someone@x.com', 'password-12345');
    expect((await list(other.cookie)).agents).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `/api/settings/agents/${agents[0].id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await toolsList()).statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: `/api/settings/agents/${agents[0].id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await list()).agents).toEqual([]);
    expect((await toolsList()).statusCode).toBe(401);
    const refresh = await app.inject({ method: 'POST', url: '/oauth/token', ...formBody({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) });
    expect(refresh.json().error).toBe('invalid_grant');
  });
});
