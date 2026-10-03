import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const sentMail: { to: string; subject: string; text: string }[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-test-'));
  app = await buildApp({ dataDir: dir, sendMail: async (m) => void sentMail.push(m), appUrl: 'https://sheets.test' });
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
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'reset@x.com', password: 'oldpassword1' } });

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

describe('auth', () => {
  it('registers, logs in and out', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'A@x.com', password: 'short' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'A@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('a@x.com');
    const cookie = cookieFrom(res);

    res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.json().user.email).toBe('a@x.com');

    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'wrongpass1' } });
    expect(res.statusCode).toBe(401);

    res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.json().user).toBe(null);

    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('sheets', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sheets' });
    expect(res.statusCode).toBe(401);
  });

  it('creates, saves, lists, renames and deletes sheets with per-user isolation', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'b@x.com', password: 'password123' } });
    const cookie = cookieFrom(res);
    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'c@x.com', password: 'password123' } });
    const other = cookieFrom(res);

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

describe('cell images', () => {
  it('stores large images as files referenced from cells, readable only by their owner', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'img@x.com', password: 'password123' } });
    const cookie = cookieFrom(res);
    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'img2@x.com', password: 'password123' } });
    const other = cookieFrom(res);

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
    let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'br@x.com', password: 'password123' } });
    const cookie = cookieFrom(res);
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
