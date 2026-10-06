import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../server/db.ts';
import { FileHub, type FileService } from './files.ts';
import { APP_URI, appHtml, createMcpServer } from './mcp.ts';

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
  const server = createMcpServer(svc, { bundle: () => ({ js: 'console.log(1)', css: '', hash: 'abc' }), publicUrl: null });
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
    expect(byName.docs_app._meta).toMatchObject({ ui: { resourceUri: APP_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }] } });
    expect(byName.open_file._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(byName.save_file._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(byName.read_doc.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_blocks.annotations?.destructiveHint).toBe(true);
    expect(byName.delete_slides.annotations?.destructiveHint).toBe(true);
    expect(byName.read_doc.inputSchema.properties).toHaveProperty('doc_id');
    expect(byName.add_slides.inputSchema.properties).toHaveProperty('deck_id');
    expect(byName).not.toHaveProperty('render_slide');
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
