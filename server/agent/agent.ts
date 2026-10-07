// The agent loop. Runs on the server (it holds the API key, prompt and tools) and streams events to
// the browser. Account tools run here; sheet tools run in the browser against the live spreadsheet,
// so when Claude calls one the turn pauses: the browser runs it and posts the results to resume.
import Anthropic from '@anthropic-ai/sdk';
import { CLIENT_TOOLS, IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, type AgentEvent, type AgentImage, type AgentTurnRequest, type ChatItem, type ClientToolCall } from '../../shared/agent/protocol.ts';
import { STORED_IMAGE_RE } from '../../shared/types.ts';
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

/** The model the live assistant runs on. Set AGENT_MODEL (e.g. claude-opus-5-5) to change it per deployment. */
const MODEL = process.env.AGENT_MODEL?.trim() || 'claude-sonnet-5-5';
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
    const images = req.images ?? [];
    if (!message && !images.length && !req.toolResults?.length) throw new AgentError(400, 'Send a message or tool results.');
    if (message && message.length > 20_000) throw new AgentError(400, 'That message is too long.');
    if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_MESSAGE) throw new AgentError(400, `Attach at most ${MAX_IMAGES_PER_MESSAGE} images.`);
    for (const img of images) {
      if (!img || typeof img.data !== 'string' || !IMAGE_MEDIA_TYPES.has(img.mediaType)) throw new AgentError(400, 'Images must be PNG, JPEG, GIF or WebP.');
      if (!/^[A-Za-z0-9+/=]+$/.test(img.data) || (img.data.length * 3) / 4 > MAX_IMAGE_BYTES) throw new AgentError(400, 'An attached image is too large.');
      if (img.url !== undefined && !STORED_IMAGE_RE.test(img.url)) throw new AgentError(400, 'An attached image has an invalid address.');
    }
    if (!req.context || !['home', 'sheet', 'deck', 'doc', 'markdown'].includes(req.context.page)) throw new AgentError(400, 'Missing context.');
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

    // 1. The new user message: results for any tool calls still pending, then the context, images and text.
    const content: (ToolResult | Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam)[] = [];
    if (conv.pending) content.push(...completePending(conv.pending, req.toolResults ?? []));
    const text = req.message?.trim();
    const images: AgentImage[] = req.images ?? [];
    if (text || images.length) {
      content.push({ type: 'text', text: renderContext(req.context) });
      for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      // The stored addresses let the model place the pictures themselves (set_cell_image, edit_elements, ...).
      const stored = images.map((img, i) => (img.url ? `Attached image ${i + 1} is stored at ${img.url}; use that address with the image tools to put the picture itself in a cell or on a slide.` : null)).filter((s): s is string => !!s);
      if (stored.length) content.push({ type: 'text', text: `<attached_images>\n${stored.join('\n')}\n</attached_images>` });
      content.push({ type: 'text', text: text || 'See the attached image.' });
    }
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
    // Images in a user message come before its text; collect them and attach to the text item.
    let pendingImages: string[] = [];
    for (const block of m.content) {
      if (block.type === 'image' && role === 'user' && block.source.type === 'base64') {
        pendingImages.push(`data:${block.source.media_type};base64,${block.source.data}`);
      } else if (block.type === 'text') {
        const text = role === 'user' ? stripContext(block.text) : block.text;
        if (!text) continue;
        const last = items[items.length - 1];
        if (role === 'assistant' && last?.kind === 'assistant') last.text += text;
        else if (role === 'user' && pendingImages.length) {
          items.push({ kind: 'user', text, images: pendingImages });
          pendingImages = [];
        } else items.push({ kind: role, text });
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
