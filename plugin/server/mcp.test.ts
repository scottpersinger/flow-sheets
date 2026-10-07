import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../server/db.ts';
import { FileHub, type FileService } from './files.ts';
import { buildSlide, newId } from '../../shared/deck.ts';
import { buildPptx } from '../../shared/pptxExport.ts';
import { buildDocx } from '../../server/testing.ts';
import { appHtml, appUri, createMcpServer } from './mcp.ts';

const APP_URI = appUri('abc');

/** Serves the test's Word and PowerPoint files at pretend ChatGPT download URLs. */
const attachments = new Map<string, Buffer>();
const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  const bytes = attachments.get(url);
  return bytes ? new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }) : new Response('nope', { status: 404 });
};

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
let client: Client;
let svc: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-mcp-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
  const hub = new FileHub({ db, dataDir: dir, publicUrl: null });
  await hub.init();
  svc = hub.forUser('u1');
  const server = createMcpServer(svc, { bundle: () => ({ js: 'console.log(1)', css: '', hash: 'abc' }), publicUrl: null, fetchFn: fakeFetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, data: r.structuredContent as Record<string, unknown> | undefined, text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('') };
};

describe('MCP server', () => {
  it('lists tools with the app entrypoint and hides app-only tools from the model', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.docs_app._meta).toMatchObject({ ui: { resourceUri: APP_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } });
    expect(byName.open_file._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(byName.save_file._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(byName.read_doc.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_blocks.annotations?.destructiveHint).toBe(true);
    expect(byName.delete_slides.annotations?.destructiveHint).toBe(true);
    expect(byName.read_doc.inputSchema.properties).toHaveProperty('doc_id');
    expect(byName.add_slides.inputSchema.properties).toHaveProperty('deck_id');
    expect(byName.write_range.inputSchema.properties).toHaveProperty('sheet_id');
    expect(byName.delete_rows.annotations?.destructiveHint).toBe(true);
    expect(byName).not.toHaveProperty('render_slide');
    expect(byName).not.toHaveProperty('select_range');
    // ChatGPT checks that every tool has annotations and typed properties.
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: expect.any(Boolean) });
      for (const [k, v] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>)) expect(typeof v.type, `${t.name}.${k}`).toBe('string');
    }
  });

  it('references hosted assets when a public origin is set', () => {
    const html = appHtml({ js: 'x', css: 'y', hash: 'h1' }, 'https://docs.example.com');
    expect(html).toContain('src="https://docs.example.com/plugin/app.js?v=h1"');
    expect(html).toContain('href="https://docs.example.com/plugin/app.css?v=h1"');
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('freeflow-url');
    const withApp = appHtml({ js: 'x', css: 'y', hash: 'h1' }, null, 'https://docs.example.com/');
    expect(withApp).toContain('<meta name="freeflow-url" content="https://docs.example.com/">');
    expect(withApp).toContain('<style>y</style>');
  });

  it('names the app resource after the bundle hash', () => {
    expect(appUri('h1')).toBe('ui://freeflow-docs/app-h1.html');
    expect(appUri('h2')).not.toBe(appUri('h1'));
  });

  it('serves the app as a UI resource', async () => {
    const r = await client.readResource({ uri: APP_URI });
    expect(r.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect((r.contents[0] as { text: string }).text).toContain('console.log(1)');
    expect(r.contents[0]._meta).toMatchObject({ 'openai/ui': { preferredDisplayMode: 'inline' } });
  });

  it('edits the open document from the composer', async () => {
    const created = await call('create_doc', { title: 'Notes', markdown: 'Hello.\n' });
    expect((created.data?.open as { id: string }).id).toBe((created.data?.file as { id: string }).id);
    const ins = await call('insert_content', { markdown: 'World.' });
    expect(ins.data?.inserted_blocks).toEqual([2]);
    const read = await call('read_doc');
    expect((read.data?.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['Hello.', 'World.']);
    const state = await call('app_state');
    expect((state.data?.open as { rev: string }).rev).toBe(read.data?.rev);
  });

  it('creates and edits a presentation, and keeps the kinds apart', async () => {
    const created = await call('create_deck', { title: 'Pitch', slides: [{ title: 'Pitch' }, { title: 'Problem', body: ['Slow'] }] });
    expect(created.isError).toBe(false);
    expect((created.data?.open as { kind: string }).kind).toBe('deck');
    const noDoc = await call('read_doc');
    expect(noDoc.isError).toBe(true);
    const added = await call('add_slides', { slides: [{ title: 'Solution', body: ['Fast'] }] });
    expect(added.isError).toBe(false);
    const outline = await call('read_deck');
    expect(outline.data?.slide_count).toBe(3);
    const files = await call('list_files', { kind: 'deck' });
    expect((files.data?.files as { title: string }[]).map((f) => f.title)).toEqual(['Pitch']);
  });

  it('creates and edits a spreadsheet from the composer', async () => {
    const created = await call('create_sheet', { title: 'Budget' });
    expect(created.isError).toBe(false);
    expect((created.data?.open as { kind: string }).kind).toBe('sheet');
    const noDeck = await call('read_deck');
    expect(noDeck.isError).toBe(true);
    const wrote = await call('write_range', { start: 'A1', rows: [['a', 1], ['b', 2], ['sum', '=SUM(B1:B2)']] });
    expect(wrote.isError).toBe(false);
    const read = await call('read_range', { range: 'A1:B3' });
    expect((read.data?.values as string[][])[2]).toEqual(['sum', '3']);
    const opened = await call('open_file', { kind: 'sheet', id: (created.data?.file as { id: string }).id });
    expect((opened.data?.tabs as unknown[]).length).toBe(1);
    const files = await call('list_files', { kind: 'sheet' });
    expect((files.data?.files as { title: string }[]).map((f) => f.title)).toEqual(['Budget']);
  });

  it('imports Word and PowerPoint files the user attached, and refuses other things', async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'import_file')?._meta).toMatchObject({ 'openai/fileParams': ['file'] });
    attachments.set('https://files.example/brief.docx', await buildDocx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>From Word</w:t></w:r></w:p><w:p><w:r><w:t>Body.</w:t></w:r></w:p>'));
    const doc = await call('import_file', { file: { download_url: 'https://files.example/brief.docx', file_id: 'f1', file_name: 'brief.docx' } });
    expect(doc.isError).toBe(false);
    expect(doc.data?.file).toMatchObject({ kind: 'doc', title: 'brief' });
    const read = await call('read_doc');
    expect((read.data?.blocks as { markdown: string }[])[0].markdown).toMatch(/^# .*From Word/);
    const { pres } = await buildPptx({ version: 1, theme: 'light', slides: [buildSlide('title-body', { title: 'From PowerPoint', body: ['One', 'Two'] }, newId)] }, 'x', async () => null);
    attachments.set('https://files.example/deck.pptx', Buffer.from((await pres.write({ outputType: 'nodebuffer' })) as Buffer));
    const deck = await call('import_file', { file: { download_url: 'https://files.example/deck.pptx' }, title: 'Pitch' });
    expect(deck.data?.file).toMatchObject({ kind: 'deck', title: 'Pitch' });
    expect((deck.data?.open as { kind: string }).kind).toBe('deck');
    attachments.set('https://files.example/notes.txt', Buffer.from('plain text'));
    const txt = await call('import_file', { file: { download_url: 'https://files.example/notes.txt' } });
    expect(txt.isError).toBe(true);
    expect(txt.text).toMatch(/Only Word documents/);
    const local = await call('import_file', { file: { download_url: 'http://127.0.0.1/secret' } });
    expect(local.text).toMatch(/public https/);
    const missing = await call('import_file', { file: { download_url: 'https://files.example/gone.docx' } });
    expect(missing.text).toMatch(/404/);
  });

  it('puts an attached image into a cell or a document', async () => {
    const { tools } = await client.listTools();
    const cell = tools.find((t) => t.name === 'set_cell_image')!;
    expect(cell._meta).toMatchObject({ 'openai/fileParams': ['file'] });
    expect(cell.inputSchema.required ?? []).not.toContain('url');
    attachments.set('https://files.example/cat.png', Buffer.from(PNG_1X1, 'base64'));
    await call('create_sheet', { title: 'Pics' });
    const put = await call('set_cell_image', { range: 'B2', file: { download_url: 'https://files.example/cat.png', mime_type: 'application/octet-stream' } });
    expect(put.isError, put.text).toBe(false);
    expect(put.data?.image_in).toBe('Sheet1!B2');
    const read = await call('read_range', { range: 'B2' });
    expect((read.data?.values as string[][])[0][0]).toBe('[image]');
    // A web address is fetched and stored too, so the cell points at this server, not the web.
    const fromWeb = await call('set_cell_image', { range: 'C2', url: 'https://files.example/cat.png' });
    expect(fromWeb.isError, fromWeb.text).toBe(false);
    const stored = await svc.sheets.load('u1', (fromWeb.data?.sheet_id as string));
    expect(stored!.workbook.tabs[0].cells.C2.img).toMatch(/^\/api\/images\//);
    attachments.set('https://files.example/page.html', Buffer.from('<html>not an image</html>'));
    const page = await call('set_cell_image', { range: 'C3', url: 'https://files.example/page.html' });
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/not of a page/);
    const neither = await call('set_cell_image', { range: 'B3' });
    expect(neither.isError).toBe(true);
    expect(neither.text).toMatch(/attach the image/);
    attachments.set('https://files.example/notes.txt', Buffer.from('plain text'));
    const notImage = await call('set_cell_image', { range: 'B3', file: { download_url: 'https://files.example/notes.txt' } });
    expect(notImage.text).toMatch(/PNG, JPEG, GIF or WebP/);

    await call('create_doc', { title: 'Album', markdown: 'Cats.\n' });
    const inserted = await call('insert_image', { after: 1, file: { download_url: 'https://files.example/cat.png' } });
    expect(inserted.isError, inserted.text).toBe(false);
    const doc = await call('read_doc');
    expect((doc.data?.blocks as { markdown: string }[])[1].markdown).toMatch(/^!\[.*\]\(\/api\/images\//);
  });

  it('returns an error result, not a crash, for bad input', async () => {
    const r = await call('read_doc', { doc_id: 'missing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no document/);
    const none = await call('insert_content', { markdown: 'x' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/No document is open/);
    const noDeck = await call('add_slides', { slides: [{ title: 'x' }] });
    expect(noDeck.text).toMatch(/No presentation is open/);
  });

  it('saves from the editor with revision checks', async () => {
    const created = await call('create_doc', { title: 'Notes', markdown: 'Hello.\n' });
    const id = (created.data?.file as { id: string }).id;
    const got = await call('get_file', { kind: 'doc', id });
    await new Promise((r) => setTimeout(r, 5));
    await call('replace_text', { find: 'Hello', replace: 'Hi' });
    const stale = await call('save_file', { kind: 'doc', id, rev: got.data?.rev, data: got.data?.data });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ conflict: true });
    const fresh = await call('get_file', { kind: 'doc', id });
    const saved = await call('save_file', { kind: 'doc', id, rev: fresh.data?.rev, data: fresh.data?.data });
    expect(saved.isError).toBe(false);
  });
});
