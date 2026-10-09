import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSlide, newId } from '../shared/deck.ts';
import { buildPptx } from '../shared/pptxExport.ts';
import { buildApp } from './app.ts';
import { buildDocx, mailbox, signUp } from './testing.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const box = mailbox();
const sentMail = box.sent;

beforeAll(async () => {
  // The default app must not pick up Google credentials from the environment.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-test-'));
  app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://sheets.test' });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : String(sc);
  return first.split(';')[0];
}

describe('password reset', () => {
  it('emails a one-time link that sets a new password and signs the user in', async () => {
    await signUp(app, box, 'reset@x.com', 'oldpassword1');
    sentMail.length = 0;

    // Unknown address: same answer, no mail.
    let res = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(sentMail).toHaveLength(0);

    res = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'Reset@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('reset@x.com');
    const link = /https:\/\/sheets\.test\/reset\?token=([A-Za-z0-9_-]+)/.exec(sentMail[0].text);
    expect(link).not.toBeNull();
    const token = link![1];

    res = await app.inject({ method: 'GET', url: `/api/auth/reset?token=${token}` });
    expect(res.json()).toEqual({ email: 'reset@x.com' });
    res = await app.inject({ method: 'GET', url: '/api/auth/reset?token=bogus' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'short' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'newpassword1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('reset@x.com');
    const cookie = cookieFrom(res);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().user.email).toBe('reset@x.com');

    // The link works once; the old password is gone; the new one works.
    res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'anotherpass1' } });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'reset@x.com', password: 'oldpassword1' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'reset@x.com', password: 'newpassword1' } })).statusCode).toBe(200);
  });

  it('limits reset requests per address', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'limited@x.com' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'limited@x.com' } });
    expect(res.statusCode).toBe(429);
  });
});

describe('google sign-in', () => {
  /** A Google that accepts any code and reports this identity. */
  function fakeGoogle(info: Record<string, unknown>) {
    const tokenBodies: URLSearchParams[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        tokenBodies.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: 'at-1', id_token: 'x', token_type: 'Bearer' });
      }
      if (String(url).startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
        return Response.json(info);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return { fetchFn, tokenBodies };
  }

  async function withGoogleApp(info: Record<string, unknown>, fn: (g: Awaited<ReturnType<typeof buildApp>>, tokenBodies: URLSearchParams[], gbox: ReturnType<typeof mailbox>) => Promise<void>) {
    const gdir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-google-'));
    const { fetchFn, tokenBodies } = fakeGoogle(info);
    const gbox = mailbox();
    const g = await buildApp({ dataDir: gdir, sendMail: gbox.send, appUrl: 'https://sheets.test', google: { clientId: 'cid', clientSecret: 'sec', fetch: fetchFn } });
    try {
      await fn(g, tokenBodies, gbox);
    } finally {
      await g.close();
      rmSync(gdir, { recursive: true, force: true });
    }
  }

  /** Runs /start and returns what the callback needs: the state and the state cookie. */
  async function start(g: Awaited<ReturnType<typeof buildApp>>, next?: string) {
    const res = await g.inject({ method: 'GET', url: `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}` });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://sheets.test/api/auth/google/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    const cookie = cookieFrom(res);
    expect(cookie).toBe(`gstate=${state}`);
    return { state, cookie };
  }

  it('is off unless configured', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).json().googleLogin).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/auth/google/start' })).statusCode).toBe(404);
  });

  it('creates an account on first sign-in and reuses it after', async () => {
    await withGoogleApp({ sub: 'g-1', email: 'Person@Gmail.com', email_verified: true }, async (g, tokenBodies) => {
      expect((await g.inject({ method: 'GET', url: '/api/auth/me' })).json().googleLogin).toBe(true);
      const { state, cookie } = await start(g, '/s/abc');
      let res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=the-code`, headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/s/abc');
      expect(tokenBodies[0].get('code')).toBe('the-code');
      expect(tokenBodies[0].get('code_verifier')).toBeTruthy();
      const sid = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      res = await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } });
      expect(res.json().user.email).toBe('person@gmail.com');
      const id = res.json().user.id;

      // A Google-created account has no password that works.
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'person@gmail.com', password: '' } })).statusCode).toBe(401);
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'person@gmail.com', password: 'anything1' } })).statusCode).toBe(401);

      // Second sign-in: same account; an off-site "next" falls back to the home page.
      const again = await start(g, 'https://evil.example/');
      res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${again.state}&code=c2`, headers: { cookie: again.cookie } });
      expect(res.headers.location).toBe('/');
      const sid2 = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid2 } })).json().user.id).toBe(id);
    });
  });

  it('links to an existing verified password account with the same email', async () => {
    await withGoogleApp({ sub: 'g-2', email: 'linked@x.com', email_verified: true }, async (g, _tokens, gbox) => {
      const { user } = await signUp(g, gbox, 'linked@x.com');
      const id = user.id;
      const { state, cookie } = await start(g);
      const res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie } });
      const sid = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } })).json().user.id).toBe(id);
      // The password still works too.
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'linked@x.com', password: 'password123' } })).statusCode).toBe(200);
    });
  });

  it('takes over an unverified password account with the same email', async () => {
    await withGoogleApp({ sub: 'g-4', email: 'squatted@x.com', email_verified: true }, async (g) => {
      // Someone registered with this address but never opened the verification link.
      const reg = await g.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'squatted@x.com', password: 'password123' } });
      expect(reg.statusCode).toBe(200);
      expect(reg.headers['set-cookie']).toBeUndefined();

      const { state, cookie } = await start(g);
      const res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie } });
      expect(res.headers.location).toBe('/');
      const sid = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } })).json().user.email).toBe('squatted@x.com');
      // The squatter's password no longer opens the account, and it now counts as taken.
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'squatted@x.com', password: 'password123' } })).statusCode).toBe(401);
      expect((await g.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'squatted@x.com', password: 'password456' } })).statusCode).toBe(409);
    });
  });

  it('rejects unverified emails, bad states and cancellations', async () => {
    await withGoogleApp({ sub: 'g-3', email: 'unverified@x.com', email_verified: false }, async (g) => {
      const { state, cookie } = await start(g);
      let res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/login\?error=.*verified/);
      expect(res.headers['set-cookie']).not.toEqual(expect.arrayContaining([expect.stringMatching(/^sid=/)]));

      // A state the server never issued, or one that doesn't match the browser's cookie.
      res = await g.inject({ method: 'GET', url: '/api/auth/google/callback?state=nope&code=c', headers: { cookie: 'gstate=nope' } });
      expect(res.headers.location).toMatch(/^\/login\?error=.*expired/);
      const fresh = await start(g);
      res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${fresh.state}&code=c` });
      expect(res.headers.location).toMatch(/^\/login\?error=.*expired/);

      res = await g.inject({ method: 'GET', url: '/api/auth/google/callback?error=access_denied' });
      expect(res.headers.location).toMatch(/^\/login\?error=.*cancelled/);
    });
  });
});

describe('auth', () => {
  it('registers, verifies the email, logs in and out', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'A@x.com', password: 'short' } });
    expect(res.statusCode).toBe(400);

    // Sign-up sends a link and gives no session yet.
    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'A@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pending: true, email: 'a@x.com' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sentMail.at(-1)?.to).toBe('a@x.com');
    expect(sentMail.at(-1)?.subject).toMatch(/verify/i);

    // The right password doesn't help until the link is opened.
    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('unverified');

    // Signing up again before verifying just replaces the password and sends a fresh link; the old link dies.
    const firstToken = box.tokenFor('a@x.com', 'verify');
    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'password456' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: firstToken } });
    expect(res.statusCode).toBe(400);

    // Send-again works for an unverified account and says nothing about unknown ones.
    res = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', payload: { email: 'a@x.com' } });
    expect(res.statusCode).toBe(200);
    const before = sentMail.length;
    res = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', payload: { email: 'ghost@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(sentMail.length).toBe(before);

    res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: box.tokenFor('a@x.com', 'verify') } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('a@x.com');
    const cookie = cookieFrom(res);
    // One use only.
    res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: box.tokenFor('a@x.com', 'verify') } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.json().user.email).toBe('a@x.com');

    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'wrongpass1' } });
    expect(res.statusCode).toBe(401);

    res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.json().user).toBe(null);

    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'password456' } });
    expect(res.statusCode).toBe(200);
  });

  it('limits verification emails per address', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/verify/resend', payload: { email: 'vlimited@x.com' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'vlimited@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(429);
  });
});

describe('sheets', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sheets' });
    expect(res.statusCode).toBe(401);
  });

  it('creates, saves, lists, renames and deletes sheets with per-user isolation', async () => {
    const { cookie } = await signUp(app, box, 'b@x.com');
    const { cookie: other } = await signUp(app, box, 'c@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget' } });
    const { sheet } = res.json();
    expect(sheet.title).toBe('Budget');
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${sheet.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    const { workbook } = res.json();
    expect(workbook.tabs[0].name).toBe('Sheet1');

    workbook.tabs[0].cells.A1 = { v: '=1+1' };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook: { version: 1, tabs: [] } } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.A1.v).toBe('=1+1');

    // Cell images are saved with the sheet; invalid ones are rejected.
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    workbook.tabs[0].cells.I9 = { v: '', img: png };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.I9).toEqual({ v: '', img: png });
    workbook.tabs[0].cells.I9 = { v: '', img: 'javascript:alert(1)' };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { title: 'Budget 2026' } });
    expect(res.json().sheet.title).toBe('Budget 2026');

    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets.map((s: { title: string }) => s.title)).toEqual(['Budget 2026']);

    res = await app.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${sheet.id}.json`);
    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets).toEqual([]);
  });
});

describe('CSV files', () => {
  it('imports a CSV as a spreadsheet, saves edits as CSV, and converts when it needs more', async () => {
    const { cookie } = await signUp(app, box, 'csv@x.com');
    const text = 'Item,"Price, each"\r\nPen,1.50\r\n';
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Prices', csv: text } });
    expect(res.statusCode).toBe(200);
    const { sheet } = res.json();
    expect(sheet).toMatchObject({ kind: 'sheet', format: 'csv', title: 'Prices' });
    const stored = () => JSON.parse(readFileSync(path.join(dir, 'sheets', `${sheet.id}.json`), 'utf8'));
    expect(stored()).toEqual({ version: 1, csv: text });

    // It opens as an ordinary workbook and is listed with the spreadsheets, marked as CSV.
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    const { workbook } = res.json();
    expect(res.json().sheet.format).toBe('csv');
    expect(workbook.tabs[0].cells).toEqual({ A1: { v: 'Item' }, B1: { v: 'Price, each' }, A2: { v: 'Pen' }, B2: { v: '1.50' } });
    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets[0]).toMatchObject({ id: sheet.id, format: 'csv' });

    // Edits are written back as CSV, keeping the file's line endings.
    workbook.tabs[0].cells.A3 = { v: 'Total' };
    workbook.tabs[0].cells.B3 = { v: '=B2*2' };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.json().sheet.format).toBe('csv');
    expect(stored()).toEqual({ version: 1, csv: 'Item,"Price, each"\r\nPen,1.50\r\nTotal,=B2*2\r\n' });

    // It downloads as the CSV file by default.
    res = await app.inject({ method: 'GET', url: `/api/files/${sheet.id}/export`, headers: { cookie } });
    expect(res.headers['content-disposition']).toContain('Prices.csv');
    expect(res.body).toBe('Item,"Price, each"\nPen,1.50\nTotal,=B2*2\n');

    // Converting makes it a native spreadsheet with the same content.
    res = await app.inject({ method: 'POST', url: `/api/sheets/${sheet.id}/convert`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().sheet.format).toBeUndefined();
    expect(stored().tabs[0].cells.B3).toEqual({ v: '=B2*2' });
    workbook.tabs[0].cells.A1 = { v: 'Item', st: { b: true } };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().sheet.format).toBeUndefined();
    expect(res.json().workbook.tabs[0].cells.A1).toEqual({ v: 'Item', st: { b: true } });
  });

  it('becomes a native spreadsheet rather than drop what CSV cannot store', async () => {
    const { cookie } = await signUp(app, box, 'csv2@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Data', csv: 'a,b\n1,2\n' } });
    const { sheet } = res.json();
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    const { workbook } = res.json();
    workbook.tabs[0].frozenRows = 1;
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.json().sheet.format).toBeUndefined();
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().sheet.format).toBeUndefined();
    expect(res.json().workbook.tabs[0]).toMatchObject({ frozenRows: 1, cells: { A1: { v: 'a' }, B2: { v: '2' } } });
  });

  it('rejects CSV that is not text or is too large', async () => {
    const { cookie } = await signUp(app, box, 'csv3@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'x', csv: 5 } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'x', csv: 'a'.repeat(10 * 1024 * 1024 + 1) } });
    expect(res.statusCode).toBe(400);
  });
});

describe('legacy hosts', () => {
  it('redirects retired host names to the app URL, keeping the path', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'sheetsweb-host-test-'));
    const a = await buildApp({ dataDir: d, appUrl: 'https://docs.example.com', legacyHosts: ['sheets.example.com'] });
    try {
      let res = await a.inject({ method: 'GET', url: '/s/abc?x=1', headers: { host: 'sheets.example.com' } });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('https://docs.example.com/s/abc?x=1');
      res = await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'SHEETS.example.com:443' } });
      expect(res.statusCode).toBe(200); // a port suffix is not the retired host; only exact matches redirect
      res = await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'docs.example.com' } });
      expect(res.statusCode).toBe(200);
    } finally {
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('documents', () => {
  it('creates, saves, lists, renames and deletes documents, kept apart from spreadsheets and decks', async () => {
    const { cookie } = await signUp(app, box, 'doc@x.com');
    const { cookie: other } = await signUp(app, box, 'doc2@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Notes' } });
    expect(res.statusCode).toBe(200);
    const { doc: meta } = res.json();
    expect(meta).toMatchObject({ title: 'Notes', kind: 'doc' });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${meta.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/docs/${meta.id}`, headers: { cookie } });
    const { doc } = res.json();
    expect(doc.content.content).toHaveLength(1);

    doc.content.content = [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello', marks: [{ type: 'bold' }] }] }, { type: 'paragraph' }];
    res = await app.inject({ method: 'PUT', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { doc } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/docs/${meta.id}`, headers: { cookie } });
    expect(res.json().doc.content.content[0].content[0].text).toBe('Hello');

    // Invalid documents are rejected; the document is not a spreadsheet or a deck and vice versa.
    res = await app.inject({ method: 'PUT', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, content: { type: 'doc', content: [{ type: 'bogus' }] } } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:1' } }] } } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Bad', doc: { version: 2 } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'A deck' } });
    res = await app.inject({ method: 'GET', url: `/api/docs/${res.json().deck.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } });
    expect(res.json().docs.map((d: { title: string }) => d.title)).toEqual(['Notes']);
    res = await app.inject({ method: 'GET', url: '/api/decks', headers: { cookie } });
    expect(res.json().decks.map((d: { title: string }) => d.title)).toEqual(['A deck']);
    res = await app.inject({ method: 'GET', url: `/api/docs/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { title: 'Notes 2026' } });
    expect(res.json().meta.title).toBe('Notes 2026');

    // Word import: a new document from the upload, or just the converted blocks.
    const docx = await buildDocx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>From Word</w:t></w:r></w:p><w:p><w:r><w:t>Body.</w:t></w:r></w:p>');
    res = await app.inject({ method: 'POST', url: '/api/docs/import?title=Memo', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: docx });
    expect(res.statusCode).toBe(200);
    expect(res.json().doc).toMatchObject({ title: 'Memo', kind: 'doc' });
    res = await app.inject({ method: 'GET', url: `/api/docs/${res.json().doc.id}`, headers: { cookie } });
    expect(res.json().doc.content.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    // PDF import: stored as a file only; no document is created.
    const docsBefore = (await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } })).json().docs.length;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 40 >>\nstream\nBT /F1 12 Tf 72 700 Td (Hello PDF) Tj ET\nendstream\nendobj\n%%EOF');
    res = await app.inject({ method: 'POST', url: '/api/import/pdf?filename=Scan.pdf', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: pdf });
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatchObject({ filename: 'Scan.pdf', type: 'application/pdf' });
    res = await app.inject({ method: 'GET', url: '/api/files', headers: { cookie } });
    expect(res.json().files[0]).toMatchObject({ filename: 'Scan.pdf', type: 'application/pdf' });
    res = await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } });
    expect(res.json().docs.length).toBe(docsBefore);
    res = await app.inject({ method: 'POST', url: '/api/import/pdf?filename=x.pdf', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a valid PDF/);
    res = await app.inject({ method: 'POST', url: '/api/import/docx', headers: { cookie, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, payload: docx });
    expect(res.json().doc.content.content).toHaveLength(2);
    res = await app.inject({ method: 'POST', url: '/api/import/docx', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'DELETE', url: `/api/docs/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${meta.id}.json`);
  });
});

describe('markdown documents', () => {
  it('creates from text, saves with revision checks, lists, exports, renames and deletes, kept apart from other kinds', async () => {
    const { cookie } = await signUp(app, box, 'md@x.com');
    const { cookie: other } = await signUp(app, box, 'md2@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/markdown', headers: { cookie }, payload: { title: 'README', text: '# Hello\n\n- [x] done' } });
    expect(res.statusCode).toBe(200);
    const { doc: meta } = res.json();
    expect(meta).toMatchObject({ title: 'README', kind: 'markdown' });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${meta.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.json().doc).toEqual({ version: 1, text: '# Hello\n\n- [x] done' });

    // Saves carry the revision loaded; a stale one is refused with the current metadata.
    res = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, text: '# Hi' }, rev: meta.updatedAt } });
    expect(res.statusCode).toBe(200);
    const rev = res.json().meta.updatedAt;
    res = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, text: '# Stale' }, rev: meta.updatedAt } });
    expect(res.statusCode).toBe(409);
    expect(res.json().meta.updatedAt).toBe(rev);
    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.json().doc.text).toBe('# Hi');

    // Invalid documents are rejected; the document is not a text document, spreadsheet or deck and vice versa.
    res = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, text: 5 } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/markdown', headers: { cookie }, payload: { title: 'Bad', text: {} } });
    expect(res.statusCode).toBe(400);
    for (const url of [`/api/docs/${meta.id}`, `/api/sheets/${meta.id}`, `/api/decks/${meta.id}`]) {
      res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    }
    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Notes' } });
    res = await app.inject({ method: 'GET', url: `/api/markdown/${res.json().doc.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: '/api/markdown', headers: { cookie } });
    expect(res.json().docs.map((d: { title: string }) => d.title)).toEqual(['README']);
    res = await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } });
    expect(res.json().docs.map((d: { title: string }) => d.title)).toEqual(['Notes']);
    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    // Exports: the text itself as .md (the default), or the stored JSON.
    res = await app.inject({ method: 'GET', url: `/api/files/${meta.id}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('README.md');
    expect(res.body).toBe('# Hi');
    res = await app.inject({ method: 'GET', url: `/api/files/${meta.id}/export?format=xlsx`, headers: { cookie } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PATCH', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { title: 'README 2026' } });
    expect(res.json().meta.title).toBe('README 2026');
    res = await app.inject({ method: 'DELETE', url: `/api/markdown/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'DELETE', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${meta.id}.json`);
  });
});

describe('presentations', () => {
  it('creates, saves, lists, renames and deletes decks, kept apart from spreadsheets', async () => {
    const { cookie } = await signUp(app, box, 'deck@x.com');
    const { cookie: other } = await signUp(app, box, 'deck2@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Kickoff' } });
    expect(res.statusCode).toBe(200);
    const { deck: meta } = res.json();
    expect(meta).toMatchObject({ title: 'Kickoff', kind: 'deck' });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${meta.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie } });
    const { deck } = res.json();
    expect(deck.slides).toHaveLength(1);
    expect(deck.theme).toBe('light');

    deck.theme = 'dark';
    deck.slides.push({ id: 's2', layout: 'blank', elements: [{ id: 'e1', type: 'text', x: 10, y: 10, w: 300, h: 60, paragraphs: [{ text: 'Hello', bullet: true }] }] });
    res = await app.inject({ method: 'PUT', url: `/api/decks/${meta.id}`, headers: { cookie }, payload: { deck } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie } });
    expect(res.json().deck.slides[1].elements[0].paragraphs[0].text).toBe('Hello');

    // Invalid decks are rejected; the deck is not a spreadsheet and vice versa.
    res = await app.inject({ method: 'PUT', url: `/api/decks/${meta.id}`, headers: { cookie }, payload: { deck: { version: 1, theme: 'light', slides: [] } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Bad', deck: { version: 2 } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'A sheet' } });
    const sheetId = res.json().sheet.id;
    res = await app.inject({ method: 'GET', url: `/api/decks/${sheetId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'DELETE', url: `/api/decks/${sheetId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);

    // Lists stay separate, and other users see nothing.
    res = await app.inject({ method: 'GET', url: '/api/decks', headers: { cookie } });
    expect(res.json().decks.map((d: { title: string }) => d.title)).toEqual(['Kickoff']);
    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets.map((s: { title: string; kind: string }) => [s.title, s.kind])).toEqual([['A sheet', 'sheet']]);
    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: `/api/decks/${meta.id}`, headers: { cookie }, payload: { title: 'Kickoff 2026' } });
    expect(res.json().meta.title).toBe('Kickoff 2026');

    // PowerPoint import: a new deck from the upload, or just the converted slides.
    const { pres } = await buildPptx({ version: 1, theme: 'light', slides: [buildSlide('title-body', { title: 'From PowerPoint', body: ['One', 'Two'] }, newId)] }, 'x', async () => null);
    const pptx = Buffer.from((await pres.write({ outputType: 'nodebuffer' })) as Buffer);
    res = await app.inject({ method: 'POST', url: '/api/decks/import?title=Slides', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: pptx });
    expect(res.statusCode).toBe(200);
    expect(res.json().deck).toMatchObject({ title: 'Slides', kind: 'deck' });
    res = await app.inject({ method: 'GET', url: `/api/decks/${res.json().deck.id}`, headers: { cookie } });
    expect(res.json().deck.slides[0].elements[0].paragraphs[0].text).toBe('From PowerPoint');
    res = await app.inject({ method: 'POST', url: '/api/import/pptx', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: pptx });
    expect(res.json().deck.slides).toHaveLength(1);
    res = await app.inject({ method: 'POST', url: '/api/import/pptx', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'DELETE', url: `/api/decks/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${meta.id}.json`);
  });
});

describe('stored files', () => {
  it('stores PDFs per owner, serves them inline and as downloads, and lists them newest first', async () => {
    const { cookie } = await signUp(app, box, 'files@x.com');
    const { cookie: other } = await signUp(app, box, 'files2@x.com');
    const pdf = Buffer.from('%PDF-1.4 test');
    let res = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('BizTrip Review.pdf') }, payload: pdf });
    expect(res.statusCode).toBe(200);
    const { file } = res.json();
    expect(file).toMatchObject({ filename: 'BizTrip Review.pdf', type: 'application/pdf', size: pdf.length, url: `/api/files/${file.id}`, downloadUrl: `/api/files/${file.id}/download` });
    res = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'a.bin' }, payload: Buffer.from('xyz') });
    const second = res.json().file;

    res = await app.inject({ method: 'GET', url: file.url, headers: { cookie } });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.rawPayload.equals(pdf)).toBe(true);
    res = await app.inject({ method: 'GET', url: file.downloadUrl, headers: { cookie } });
    expect(res.headers['content-disposition']).toContain('attachment; filename="BizTrip Review.pdf"');
    // Unknown types are never served inline.
    res = await app.inject({ method: 'GET', url: second.url, headers: { cookie } });
    expect(res.headers['content-disposition']).toContain('attachment');

    // A web page is stored as one by its name, but never served as a page: the viewer shows its text in a sandboxed frame.
    res = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'chart.html' }, payload: Buffer.from('<script>alert(1)</script>') });
    const page = res.json().file;
    expect(page).toMatchObject({ filename: 'chart.html', type: 'text/html' });
    res = await app.inject({ method: 'GET', url: page.url, headers: { cookie } });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.payload).toBe('<script>alert(1)</script>');
    expect((await app.inject({ method: 'GET', url: page.downloadUrl, headers: { cookie } })).headers['content-disposition']).toContain('attachment');
    await app.inject({ method: 'DELETE', url: page.url, headers: { cookie } });

    res = await app.inject({ method: 'GET', url: '/api/files', headers: { cookie } });
    expect(res.json().files.map((f: { id: string }) => f.id)).toEqual([second.id, file.id]);
    expect(res.json().files).toHaveLength(2);

    // Other users and signed-out requests can't see it.
    expect((await app.inject({ method: 'GET', url: file.url, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/files', headers: { cookie: other } })).json().files).toEqual([]);
    expect((await app.inject({ method: 'GET', url: file.url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: file.url, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: file.url, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${file.url}/meta`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('cell images', () => {
  it('stores large images as files referenced from cells, readable only by their owner', async () => {
    const { cookie } = await signUp(app, box, 'img@x.com');
    const { cookie: other } = await signUp(app, box, 'img2@x.com');
    let res;

    // A 50 MB PNG.
    const big = Buffer.alloc(50 * 1024 * 1024, 7);
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: big });
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);

    res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(big)).toBe(true);
    res = await app.inject({ method: 'GET', url, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    // The cell holds only the reference, and is saved with the sheet.
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Team Budget' } });
    const { sheet } = res.json();
    const workbook = (await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } })).json().workbook;
    workbook.tabs[0].cells.A15 = { v: '', img: url };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.A15).toEqual({ v: '', img: url });

    // Over 100 MB, other types and signed-out uploads are refused.
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(100 * 1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/svg+xml' }, payload: '<svg/>' });
    expect(res.statusCode).toBe(415);
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: Buffer.from('x') });
    expect(res.statusCode).toBe(401);
  });
});

describe('branches', () => {
  it('branches a sheet, compares against the live original, and detaches when it is deleted', async () => {
    const { cookie } = await signUp(app, box, 'br@x.com');
    let res;
    const put = (id: string, workbook: unknown) => app.inject({ method: 'PUT', url: `/api/sheets/${id}`, headers: { cookie }, payload: { workbook } });

    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Plan' } });
    const orig = res.json().sheet;
    const wb = (await app.inject({ method: 'GET', url: `/api/sheets/${orig.id}`, headers: { cookie } })).json().workbook;
    wb.tabs[0].cells.A1 = { v: 'v1' };
    await put(orig.id, wb);

    res = await app.inject({ method: 'POST', url: `/api/sheets/${orig.id}/branch`, headers: { cookie }, payload: {} });
    const branch = res.json().sheet;
    expect(branch.title).toBe('Plan (branch)');
    expect(branch.branch).toMatchObject({ parentId: orig.id, parentTitle: 'Plan', detached: false });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${branch.id}.base.json`);

    // The original moves on; compare returns the base snapshot plus the original's current state.
    wb.tabs[0].cells.A1 = { v: 'v2' };
    await put(orig.id, wb);
    await app.inject({ method: 'PATCH', url: `/api/sheets/${orig.id}`, headers: { cookie }, payload: { title: 'Plan 2027' } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${branch.id}/compare`, headers: { cookie } });
    const cmp = res.json();
    expect(cmp.base.tabs[0].cells.A1.v).toBe('v1');
    expect(cmp.original.tabs[0].cells.A1.v).toBe('v2');
    expect(cmp.meta.branch.parentTitle).toBe('Plan 2027');

    res = await app.inject({ method: 'GET', url: `/api/sheets/${orig.id}/compare`, headers: { cookie } });
    expect(res.statusCode).toBe(400);

    // Deleting the original detaches the branch but keeps it comparable against the base.
    await app.inject({ method: 'DELETE', url: `/api/sheets/${orig.id}`, headers: { cookie } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${branch.id}/compare`, headers: { cookie } });
    expect(res.json().original).toBe(null);
    expect(res.json().meta.branch).toMatchObject({ detached: true, parentTitle: 'Plan' });

    await app.inject({ method: 'DELETE', url: `/api/sheets/${branch.id}`, headers: { cookie } });
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${branch.id}.base.json`);
  });

  it('migrates a database created before branches existed', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { openDb } = await import('./db.ts');
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sheets (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO sheets VALUES ('s1', 'u1', 'Old', 's1.json', 'x', 'x');`);
    old.close();
    const db = openDb(file);
    const cols = (db.prepare('PRAGMA table_info(sheets)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['parent_id', 'parent_title', 'branched_at']));
    expect((db.prepare('SELECT title, parent_id FROM sheets').get() as { title: string; parent_id: null }).parent_id).toBe(null);
    db.close();
  });
});

describe('video files', () => {
  it('are stored by their extension and served in the parts a player asks for', async () => {
    const { cookie } = await signUp(app, box, 'video@x.com');
    const bytes = Buffer.from('0123456789abcdefghij');
    const up = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'video/quicktime', 'x-filename': 'clip.mov' }, payload: bytes });
    expect(up.statusCode).toBe(200);
    const file = (up.json() as { file: { url: string; type: string } }).file;
    expect(file.type).toBe('video/quicktime');

    const whole = await app.inject({ method: 'GET', url: file.url, headers: { cookie } });
    expect(whole.statusCode).toBe(200);
    // Served as MP4 so browsers play it, and seekable.
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe('20');

    const part = await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=5-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 5-9/20');
    expect(part.body).toBe('56789');
    const tail = await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=-4' } });
    expect([tail.headers['content-range'], tail.body]).toEqual(['bytes 16-19/20', 'ghij']);
    const rest = await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=15-' } });
    expect([rest.headers['content-range'], rest.body]).toEqual(['bytes 15-19/20', 'fghij']);
    expect((await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=50-' } })).statusCode).toBe(416);
  });
});
