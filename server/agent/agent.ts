// The agent loop. Runs on the server (it holds the API key, prompt and tools) and streams events to
// the browser. Account tools run here; sheet tools run in the browser against the live spreadsheet,
// so when Claude calls one the turn pauses: the browser runs it and posts the results to resume.
import Anthropic from '@anthropic-ai/sdk';
import { CLIENT_TOOLS, type AgentEvent, type AgentTurnRequest, type ChatItem, type ClientToolCall } from '../../shared/agent/protocol.ts';
import type { SheetStore } from '../sheets.ts';
import { renderContext, stripContext, SYSTEM_PROMPT } from './prompt.ts';
import { AgentStore, type MessageParam, type Pending } from './store.ts';
import { runServerTool, TOOL_DEFS, ToolFailure, validateToolInput } from './tools.ts';

type Message = Anthropic.Beta.BetaMessage;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

/** One streamed model request. Swappable so tests can run the loop without the API. */
export type ModelCall = (params: StreamParams, opts: { onText: (text: string) => void; signal: AbortSignal }) => Promise<Message>;

export function claudeModel(client: Anthropic = new Anthropic()): ModelCall {
  return async (params, { onText, signal }) => {
    const stream = client.beta.messages.stream(params, { signal });
    stream.on('text', onText);
    return stream.finalMessage();
  };
}

export interface AgentOptions {
  model?: ModelCall;
  /** Model calls allowed per user per day (shared API key). */
  dailyRequestLimit?: number;
}

const MODEL = 'claude-sonnet-5-5';
const EFFORT = (process.env.AGENT_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';
/** Model calls in one turn before the agent stops and hands back to the user. */
const MAX_STEPS = 30;
const MAX_RESULT_CHARS = 60_000;

export class AgentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class AgentService {
  private store: AgentStore;
  private sheets: SheetStore;
  private model: ModelCall | null;
  private dailyLimit: number;
  /** Users with a turn in progress (one at a time per user). */
  private busy = new Set<string>();

  constructor(store: AgentStore, sheets: SheetStore, opts: AgentOptions = {}) {
    this.store = store;
    this.sheets = sheets;
    this.model = opts.model ?? null;
    this.dailyLimit = opts.dailyRequestLimit ?? Number(process.env.AGENT_DAILY_REQUEST_LIMIT ?? 500);
  }

  private getModel(): ModelCall {
    // Created lazily so the app starts (and tests run) without credentials.
    this.model ??= claudeModel();
    return this.model;
  }

  transcript(userId: string): ChatItem[] {
    const conv = this.store.active(userId);
    return toChatItems(this.store.messages(conv.id));
  }

  reset(userId: string): void {
    if (this.busy.has(userId)) throw new AgentError(409, 'The assistant is still working. Stop it first.');
    this.store.reset(userId);
  }

  /** Check a turn request before streaming starts; throws AgentError with an HTTP status. */
  checkTurn(userId: string, req: AgentTurnRequest): void {
    if (this.busy.has(userId)) throw new AgentError(409, 'The assistant is already working on a request.');
    const message = req.message?.trim();
    if (!message && !req.toolResults?.length) throw new AgentError(400, 'Send a message or tool results.');
    if (message && message.length > 20_000) throw new AgentError(400, 'That message is too long.');
    if (!req.context || (req.context.page !== 'home' && req.context.page !== 'sheet')) throw new AgentError(400, 'Missing context.');
    if (this.store.requestsToday(userId) >= this.dailyLimit) {
      throw new AgentError(429, "You've reached today's limit for the assistant. Try again tomorrow.");
    }
  }

  /** Run (or resume) a turn, emitting events until it finishes or pauses for client tools. */
  async runTurn(userId: string, req: AgentTurnRequest, emit: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    this.checkTurn(userId, req);
    this.busy.add(userId);
    try {
      await this.loop(userId, req, emit, signal);
    } finally {
      this.busy.delete(userId);
    }
  }

  private async loop(userId: string, req: AgentTurnRequest, emit: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    const conv = this.store.active(userId);

    // 1. The new user message: results for any tool calls still pending, then the context and text.
    const content: (ToolResult | Anthropic.Beta.BetaTextBlockParam)[] = [];
    if (conv.pending) content.push(...completePending(conv.pending, req.toolResults ?? []));
    const text = req.message?.trim();
    if (text) content.push({ type: 'text', text: renderContext(req.context) }, { type: 'text', text });
    if (!content.length) throw new AgentError(400, 'Nothing to send.');
    this.store.append(conv.id, { role: 'user', content });
    this.store.setPending(conv.id, null);

    const env = { userId, sheets: this.sheets, context: req.context };
    let parseRetries = 0;

    // 2. Call the model until it stops calling tools, or pauses for the browser.
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.store.requestsToday(userId) >= this.dailyLimit) {
        emit({ type: 'error', message: "You've reached today's limit for the assistant." });
        return;
      }
      let message: Message;
      try {
        message = await this.getModel()(
          {
            model: MODEL,
            max_tokens: 32000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: EFFORT },
            system: [{ type: 'text', text: SYSTEM_PROMPT }],
            tools: TOOL_DEFS,
            // Caches the whole prefix up to the latest message; each turn reads the previous one's cache.
            cache_control: { type: 'ephemeral' },
            messages: this.store.messages(conv.id),
          },
          { onText: (t) => emit({ type: 'text', text: t }), signal },
        );
        parseRetries = 0;
      } catch (err) {
        if (signal.aborted) return;
        // With eager input streaming, a tool input that isn't valid JSON rejects finalMessage() with a plain
        // AnthropicError (API errors are APIError subclasses and are not retried here); retry that model call.
        if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && parseRetries++ < 2) continue;
        throw err;
      }
      this.store.recordUsage(userId, message.usage);
      // Keep the whole content (thinking blocks included) so later requests replay it unchanged.
      this.store.append(conv.id, { role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (message.stop_reason === 'refusal') {
        emit({ type: 'text', text: '\n\nI can’t help with that request.' });
        break;
      }
      const toolUses = message.content.filter((b): b is ToolUse => b.type === 'tool_use');
      if (!toolUses.length) break;

      const pending: Pending = { toolUseIds: toolUses.map((t) => t.id), results: {}, clientIds: [] };
      const clientCalls: ClientToolCall[] = [];
      for (const tu of toolUses) {
        if (message.stop_reason === 'max_tokens') {
          // The input may have been cut off; don't run it.
          pending.results[tu.id] = errorResult(tu.id, 'Your response was cut off before this tool input was complete. Try again with less data per call.');
          continue;
        }
        const v = validateToolInput(tu.name, tu.input);
        if (!v.ok) {
          pending.results[tu.id] = errorResult(tu.id, v.error);
        } else if (CLIENT_TOOLS.has(tu.name)) {
          clientCalls.push({ id: tu.id, name: tu.name, input: v.input });
          pending.clientIds.push(tu.id);
        } else {
          emit({ type: 'tool_start', id: tu.id, name: tu.name, input: v.input });
          try {
            const out = await runServerTool(tu.name, v.input, env);
            pending.results[tu.id] = { type: 'tool_result', tool_use_id: tu.id, content: truncate(out) };
            emit({ type: 'tool_end', id: tu.id, ok: true });
          } catch (e) {
            if (!(e instanceof ToolFailure)) throw e;
            pending.results[tu.id] = errorResult(tu.id, e.message);
            emit({ type: 'tool_end', id: tu.id, ok: false });
          }
        }
      }

      if (clientCalls.length) {
        // Pause: the browser runs these and posts the results, which resumes the loop.
        this.store.setPending(conv.id, pending);
        emit({ type: 'client_tools', calls: clientCalls });
        return;
      }
      this.store.append(conv.id, { role: 'user', content: completePending(pending, []) });

      if (step === MAX_STEPS - 1) {
        emit({ type: 'text', text: '\n\nI stopped here because this request took many steps. Tell me to continue if you want me to keep going.' });
      }
    }
    emit({ type: 'done' });
  }
}

function errorResult(id: string, message: string): ToolResult {
  return { type: 'tool_result', tool_use_id: id, content: message, is_error: true };
}

function truncate(s: string): string {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n[Result truncated. Request a smaller range.]` : s;
}

/** Tool results for every pending call, in call order; calls without a result are reported as not run. */
function completePending(pending: Pending, clientResults: { id: string; content: string; isError?: boolean }[]): ToolResult[] {
  const byId = new Map(clientResults.filter((r) => pending.clientIds.includes(r.id)).map((r) => [r.id, r]));
  return pending.toolUseIds.map((id) => {
    if (pending.results[id]) return pending.results[id];
    const r = byId.get(id);
    if (!r) return errorResult(id, 'This tool call was not run because the user interrupted the request.');
    return { type: 'tool_result', tool_use_id: id, content: truncate(String(r.content)), ...(r.isError ? { is_error: true } : {}) };
  });
}

/** Turn stored API messages into the transcript shown in the panel. */
export function toChatItems(messages: MessageParam[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const role = m.role;
    if (typeof m.content === 'string') {
      items.push({ kind: role, text: m.content });
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text') {
        const text = role === 'user' ? stripContext(block.text) : block.text;
        if (!text) continue;
        const last = items[items.length - 1];
        if (role === 'assistant' && last?.kind === 'assistant') last.text += text;
        else items.push({ kind: role, text });
      } else if (block.type === 'tool_use') {
        const item: ChatItem = { kind: 'tool', id: block.id, name: block.name, input: block.input as Record<string, unknown>, status: 'running' };
        tools.set(block.id, item);
        items.push(item);
      } else if (block.type === 'tool_result') {
        const item = tools.get(block.tool_use_id);
        if (!item) continue;
        item.status = block.is_error ? 'error' : 'ok';
        if (block.is_error) item.error = typeof block.content === 'string' ? block.content : undefined;
      }
    }
  }
  return items;
}
