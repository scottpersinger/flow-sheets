import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../server/db.ts';
import { ConflictError, FileHub, type FileService } from './files.ts';

let dir: string;
let svc: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-plugin-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
  const hub = new FileHub({ db, dataDir: dir, publicUrl: 'https://plugin.example.com' });
  await hub.init();
  svc = hub.forUser('u1');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('documents', () => {
  it('creates, lists and opens documents', async () => {
    const doc = await svc.createDoc('Plan', '# Plan {.title}\n\nFirst.\n');
    expect(svc.list('doc').map((d) => d.title)).toEqual(['Plan']);
    expect(svc.list(undefined, 'nothing')).toEqual([]);
    svc.setOpen({ kind: 'doc', id: doc.id });
    expect(svc.state().open).toMatchObject({ kind: 'doc', id: doc.id, title: 'Plan' });
    const outline = await svc.editDoc(doc.id, 'read_doc', {});
    expect(outline.block_count).toBe(2);
    expect((outline.blocks as { markdown: string }[])[1].markdown).toBe('First.');
  });

  it('edits headlessly with the app tools and saves a new revision', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n\nTwo.\n');
    const before = (await svc.get('doc', doc.id)).rev;
    await tick();
    const r = await svc.editDoc(doc.id, 'insert_content', { markdown: 'Between **them**.', after: 1 });
    expect(r.inserted_blocks).toEqual([2]);
    expect(r.rev).not.toBe(before);
    const read = await svc.editDoc(doc.id, 'read_doc', {});
    expect((read.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['One.', 'Between **them**.', 'Two.']);
    expect(read.rev).toBe(r.rev);
  });

  it('reports the cursor the app told it about', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n\nTwo.\n');
    svc.setOpen({ kind: 'doc', id: doc.id }, { cursor_block: 2, selected_text: 'Two' });
    const read = await svc.editDoc(doc.id, 'read_doc', {});
    expect(read.cursor_block).toBe(2);
    expect(read.selected_text).toBe('Two');
  });

  it('refuses a save with a stale revision', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n');
    const { rev, data } = await svc.get('doc', doc.id);
    await tick();
    await svc.editDoc(doc.id, 'replace_text', { find: 'One', replace: 'Uno' });
    await expect(svc.save('doc', doc.id, data, rev)).rejects.toBeInstanceOf(ConflictError);
    const fresh = await svc.get('doc', doc.id);
    expect(await svc.save('doc', doc.id, fresh.data, fresh.rev)).toHaveProperty('rev');
  });

  it('rewrites image addresses for the iframe and back', async () => {
    const doc = await svc.createDoc('Pics');
    const image = { type: 'image', attrs: { src: '/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc', alt: '', width: null, align: null } };
    await svc.sheets.saveDoc('u1', doc.id, { version: 1, content: { type: 'doc', attrs: { page: null, style: null }, content: [image] } });
    const pub = await svc.get('doc', doc.id);
    expect(JSON.stringify(pub.data)).toContain('https://plugin.example.com/img/0f4e2d8a-1b2c-4d3e-9f80-123456789abc');
    await svc.save('doc', doc.id, pub.data, pub.rev);
    const stored = await svc.sheets.loadDoc('u1', doc.id);
    expect(JSON.stringify(stored!.doc)).toContain('"/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc"');
  });

  it('rejects tool errors the model should fix', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n');
    await expect(svc.editDoc(doc.id, 'replace_blocks', { from: 5, markdown: 'x' })).rejects.toThrow(/no block 5/);
    await expect(svc.editDoc('nope', 'read_doc', {})).rejects.toThrow(/no document/);
  });
});

describe('presentations', () => {
  it('creates a deck from slide specs and lists both kinds together', async () => {
    await svc.createDoc('Notes');
    await tick();
    const deck = await svc.createDeck('Pitch', 'dark', [{ title: 'Pitch', subtitle: 'Q4' }, { title: 'Problem', body: ['Slow', 'Costly'] }]);
    expect(svc.list().map((f) => `${f.kind}:${f.title}`)).toEqual(['deck:Pitch', 'doc:Notes']);
    expect(svc.list('deck')).toHaveLength(1);
    const { data } = await svc.get('deck', deck.id);
    const d = data as { theme: string; slides: { layout: string }[] };
    expect(d.theme).toBe('dark');
    expect(d.slides.map((s) => s.layout)).toEqual(['title', 'title-body']);
  });

  it('edits a deck headlessly with the app tools, from the slide the user is on', async () => {
    const deck = await svc.createDeck('Pitch', undefined, [{ title: 'One' }, { title: 'Two' }]);
    svc.setOpen({ kind: 'deck', id: deck.id }, { slide: 2 });
    const outline = await svc.editDeck(deck.id, 'read_deck', {});
    expect(outline.slide_count).toBe(2);
    expect(outline.current_slide).toBe(2);
    const before = outline.rev;
    await tick();
    const added = await svc.editDeck(deck.id, 'add_slides', { slides: [{ layout: 'title-body', title: 'Three', body: ['a', 'b'] }] });
    expect(added.rev).not.toBe(before);
    const after = await svc.editDeck(deck.id, 'read_deck', {});
    expect(after.slide_count).toBe(3);
    const state = svc.state();
    expect(state.open?.rev).toBe(added.rev);
  });

  it('targets the open file only when it is of the right kind', async () => {
    const doc = await svc.createDoc('Notes');
    svc.setOpen({ kind: 'doc', id: doc.id });
    expect(svc.target('doc', undefined)).toBe(doc.id);
    expect(svc.target('deck', undefined)).toBeNull();
    expect(svc.target('deck', 'x')).toBe('x');
  });

  it('rewrites image elements for the iframe and back', async () => {
    const deck = await svc.createDeck('Pics');
    const loaded = await svc.sheets.loadDeck('u1', deck.id);
    const d = loaded!.deck;
    d.slides[0].elements.push({ id: 'img1', type: 'image', x: 10, y: 10, w: 100, h: 100, src: '/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc' } as (typeof d.slides)[0]['elements'][0]);
    await svc.sheets.saveDeck('u1', deck.id, d);
    const pub = await svc.get('deck', deck.id);
    expect(JSON.stringify(pub.data)).toContain('https://plugin.example.com/img/');
    await svc.save('deck', deck.id, pub.data, pub.rev);
    const stored = await svc.sheets.loadDeck('u1', deck.id);
    expect(JSON.stringify(stored!.deck)).toContain('"/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc"');
  });
});
