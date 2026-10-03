import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext, AgentEvent, AgentTurnRequest } from '../shared/agent/protocol.ts';
import type { ModelCall } from './agent/agent.ts';
import { buildApp } from './app.ts';

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
    agent: { model: fakeModel },
    launchJob: (job) => {
      launchedJobs.push(job.id);
      return process.pid;
    },
  });
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'agent@x.com', password: 'password123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0];
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

  it('starts over on reset', async () => {
    replies.push(() => ({ content: [text('Hi')] }));
    await turn({ message: 'Hello', context: home });
    await app.inject({ method: 'POST', url: '/api/agent/reset', headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/api/agent', headers: { cookie } });
    expect(res.json().items).toEqual([]);
  });

  it('validates the request before streaming', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent/turn', headers: { cookie }, payload: { context: home } });
    expect(res.statusCode).toBe(400);
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
    expect(list.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(list.jobs[0].requestedBy).toBe('agent@x.com');
    expect((await app.inject({ method: 'POST', url: `/api/agent/jobs/${job.id}/revert`, headers: { cookie } })).statusCode).toBe(400);
  });
});
