import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SheetMeta, StoredFile, Workbook } from '../shared/types.ts';
import { buildApp, LOCAL_COOKIE } from './app.ts';

// The desktop app's storage: a folder of real files instead of the data directory (server/localStore.ts).
let folder: string;
let dataDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const at = (...parts: string[]) => path.join(folder, ...parts);
const call = async <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object | undefined });
  return { status: res.statusCode, body: res.json() as T };
};
const sheets = async () => (await call<{ sheets: SheetMeta[] }>('GET', '/api/sheets')).body.sheets;
interface Library {
  folders: { name: string; path: string }[];
  docs: SheetMeta[];
  files: StoredFile[];
}
const library = async (folder = '') => (await call<Library>('GET', `/api/library${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`)).body;
const markdown = async () => (await call<{ docs: SheetMeta[] }>('GET', '/api/markdown')).body.docs;

beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'sheetsweb-folder-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
  mkdirSync(at('reports'));
  mkdirSync(at('.git'));
  mkdirSync(at('node_modules', 'pkg'), { recursive: true });
  writeFileSync(at('notes.md'), '# Notes\n\nHello\n');
  writeFileSync(at('reports', 'stock.csv'), 'name,qty\r\napple,3\r\n');
  writeFileSync(at('scan.pdf'), '%PDF-1.4 test');
  writeFileSync(at('.git', 'hidden.md'), 'hidden');
  writeFileSync(at('node_modules', 'pkg', 'README.md'), 'dependency');
  writeFileSync(at('script.py'), 'print(1)');
  app = await buildApp({ dataDir, local: { dir: folder } });
});

afterAll(async () => {
  await app.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a mounted folder', () => {
  it('needs no sign-in and reports the folder', async () => {
    const me = await call<{ user: { id: string } | null; local?: { dir: string } }>('GET', '/api/auth/me');
    expect(me.body.user?.id).toBe('local');
    expect(me.body.local?.dir).toBe(path.resolve(folder));
  });

  it('shows one folder at a time: its folders and the files it can open, without hidden folders and node_modules', async () => {
    const top = await library();
    expect(top.folders).toEqual([{ name: 'reports', path: 'reports' }]);
    expect(top.docs.map((d) => [d.title, d.kind])).toEqual([['notes', 'markdown']]);
    expect(top.files.map((f) => [f.filename, f.type])).toEqual([['scan.pdf', 'application/pdf']]);
    const reports = await library('reports');
    expect(reports.folders).toEqual([]);
    expect(reports.docs.map((d) => [d.title, d.format, d.folder])).toEqual([['stock', 'csv', 'reports']]);
    expect((await call('GET', '/api/library?folder=missing')).status).toBe(404);
    expect((await call('GET', '/api/library?folder=..')).status).toBe(404);
  });

  it('says so when a folder cannot be read, rather than showing it empty', async () => {
    mkdirSync(at('locked'));
    chmodSync(at('locked'), 0o000);
    try {
      const res = await call<{ error: string }>('GET', '/api/library?folder=locked');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/permission to read “locked”/);
    } finally {
      chmodSync(at('locked'), 0o755);
      rmSync(at('locked'), { recursive: true });
    }
  });

  it('lists every file of a kind for the assistant, wherever it is', async () => {
    expect((await markdown()).map((d) => d.title)).toEqual(['notes']);
    expect((await sheets()).map((s) => [s.title, s.folder, s.format])).toEqual([['stock', 'reports', 'csv']]);
  });

  it('reads and writes Markdown files as plain text', async () => {
    const [meta] = await markdown();
    const loaded = await call<{ meta: SheetMeta; doc: { text: string } }>('GET', `/api/markdown/${meta.id}`);
    expect(loaded.body.doc.text).toBe('# Notes\n\nHello\n');
    const saved = await call<{ meta: SheetMeta }>('PUT', `/api/markdown/${meta.id}`, { doc: { version: 1, text: '# Notes\n\nChanged\n' }, rev: loaded.body.meta.updatedAt });
    expect(saved.status).toBe(200);
    expect(readFileSync(at('notes.md'), 'utf8')).toBe('# Notes\n\nChanged\n');
    // No temp files are left next to it.
    expect(readdirSync(folder).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a save over a file that was edited outside the app', async () => {
    const [meta] = await markdown();
    writeFileSync(at('notes.md'), 'edited in another program');
    utimesSync(at('notes.md'), new Date(), new Date(Date.now() + 5000));
    const saved = await call('PUT', `/api/markdown/${meta.id}`, { doc: { version: 1, text: 'mine' }, rev: meta.updatedAt });
    expect(saved.status).toBe(409);
    expect(readFileSync(at('notes.md'), 'utf8')).toBe('edited in another program');
  });

  it('keeps a CSV file as CSV, and renames it when it becomes a spreadsheet', async () => {
    const [meta] = await sheets();
    const { workbook } = (await call<{ workbook: Workbook }>('GET', `/api/sheets/${meta.id}`)).body;
    workbook.tabs[0].cells.B2 = { v: '4' };
    await call('PUT', `/api/sheets/${meta.id}`, { workbook });
    expect(readFileSync(at('reports', 'stock.csv'), 'utf8')).toBe('name,qty\r\napple,4\r\n');

    const converted = await call<{ sheet: SheetMeta }>('POST', `/api/sheets/${meta.id}/convert`, {});
    expect(converted.body.sheet.format).toBeUndefined();
    expect(existsSync(at('reports', 'stock.csv'))).toBe(false);
    expect((JSON.parse(readFileSync(at('reports', 'stock.ffsheet'), 'utf8')) as Workbook).tabs[0].cells.B2.v).toBe('4');
    // Same document, same place in the list.
    expect((await sheets()).map((s) => [s.id, s.title, s.folder, s.format])).toEqual([[meta.id, 'stock', 'reports', undefined]]);
  });

  it('creates new documents as files named by their title, without overwriting', async () => {
    const a = await call<{ doc: SheetMeta }>('POST', '/api/markdown', { title: 'notes', text: 'second' });
    expect(a.body.doc.title).toBe('notes 2');
    expect(readFileSync(at('notes 2.md'), 'utf8')).toBe('second');
    const deck = await call<{ deck: SheetMeta }>('POST', '/api/decks', { title: 'Q3: kickoff', folder: 'reports' });
    expect([deck.body.deck.title, deck.body.deck.folder]).toEqual(['Q3 kickoff', 'reports']);
    expect(existsSync(at('reports', 'Q3 kickoff.ffslides'))).toBe(true);
    // Neither a title nor a folder can reach outside the mounted folder.
    const out = await call<{ doc: SheetMeta }>('POST', '/api/markdown', { title: '../../escape' });
    expect(out.body.doc.title).toBe('-..-escape');
    expect(existsSync(at('-..-escape.md'))).toBe(true);
    expect((await call('POST', '/api/markdown', { title: 'x', folder: '../outside' })).status).toBe(404);
  });

  it('makes folders as directories, moves files between them and deletes only empty ones', async () => {
    expect((await call('POST', '/api/folders', { name: 'archive' })).status).toBe(200);
    expect((await call('POST', '/api/folders', { name: 'archive' })).status).toBe(409);
    expect((await call('POST', '/api/folders', { name: '../up' })).status).toBe(400);
    expect((await call('POST', '/api/folders', { name: '2026', folder: 'archive' })).status).toBe(200);
    expect(existsSync(at('archive', '2026'))).toBe(true);

    const doc = (await library()).docs.find((d) => d.title === 'notes 2')!;
    expect((await call('POST', '/api/library/move', { kind: 'markdown', id: doc.id, folder: 'archive/2026' })).status).toBe(200);
    expect(existsSync(at('notes 2.md'))).toBe(false);
    expect(readFileSync(at('archive', '2026', 'notes 2.md'), 'utf8')).toBe('second');
    expect((await library('archive/2026')).docs.map((d) => [d.id, d.title])).toEqual([[doc.id, 'notes 2']]);

    const [pdf] = (await library()).files;
    expect((await call('POST', '/api/library/move', { kind: 'file', id: pdf.id, folder: 'archive' })).status).toBe(200);
    expect(existsSync(at('archive', 'scan.pdf'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: pdf.url })).body).toBe('%PDF-1.4 test');
    await call('POST', '/api/library/move', { kind: 'file', id: pdf.id, folder: '' });

    expect((await call('DELETE', '/api/folders?folder=archive')).status).toBe(409);
    // A directory holding files the library does not list is not empty either.
    mkdirSync(at('code'));
    writeFileSync(at('code', 'main.py'), 'print(1)');
    expect((await call('DELETE', '/api/folders?folder=code')).status).toBe(409);
    expect(existsSync(at('code', 'main.py'))).toBe(true);
    mkdirSync(at('empty'));
    expect((await call('DELETE', '/api/folders?folder=empty')).status).toBe(200);
    expect(existsSync(at('empty'))).toBe(false);
  });

  it('renames the file with the document and moves a deleted one out of the folder', async () => {
    const doc = (await markdown()).find((d) => d.title === 'notes 2')!;
    const renamed = await call<{ meta: SheetMeta }>('PATCH', `/api/markdown/${doc.id}`, { title: 'old notes' });
    expect([renamed.body.meta.title, renamed.body.meta.folder]).toEqual(['old notes', 'archive/2026']);
    expect(existsSync(at('archive', '2026', 'notes 2.md'))).toBe(false);
    expect(readFileSync(at('archive', '2026', 'old notes.md'), 'utf8')).toBe('second');

    expect((await call('DELETE', `/api/markdown/${doc.id}`)).status).toBe(200);
    expect(existsSync(at('archive', '2026', 'old notes.md'))).toBe(false);
    const trashed = readdirSync(path.join(dataDir, 'trash'));
    expect(trashed).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, 'trash', trashed[0]), 'utf8')).toBe('second');
    expect((await markdown()).some((d) => d.id === doc.id)).toBe(false);
  });

  it('searches the whole folder by name, including files it has not listed yet', async () => {
    mkdirSync(at('deep', 'er', 'still'), { recursive: true });
    writeFileSync(at('deep', 'er', 'still', 'Quarterly plan.md'), 'plan');
    writeFileSync(at('deep', 'er', 'quarterly.pdf'), '%PDF');
    writeFileSync(at('deep', 'quarterly.py'), 'not listed');
    writeFileSync(at('node_modules', 'pkg', 'quarterly.md'), 'dependency');
    const found = (await call<Library & { truncated: boolean }>('GET', '/api/library/search?q=QUARTER')).body;
    expect(found.docs.map((d) => [d.title, d.folder])).toEqual([['Quarterly plan', 'deep/er/still']]);
    expect(found.files.map((f) => [f.filename, f.folder])).toEqual([['quarterly.pdf', 'deep/er']]);
    expect(found.truncated).toBe(false);
    // A result opens like any other file.
    expect((await call<{ doc: { text: string } }>('GET', `/api/markdown/${found.docs[0].id}`)).body.doc.text).toBe('plan');
    expect((await call<Library>('GET', '/api/library/search?q=still')).body.folders).toEqual([{ name: 'still', path: 'deep/er/still' }]);
    // Finding some files did not make the app forget the others.
    expect((await library('reports')).docs.length).toBeGreaterThan(0);
  });

  it('notices files added and removed outside the app', async () => {
    writeFileSync(at('fresh.md'), 'new');
    rmSync(at('-..-escape.md'));
    const titles = (await library()).docs.map((d) => d.title);
    expect(titles).toContain('fresh');
    expect(titles).not.toContain('-..-escape');
  });

  it('serves and stores other files in the folder', async () => {
    const [pdf] = (await library()).files;
    const res = await app.inject({ method: 'GET', url: pdf.url });
    expect(res.body).toBe('%PDF-1.4 test');
    const up = await app.inject({ method: 'POST', url: '/api/files', headers: { 'content-type': 'application/pdf', 'x-filename': 'scan.pdf' }, payload: Buffer.from('%PDF-1.4 other') });
    expect((up.json() as { file: StoredFile }).file.filename).toBe('scan 2.pdf');
    expect(readFileSync(at('scan 2.pdf'), 'utf8')).toBe('%PDF-1.4 other');
  });
});

describe('the desktop token', () => {
  it('keeps out requests that do not carry it', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    const guarded = await buildApp({ dataDir: data, local: { dir: folder, token: 'secret' } });
    try {
      expect((await guarded.inject({ method: 'GET', url: '/api/markdown' })).statusCode).toBe(401);
      expect((await guarded.inject({ method: 'GET', url: '/api/markdown', cookies: { [LOCAL_COOKIE]: 'wrong' } })).statusCode).toBe(401);
      expect((await guarded.inject({ method: 'GET', url: '/api/markdown', cookies: { [LOCAL_COOKIE]: 'secret' } })).statusCode).toBe(200);
    } finally {
      await guarded.close();
      rmSync(data, { recursive: true, force: true });
    }
  });
});
