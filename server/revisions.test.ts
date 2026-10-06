import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newDeck } from '../shared/deck.ts';
import { newDoc } from '../shared/doc.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
const box = mailbox();

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-rev-'));
  app = await buildApp({ dataDir: dir, sendMail: box.send });
  cookie = (await signUp(app, box, 'rev@x.com')).cookie;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('saves that name the revision they loaded', () => {
  it('refuses a document save after someone else saved, and accepts one with the current revision', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Plan' } });
    const id = created.json().doc.id as string;
    const rev = created.json().doc.updatedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    const other = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc() } });
    expect(other.statusCode).toBe(200);
    const stale = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc(), rev } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().meta.updatedAt).toBe(other.json().meta.updatedAt);
    const fresh = await app.inject({ method: 'PUT', url: `/api/docs/${id}`, headers: { cookie }, payload: { doc: newDoc(), rev: other.json().meta.updatedAt } });
    expect(fresh.statusCode).toBe(200);
  });

  it('does the same for presentations, and still accepts saves without a revision', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Pitch' } });
    const id = created.json().deck.id as string;
    const rev = created.json().deck.updatedAt as string;
    await new Promise((r) => setTimeout(r, 5));
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie }, payload: { deck: newDeck() } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie }, payload: { deck: newDeck(), rev } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/api/decks/${id}`, headers: { cookie }, payload: { deck: newDeck() } })).statusCode).toBe(200);
  });
});
