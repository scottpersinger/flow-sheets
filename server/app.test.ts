import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-test-'));
  app = await buildApp({ dataDir: dir });
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
