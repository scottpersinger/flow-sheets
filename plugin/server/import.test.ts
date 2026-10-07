import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../server/db.ts';
import { buildDocx } from '../../server/testing.ts';
import { FileHub } from './files.ts';
import { createPluginServer } from './http.ts';

let dir: string;
let base: string;
let hub: FileHub;
let close: () => Promise<void>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-import-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
  hub = new FileHub({ db, dataDir: dir, publicUrl: null });
  await hub.init();
  const server = createPluginServer({ hub, oauth: null, devUserId: 'u1', publicUrl: null, webDir: dir, production: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('import from the app', () => {
  it('accepts a Word file with a fresh ticket, once, and opens the result', async () => {
    const docx = await buildDocx('<w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p>');
    const ticket = hub.issueTicket('u1');
    const post = (t: string, body: Buffer) => fetch(`${base}/plugin/import?ticket=${t}&name=brief.docx`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) });
    const ok = await post(ticket, docx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    const r = (await ok.json()) as { file: { kind: string; title: string; id: string } };
    expect(r.file).toMatchObject({ kind: 'doc', title: 'brief' });
    expect(hub.forUser('u1').open).toEqual({ kind: 'doc', id: r.file.id });
    expect((await post(ticket, docx)).status).toBe(401);
    expect((await post('bogus', docx)).status).toBe(401);
    const text = await post(hub.issueTicket('u1'), Buffer.from('not an office file'));
    expect(text.status).toBe(400);
    expect(((await text.json()) as { error: string }).error).toMatch(/Only Word documents/);
    const pre = await fetch(`${base}/plugin/import`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
  });
});
