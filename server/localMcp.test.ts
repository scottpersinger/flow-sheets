import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { pathOfFile } from './localMcp.ts';

const TOKEN = 'test-token-0123456789';
let dataDir: string;
let folder: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let origin: string;
const shown: string[] = [];
const changed: string[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'local-mcp-data-'));
  folder = mkdtempSync(path.join(tmpdir(), 'local-mcp-folder-'));
  writeFileSync(path.join(folder, 'notes.md'), '# Notes\n\nFirst line.\n');
  writeFileSync(path.join(folder, 'LICENSE'), 'MIT License\n\nCopyright (c) 2025 Someone\n');
  app = await buildApp({ dataDir, local: { dir: folder, mcp: { token: TOKEN, show: (page) => shown.push(page), changed: (id) => changed.push(id) } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
});

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('');

describe("the desktop app's MCP server", () => {
  it('refuses a request without the token', async () => {
    const r = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it("works on the folder's files, and the window shows the file the model opens", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_files', 'open_file', 'read_doc', 'insert_content', 'write_range', 'create_folder', 'move_file', 'upload_file']));
    // Only the model's tools: none of the parts for ChatGPT's own app.
    expect(tools.map((t) => t.name)).not.toContain('app_state');

    // It is MCP Docs, not the hosted Universal Docs.
    expect(client.getServerVersion()).toMatchObject({ name: 'mcp-docs', title: 'MCP Docs' });
    expect(client.getInstructions()).toMatch(/^MCP Docs:/);
    const list = JSON.parse(text(await client.callTool({ name: 'list_files', arguments: {} })));
    const notes = (list.files as { id: string; kind: string; title: string }[]).find((f) => f.kind === 'markdown');
    expect(notes).toBeTruthy();

    await client.callTool({ name: 'open_file', arguments: { kind: 'markdown', id: notes!.id } });
    expect(shown.at(-1)).toBe(pathOfFile('markdown', notes!.id));

    // With no id, the tools act on the open file; the edit is the folder's file.
    const r = await client.callTool({ name: 'insert_content', arguments: { position: 'end', markdown: 'Added by an agent.' } });
    expect(r.isError).not.toBe(true);
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toContain('Added by an agent.');
    await client.close();
  });

  it('acts on the file the window reports it shows', async () => {
    // Without a window token every request is the local user.
    const list = await app.inject({ method: 'GET', url: '/api/library' });
    const md = (list.json().docs as { id: string; kind: string }[]).find((d) => d.kind === 'markdown')!;
    await app.inject({ method: 'POST', url: '/api/local/showing', payload: {} });
    const client = await connect();
    const none = await client.callTool({ name: 'read_doc', arguments: {} });
    expect(none.isError).toBe(true);
    await app.inject({ method: 'POST', url: '/api/local/showing', payload: { kind: 'markdown', id: md.id } });
    const read = await client.callTool({ name: 'read_doc', arguments: {} });
    expect(read.isError).not.toBe(true);
    expect(text(read)).toContain('Notes');
    await client.close();
  });

  it("edits a text file of the folder in place, and tells the window", async () => {
    const client = await connect();
    const found = JSON.parse(text(await client.callTool({ name: 'search_files', arguments: { query: 'LICENSE' } })));
    const license = (found.files as { id: string; kind: string }[]).find((f) => f.kind === 'file')!;
    const r = await client.callTool({ name: 'edit_file', arguments: { file_id: license.id, edits: [{ find: '2025 Someone', replace: '2026 Scott' }] } });
    expect(r.isError).not.toBe(true);
    expect(readFileSync(path.join(folder, 'LICENSE'), 'utf8')).toBe('MIT License\n\nCopyright (c) 2026 Scott\n');
    expect(changed).toEqual([license.id]);
    // The folder keeps no earlier version beside the file, so there is nothing to undo to.
    const undo = await client.callTool({ name: 'edit_file', arguments: { file_id: license.id, undo: true } });
    expect(undo.isError).toBe(true);
    expect(text(undo)).toContain('no earlier version');
    await client.close();
  });
});
