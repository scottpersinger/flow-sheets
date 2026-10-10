import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext, AgentEvent, AgentTurnRequest } from '../shared/agent/protocol.ts';
import type { ModelCall } from './agent/agent.ts';
import { resetSearchRateLimit, runServerTool, validateToolInput } from './agent/tools.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

const box = mailbox();
import type { SheetStore } from './sheets.ts';

type Params = Parameters<ModelCall>[0];
type Block = Anthropic.Beta.BetaContentBlock;

// A scripted model: each call takes the next reply and records the request it was given.
const replies: ((p: Params) => { content: Block[]; stop_reason?: Anthropic.Beta.BetaStopReason })[] = [];
const requests: Params[] = [];
const fakeModel: ModelCall = async (params, { onText }) => {
  requests.push(structuredClone(params));
  const next = replies.shift();
  if (!next) throw new Error('No scripted reply left');
  const { content, stop_reason } = next(params);
  for (const b of content) if (b.type === 'text') onText(b.text);
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stop_reason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Beta.BetaMessage;
};

const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input }) as Block;

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
const launchedJobs: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-agent-test-'));
  app = await buildApp({
    dataDir: dir,
    sendMail: box.send,
    agent: { model: fakeModel },
    launchJob: (job) => {
      launchedJobs.push(job.id);
      return process.pid;
    },
  });
  cookie = (await signUp(app, box, 'agent@x.com')).cookie;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  replies.length = 0;
  requests.length = 0;
  await app.inject({ method: 'POST', url: '/api/agent/reset', headers: { cookie } });
});

async function turn(body: AgentTurnRequest): Promise<AgentEvent[]> {
  const res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: body });
  expect(res.statusCode).toBe(200);
  return res.payload
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as AgentEvent);
}

const home = { page: 'home' } as const;

describe('agent', () => {
  it('requires sign-in', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent/turn', payload: { message: 'hi', context: home } });
    expect(res.statusCode).toBe(401);
  });

  it('streams a text reply and keeps the conversation', async () => {
    replies.push(() => ({ content: [text('Hello! ')] }));
    const events = await turn({ message: 'Hi there', context: home });
    expect(events).toEqual([{ type: 'text', text: 'Hello! ' }, { type: 'done' }]);

    // The context block goes in front of the message; the transcript hides it.
    const sent = requests[0].messages[0];
    expect(sent.role).toBe('user');
    expect(JSON.stringify(sent.content)).toContain('<app_context>');
    expect(requests[0].model).toBe('claude-sonnet-5-5');

    const res = await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } });
    expect(res.json().items).toEqual([
      { kind: 'user', text: 'Hi there' },
      { kind: 'assistant', text: 'Hello! ' },
    ]);

    // Follow-up messages append to the same history.
    replies.push(() => ({ content: [text('Again.')] }));
    await turn({ message: 'And again', context: home });
    expect(requests[1].messages).toHaveLength(3);
  });

  it('runs account tools on the server and feeds the results back', async () => {
    await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget 2026' } });
    await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Recipes' } });
    replies.push(() => ({ content: [toolUse('t1', 'list_sheets', { query: 'budget' })] }));
    replies.push(() => ({ content: [text('Found it.')] }));

    const events = await turn({ message: 'Find my budget', context: home });
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);

    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0].tool_use_id).toBe('t1');
    const listed = JSON.parse(String(results[0].content));
    expect(listed.sheets.map((s: { title: string }) => s.title)).toEqual(['Budget 2026']);
  });

  it('pauses for browser tools and resumes with their results', async () => {
    replies.push(() => ({ content: [text('Let me look.'), toolUse('c1', 'get_sheet_overview', {}), toolUse('s1', 'list_sheets', {})] }));
    const events = await turn({ message: 'What is here?', context: home });
    expect(events.at(-1)).toEqual({ type: 'client_tools', calls: [{ id: 'c1', name: 'get_sheet_overview', input: {} }] });
    expect(events.some((e) => e.type === 'done')).toBe(false);

    replies.push(() => ({ content: [text('It has one tab.')] }));
    const resumed = await turn({ context: home, toolResults: [{ id: 'c1', content: '{"tabs":[]}' }] });
    expect(resumed.at(-1)).toEqual({ type: 'done' });

    // Results go back in call order: the browser's result and the server tool's result together.
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['c1', 's1']);
    expect(results[0].content).toBe('{"tabs":[]}');
  });

  it('reports interrupted browser tools when the user sends a new message instead', async () => {
    replies.push(() => ({ content: [toolUse('c1', 'read_range', { range: 'A1:B2' })] }));
    await turn({ message: 'Read it', context: home });

    replies.push(() => ({ content: [text('OK, never mind.')] }));
    await turn({ message: 'Actually, stop', context: home });
    const content = requests[1].messages[2].content as { type: string; is_error?: boolean; text?: string }[];
    expect(content[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(content.at(-1)).toMatchObject({ type: 'text', text: 'Actually, stop' });
  });

  it('rejects invalid tool input without running or forwarding it', async () => {
    replies.push(() => ({ content: [toolUse('c1', 'write_range', { start: 'A1' })] }));
    replies.push(() => ({ content: [text('Fixed.')] }));
    const events = await turn({ message: 'Write', context: home });
    expect(events.some((e) => e.type === 'client_tools')).toBe(false);
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true });
    expect(String(results[0].content)).toContain('rows');
  });

  it('sends the open spreadsheet as context and keeps read_other_sheet off it', async () => {
    const { sheet } = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Open one' } })).json();
    const context: AgentContext = { page: 'sheet', sheetId: sheet.id, title: 'Open one', tabs: ['Sheet1'], activeTab: 'Sheet1', selection: ['B2:C4'] };
    replies.push(() => ({ content: [toolUse('s1', 'read_other_sheet', { sheet_id: sheet.id })] }));
    replies.push(() => ({ content: [text('ok')] }));
    await turn({ message: 'Sum the selection', context });
    expect(JSON.stringify(requests[0].messages[0].content)).toContain('Selection: B2:C4');
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true });
  });

  it('reads another spreadsheet with computed values', async () => {
    const { sheet } = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Numbers' } })).json();
    const workbook = {
      version: 1,
      tabs: [{ id: 't', name: 'Data', rows: 10, cols: 5, cells: { A1: { v: '2' }, A2: { v: '3' }, A3: { v: '=A1*A2' } }, colWidths: {}, rowHeights: {} }],
    };
    await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    replies.push(() => ({ content: [toolUse('s1', 'read_other_sheet', { sheet_id: sheet.id, range: 'Data!A1:A3' })] }));
    replies.push(() => ({ content: [text('6')] }));
    await turn({ message: 'What is A3 in Numbers?', context: home });
    const results = requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(JSON.parse(String(results[0].content)).values).toEqual([['2'], ['3'], ['6']]);
  });

  it('creates a presentation with slides on the server and lists it', async () => {
    replies.push(() => ({
      content: [
        toolUse('d1', 'create_deck', {
          title: 'Q3 review',
          theme: 'ocean',
          slides: [
            { title: 'Q3 review', subtitle: 'October 2026' },
            { title: 'Highlights', body: ['Revenue up 12%', 'Churn down'] },
          ],
        }),
      ],
    }));
    replies.push(() => ({ content: [toolUse('d2', 'list_decks', { query: 'q3' })] }));
    replies.push(() => ({ content: [text('Done.')] }));
    const events = await turn({ message: 'Make a deck', context: home });
    expect(events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'tool_start', 'tool_end', 'text', 'done']);

    const created = JSON.parse(String((requests[1].messages[2].content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content)) as { id: string; slide_count: number };
    expect(created.slide_count).toBe(2);
    const listed = JSON.parse(String((requests[2].messages[4].content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content)) as { decks: { id: string; title: string }[] };
    expect(listed.decks).toEqual([expect.objectContaining({ id: created.id, title: 'Q3 review' })]);

    const res = await app.inject({ method: 'GET', url: `/api/decks/${created.id}`, headers: { cookie } });
    const { deck } = res.json();
    expect(deck.theme).toBe('ocean');
    expect(deck.slides[0].layout).toBe('title');
    expect(deck.slides[1].layout).toBe('title-body');

    // The deck context is accepted and rendered for the model.
    replies.push(() => ({ content: [text('On slide 2.')] }));
    await turn({ message: 'Where am I?', context: { page: 'deck', deckId: created.id, title: 'Q3 review', slideCount: 2, currentSlide: 2, selectedElements: [] } });
    expect(JSON.stringify(requests[3].messages.at(-1)!.content)).toContain('Current slide: 2');
  });

  it('starts over on reset', async () => {
    replies.push(() => ({ content: [text('Hi')] }));
    await turn({ message: 'Hello', context: home });
    await app.inject({ method: 'POST', url: '/api/agent/reset', headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } });
    expect(res.json().items).toEqual([]);
  });

  it('sends attached images to the model and shows them in the transcript', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    replies.push(() => ({ content: [text('A tiny PNG.')] }));
    const events = await turn({ message: 'what is this?', context: home, images: [{ mediaType: 'image/png', data: png }] });
    expect(events.some((e) => e.type === 'done')).toBe(true);
    const content = requests[0].messages.at(-1)!.content as { type: string; source?: { media_type: string; data: string } }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(content[1].source).toMatchObject({ type: 'base64', media_type: 'image/png', data: png });
    const items = (await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } })).json().items as { kind: string; text?: string; images?: string[] }[];
    expect(items[0]).toMatchObject({ kind: 'user', text: 'what is this?', images: [`data:image/png;base64,${png}`] });

    // An image alone is a message too; bad media types and too many images are refused.
    replies.push(() => ({ content: [text('ok')] }));
    await turn({ context: home, images: [{ mediaType: 'image/png', data: png }] });
    expect((requests[1].messages.at(-1)!.content as { type: string; text?: string }[]).at(-1)!.text).toBe('See the attached image.');

    // A stored address travels to the model (so it can place the picture) but stays out of the transcript.
    replies.push(() => ({ content: [text('Placed.')] }));
    const url = '/api/images/12345678-1234-1234-1234-123456789abc';
    await turn({ message: 'put this on slide 2', context: home, images: [{ mediaType: 'image/png', data: png, url }] });
    const blocks = requests[2].messages.at(-1)!.content as { type: string; text?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['text', 'image', 'text', 'text']);
    expect(blocks[2].text).toContain(`Attached image 1 is stored at ${url}`);
    const transcript = (await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } })).json().items as { kind: string; text?: string }[];
    expect(transcript.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['what is this?', 'See the attached image.', 'put this on slide 2']);
    expect(JSON.stringify(transcript)).not.toContain('attached_images');
    expect((await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home, images: [{ mediaType: 'image/png', data: png, url: 'https://evil.example/x.png' }] } })).statusCode).toBe(400);
    let res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home, images: [{ mediaType: 'image/svg+xml', data: png }] } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home, images: Array(5).fill({ mediaType: 'image/png', data: png }) } });
    expect(res.statusCode).toBe(400);
  });

  it('validates the request before streaming', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home } });
    expect(res.statusCode).toBe(400);
  });

  it('queues a research task with the open spreadsheet, as a job the worker runs', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Companies' } });
    const sheetId = (created.json() as { sheet: { id: string } }).sheet.id;
    let res = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { kind: 'research', title: 'Revenue lookup', spec: 'Find the 2025 revenue of each company in column A.', sheetId: 'nope' } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { kind: 'research', title: 'Revenue lookup', spec: 'Find the 2025 revenue of each company in column A.', sheetId } });
    expect(res.statusCode).toBe(200);
    const { job } = res.json() as { job: { id: string; kind: string; sheetId: string; status: string } };
    expect(job).toMatchObject({ kind: 'research', sheetId, status: 'queued' });
    // Research is never revertable, and it blocks the queue like any job.
    expect((await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/revert`, headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { title: 'Another', spec: 'Something else entirely.' } })).statusCode).toBe(409);
    // Clear it so the next test starts with an empty queue: a turn starts it, and the stub launcher runs nothing.
    replies.push(() => ({ content: [text('ok')] }));
    await turn({ message: 'hi', context: home });
    expect(launchedJobs).toEqual([job.id]);
    launchedJobs.length = 0;
    const { db } = await import('./db.ts').then((m) => ({ db: m.openDb(path.join(dir, 'app.db')) }));
    db.prepare("UPDATE agent_jobs SET status = 'done' WHERE id = ?").run(job.id);
    db.close();
  });

  it('queues an app change and starts it after the turn ends', async () => {
    replies.push(() => ({ content: [toolUse('t1', 'request_app_change', { title: 'Add set_filter_values', spec: 'Let the assistant set which values a filter column shows.' })] }));
    const events = await turn({ message: 'add a tool to set filter criteria', context: home });
    // request_app_change runs in the browser (so the user can confirm there); the server does not run it.
    expect(events.find((e) => e.type === 'client_tools')).toMatchObject({ calls: [{ name: 'request_app_change' }] });
    expect(launchedJobs).toEqual([]);

    const created = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { title: 'Add set_filter_values', spec: 'Let the assistant set which values a filter column shows.' } });
    expect(created.statusCode).toBe(200);
    const { job } = created.json() as { job: { id: string; status: string; acknowledged: boolean } };
    expect(job.status).toBe('queued');
    const dup = await app.inject({ method: 'POST', url: '/api/agent/jobs', headers: { cookie }, payload: { title: 'Another', spec: 'Something else entirely.' } });
    expect(dup.statusCode).toBe(409);
    expect(launchedJobs).toEqual([]); // not started mid-turn

    replies.push(() => ({ content: [text('Working on it.')] }));
    await turn({ context: home, toolResults: [{ id: 't1', content: JSON.stringify({ job_id: job.id, status: 'queued' }) }] });
    expect(launchedJobs).toEqual([job.id]);

    const latest = await app.inject({ method: 'GET', url: '/api/agent/jobs/latest', headers: { cookie } });
    expect(latest.json()).toMatchObject({ job: { id: job.id, status: 'starting', acknowledged: false } });
    const ack = await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/ack`, headers: { cookie } });
    expect(ack.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/agent/jobs/latest', headers: { cookie } })).json()).toMatchObject({ job: { acknowledged: true } });

    // The change history lists it with who asked; a running change cannot be reverted.
    const list = (await app.inject({ method: 'GET', url: '/api/agent/jobs', headers: { cookie } })).json() as { jobs: { id: string; requestedBy: string }[] };
    expect(list.jobs[0].id).toBe(job.id); // newest first
    expect(list.jobs[0].requestedBy).toBe('agent@x.com');
    expect((await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/revert`, headers: { cookie } })).statusCode).toBe(400);
  });
});

describe('web and image search tools', () => {
  const env = { userId: 'search-user', sheets: {} as SheetStore, context: home };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    resetSearchRateLimit();
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns web results as plain text', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({
        web: {
          results: [
            { title: 'Eat a <strong>Peach</strong>', url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', description: 'An album &amp; more' },
            { title: 'bad', url: 'javascript:x' },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const out = JSON.parse(await runServerTool('web_search', { query: 'Eat a Peach', max_results: 3 }, env));
    expect(out.results).toEqual([{ title: 'Eat a Peach', url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', snippet: 'An album & more' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/web/search?q=Eat+a+Peach&count=3');
    expect((init?.headers as Record<string, string>)['X-Subscription-Token']).toBe('test-key');
  });

  it('returns only directly loadable images, hotlink-friendly hosts first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('api.search.brave.com')) {
          return json({
            results: [
              { title: 'Cover (blog)', url: 'https://blog.example.com/p', properties: { url: 'https://blog.example.com/cover.jpg', width: 500, height: 500 } },
              { title: 'Cover (wiki)', url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', properties: { url: 'https://upload.wikimedia.org/a/Eat_a_Peach.png', width: 300, height: 300 } },
              { title: 'Broken', url: 'https://x.example.com', properties: { url: 'https://x.example.com/missing.jpg' } },
              { title: 'Not an image file', url: 'https://y.example.com', properties: { url: 'https://y.example.com/page.html' } },
              { title: 'Internal', url: 'http://10.0.0.1', properties: { url: 'http://10.0.0.1/a.png' } },
            ],
          });
        }
        if (url.includes('missing')) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
      }),
    );
    const out = JSON.parse(await runServerTool('image_search', { query: 'Allman Brothers Band Eat a Peach album cover' }, env));
    expect(out.results).toEqual([
      { title: 'Cover (wiki)', image_url: 'https://upload.wikimedia.org/a/Eat_a_Peach.png', source_page_url: 'https://en.wikipedia.org/wiki/Eat_a_Peach', width: 300, height: 300 },
      { title: 'Cover (blog)', image_url: 'https://blog.example.com/cover.jpg', source_page_url: 'https://blog.example.com/p', width: 500, height: 500 },
    ]);
  });

  it('reports empty results, API errors, a missing key and the rate limit clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ results: [] })));
    await expect(runServerTool('image_search', { query: 'zzz' }, env)).rejects.toThrow(/No loadable .* images found/);
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    await expect(runServerTool('web_search', { query: 'zzz' }, env)).rejects.toThrow(/HTTP 500/);
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    await expect(runServerTool('web_search', { query: 'zzz' }, env)).rejects.toThrow(/not set up/);

    resetSearchRateLimit();
    for (let i = 0; i < 20; i++) await runServerTool('web_search', { query: 'q' }, env).catch(() => {});
    await expect(runServerTool('web_search', { query: 'q' }, env)).rejects.toThrow(/rate limit/);
  });

  it('validates the inputs', () => {
    expect(validateToolInput('web_search', { query: 'x', max_results: 11 }).ok).toBe(false);
    expect(validateToolInput('image_search', { query: '' }).ok).toBe(false);
    expect(validateToolInput('image_search', { query: 'x', max_results: 10 }).ok).toBe(true);
  });
});

describe('app context', () => {

  it('gives a message typed at the cursor the document and the cursor\'s place in it', async () => {
    const { renderContext, stripContext } = await import('./agent/prompt.ts');
    const base = { page: 'doc' as const, docId: 'd1', title: 'Plan', blockCount: 2, cursorBlock: 2 };
    expect(renderContext(base)).not.toContain('<document>');
    const text = renderContext({ ...base, inline: { document: '[1] # Plan\n\n[2] Ship it.', before: 'Ship ', after: 'it.' } });
    expect(text).toContain('<document>\n[1] # Plan\n\n[2] Ship it.\n</document>');
    expect(text).toContain('Text just before the cursor in its block: "Ship "');
    expect(text).toContain('The whole document is below');
    expect(stripContext(text)).toBeNull();
    const part = renderContext({ ...base, selectedText: 'Ship', inline: { document: '[2] Ship it.', showing: [2, 2], selectionBlocks: [2, 2] } });
    expect(part).toContain('The selection is in block 2.');
    expect(part).toContain('only blocks 2 to 2');
    const deck = { page: 'deck' as const, deckId: 'k1', title: 'Pitch', slideCount: 1, currentSlide: 1, selectedElements: ['e1'] };
    expect(renderContext(deck)).not.toContain('<deck>');
    const slide = renderContext({ ...deck, inline: { deck: 'Theme: dark\n{"slide":1}', selectedText: 'Agenda' } });
    expect(slide).toContain('<deck>\nTheme: dark\n{"slide":1}\n</deck>');
    expect(slide).toContain('Text selected inside that element when the user opened the prompt: "Agenda"');
    expect(renderContext({ ...deck, inline: { deck: '' } })).toContain('mean the selected element.');
    expect(renderContext({ ...deck, selectedElements: [], inline: { deck: '', showing: [3, 5] } })).toMatch(/mean the current slide\..*only slides 3 to 5/s);
    // The browser sends this, so a malformed one must not break the turn.
    expect(renderContext({ ...base, inline: { document: 5, showing: ['x'] } as never })).toContain('<document>\n\n</document>');
  });
  it('tells the assistant which stored file is open, and whether it can be read and edited', async () => {
    const { renderContext } = await import('./agent/prompt.ts');
    const page = renderContext({ page: 'file', fileId: 'f1', filename: 'index.html', type: 'text/html', size: 250_000 });
    expect(page).toContain('Open file: "index.html" (id f1), text/html, 250000 bytes');
    expect(page).toContain('read_file with this id returns its text, and edit_file changes it.');
    expect(renderContext({ page: 'file', fileId: 'f2', filename: 'clip.mp4', type: 'video/mp4', size: 10 })).toContain('read_file and edit_file cannot work on it');
    expect(renderContext({ page: 'file', fileId: 'f3', filename: 'logo.png', type: 'image/png', size: 10 })).toContain('view_image with this id shows it to you, transform_image makes exact edits to it');
    const boxed = renderContext({ page: 'file', fileId: 'f3', filename: 'logo.png', type: 'image/png', size: 10, selectedRegion: { x: 500, y: 250, width: 1000, height: 500, imageWidth: 2000, imageHeight: 1000 } });
    expect(boxed).toContain('1000×500 pixels with its top left corner at x 500, y 250, in the 2000×1000 picture');
    expect(boxed).toContain('from 25% to 75% of the width and from 25% to 75% of the height');
    // A region only means something on a picture, and a nonsense one is left out.
    expect(renderContext({ page: 'file', fileId: 'f1', filename: 'index.html', type: 'text/html', size: 1, selectedRegion: { x: 0, y: 0, width: 5, height: 5, imageWidth: 10, imageHeight: 10 } })).not.toContain('Selected region');
    expect(renderContext({ page: 'file', fileId: 'f3', filename: 'logo.png', type: 'image/png', size: 10, selectedRegion: { x: 0, y: 0, width: 5, height: 5, imageWidth: 0, imageHeight: 10 } })).not.toContain('Selected region');
    const picked = renderContext({ page: 'file', fileId: 'f1', filename: 'index.html', type: 'text/html', size: 250, selectedElement: '<h1 class="title">Hi</h1>' });
    expect(picked).toContain('Selected element');
    expect(picked).toContain(JSON.stringify('<h1 class="title">Hi</h1>'));
    expect(page).not.toContain('Selected element');
  });
});
