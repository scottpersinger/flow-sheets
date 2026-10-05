// Deck tools the agent calls, run in the browser against the open presentation's live store, so edits render,
// autosave and undo (as one step per agent request) like the user's own.
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, type AgentImage, type ClientToolCall } from '../../../shared/agent/protocol.ts';
import {
  buildSlide,
  type Deck,
  type Slide,
  deckOutline,
  newId,
  toParagraphs,
  updateSlideContent,
  validateElement,
  type LayoutId,
  type ShapeElement,
  type SlideContent,
  type SlideElement,
  type TextElement,
  type TextStyle,
  type ThemeId,
} from '../../../shared/deck.ts';
import { checkCellImage } from '../../../shared/types.ts';
import type { DeckController } from '../deck/controller.ts';
import type { SlideRender } from '../deck/renderSlide.ts';
import { ToolError } from './toolError.ts';

export const DECK_TOOLS: ReadonlySet<string> = new Set(['read_deck', 'add_slides', 'update_slide', 'edit_elements', 'delete_slides', 'move_slide', 'set_deck_theme']);

export interface DeckToolEnv {
  deck: DeckController | null;
  group: string;
}

type Input = Record<string, unknown>;

function requireDeck(env: DeckToolEnv): DeckController {
  if (!env.deck) throw new ToolError('No presentation is open. Use list_decks to find one and open_deck to open it, or create_deck.');
  return env.deck;
}

/** 0-based index of a 1-based slide number, checked against the deck. */
function slideIndex(ctl: DeckController, n: unknown): number {
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= ctl.deck.slides.length) {
    throw new ToolError(`There is no slide ${n}. The presentation has ${ctl.deck.slides.length} slide${ctl.deck.slides.length === 1 ? '' : 's'}.`);
  }
  return i;
}

const spec = (s: Input): SlideContent & { layout?: LayoutId } => ({
  ...(s.layout !== undefined ? { layout: s.layout as LayoutId } : {}),
  ...(typeof s.title === 'string' ? { title: s.title } : {}),
  ...(typeof s.subtitle === 'string' ? { subtitle: s.subtitle } : {}),
  ...(Array.isArray(s.body) ? { body: s.body as string[] } : {}),
  ...(Array.isArray(s.body2) ? { body2: s.body2 as string[] } : {}),
  ...(typeof s.image === 'string' ? { image: s.image } : {}),
  ...(typeof s.caption === 'string' ? { caption: s.caption } : {}),
  ...(typeof s.notes === 'string' ? { notes: s.notes } : {}),
  ...(typeof s.background === 'string' ? { background: s.background } : {}),
});

function checkImage(src: unknown): string {
  const problem = checkCellImage(src);
  if (problem) throw new ToolError(`${problem}.`);
  return src as string;
}

/** Merge an element spec from edit_elements into an existing element, or build a new one. */
function applyElementSpec(existing: SlideElement | undefined, s: Input): SlideElement {
  const type = (s.type ?? existing?.type) as SlideElement['type'] | undefined;
  if (!type) throw new ToolError('A new element needs a type: text, image or shape.');
  if (existing && s.type && s.type !== existing.type) throw new ToolError(`Element ${existing.id} is a ${existing.type}; its type cannot change. Remove it and add a new one.`);
  const box = {
    x: typeof s.x === 'number' ? s.x : (existing?.x ?? 80),
    y: typeof s.y === 'number' ? s.y : (existing?.y ?? 80),
    w: typeof s.w === 'number' ? s.w : (existing?.w ?? (type === 'text' ? 400 : type === 'image' ? 320 : 200)),
    h: typeof s.h === 'number' ? s.h : (existing?.h ?? (type === 'text' ? 80 : type === 'image' ? 180 : 120)),
  };
  const id = existing?.id ?? newId();
  if (type === 'text') {
    const prev = existing as TextElement | undefined;
    const style: Record<string, unknown> = { ...prev?.style };
    const set = (k: keyof TextStyle, v: unknown) => {
      if (v === undefined) return;
      if (v === '' || v === false) delete style[k];
      else style[k] = v;
    };
    set('size', s.size);
    set('bold', s.bold);
    set('italic', s.italic);
    set('color', s.color);
    set('align', s.align);
    set('valign', s.valign);
    set('font', s.font);
    set('lineHeight', s.line_height);
    const role = (s.role as TextElement['role']) ?? prev?.role;
    const paragraphs = typeof s.text === 'string' ? toParagraphs(s.text.split('\n')) : (prev?.paragraphs ?? [{ text: '' }]);
    const el: TextElement = { id, type: 'text', ...box, paragraphs, ...(role ? { role } : {}), ...(Object.keys(style).length ? { style: style as TextStyle } : {}) };
    return el;
  }
  if (type === 'image') {
    const prev = existing?.type === 'image' ? existing : undefined;
    const src = s.src !== undefined ? checkImage(s.src) : prev?.src;
    if (!src) throw new ToolError('An image element needs src.');
    const fit = (s.fit as 'contain' | 'cover' | undefined) ?? prev?.fit;
    return { id, type: 'image', ...box, src, ...(fit ? { fit } : {}) };
  }
  const prev = existing?.type === 'shape' ? existing : undefined;
  const shape = (s.shape as ShapeElement['shape'] | undefined) ?? prev?.shape ?? 'rect';
  const el: ShapeElement = { id, type: 'shape', shape, ...box };
  const fill = s.fill !== undefined ? s.fill : prev?.fill;
  const stroke = s.stroke !== undefined ? s.stroke : prev?.stroke;
  const strokeWidth = s.stroke_width !== undefined ? s.stroke_width : prev?.strokeWidth;
  const text = s.text !== undefined ? s.text : prev?.text;
  const textColor = s.color !== undefined ? s.color : prev?.textColor;
  if (fill) el.fill = fill as string;
  if (stroke) el.stroke = stroke as string;
  if (typeof strokeWidth === 'number') el.strokeWidth = strokeWidth;
  if (text) el.text = text as string;
  if (textColor) el.textColor = textColor as string;
  // Label style; "" or false clears a property, as for text elements.
  const label = <T,>(v: unknown, old: T | undefined): T | undefined => (v === undefined ? old : v === '' || v === false ? undefined : (v as T));
  const textSize = label<number>(s.size, prev?.textSize);
  const textFont = label<string>(s.font, prev?.textFont);
  if (textSize !== undefined) el.textSize = textSize;
  if (textFont) el.textFont = textFont;
  if (label<boolean>(s.bold, prev?.textBold)) el.textBold = true;
  if (label<boolean>(s.italic, prev?.textItalic)) el.textItalic = true;
  return el;
}

export interface RenderSlideEnv {
  deck: DeckController | null;
  /** Id of the open presentation. */
  deckId?: string | null;
  /** Load a saved presentation by id. */
  loadDeck?(id: string): Promise<Deck>;
  /** Draw a slide with the app's renderer (client/src/deck/renderSlide.ts). */
  renderSlide?(slide: Slide, theme: ThemeId, scale: number): Promise<SlideRender>;
  uploadImage(file: Blob): Promise<string>;
  /** Attach a picture to the message that carries the tool results back to Claude; false if no room is left. */
  attachImage?(image: AgentImage): boolean;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}

/** render_slide: a PNG of a slide as the app draws it, attached for Claude to look at, plus overflowing text. */
export async function renderSlideTool(call: ClientToolCall, env: RenderSlideEnv): Promise<string> {
  const i = call.input;
  if (!env.renderSlide || !env.attachImage) throw new ToolError('Rendering slides is not available here.');
  const deckId = typeof i.deck_id === 'string' && i.deck_id ? i.deck_id : null;
  let deck: Deck;
  if (env.deck && (!deckId || deckId === env.deckId)) deck = env.deck.deck;
  else if (deckId) {
    if (!env.loadDeck) throw new ToolError('Only the open presentation can be rendered here.');
    try {
      deck = await env.loadDeck(deckId);
    } catch {
      throw new ToolError(`No presentation with id "${deckId}". Use list_decks to find ids.`);
    }
  } else throw new ToolError('No presentation is open. Pass deck_id, or open one with open_deck.');
  const n = Number(i.slide);
  if (!Number.isInteger(n) || n < 1 || n > deck.slides.length) {
    throw new ToolError(`There is no slide ${i.slide}. The presentation has ${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'}.`);
  }
  const scale = typeof i.scale === 'number' ? i.scale : 1;
  const r = await env.renderSlide(deck.slides[n - 1], deck.theme, scale);
  if (r.blob.size > MAX_IMAGE_BYTES) throw new ToolError(`The image is too large (${Math.round(r.blob.size / 1e6)} MB). Use a smaller scale.`);
  let url: string | null = null;
  try {
    url = await env.uploadImage(r.blob);
  } catch {
    // The picture is still attached; only the stored address is missing.
  }
  const attached = env.attachImage({ mediaType: 'image/png', data: await blobToBase64(r.blob), ...(url ? { url } : {}) });
  return JSON.stringify({
    slide: n,
    width: r.width,
    height: r.height,
    ...(url ? { image_url: url } : {}),
    image: attached
      ? 'Attached to this message after the tool results, labeled render_slide. Look at it before reporting back.'
      : `Not attached: at most ${MAX_IMAGES_PER_MESSAGE} pictures fit in one message. Call render_slide again for this slide.`,
    overflow: r.overflow,
    ...(r.missingImages.length ? { images_not_rendered: r.missingImages } : {}),
  });
}

/** A question to ask before a destructive deck call, or null. */
export function deckConfirmationFor(call: ClientToolCall, deck: DeckController | null): string | null {
  if (call.name !== 'delete_slides' || !deck) return null;
  const nums = (call.input.slides as number[]).filter((n) => n >= 1 && n <= deck.deck.slides.length);
  if (!nums.length) return null;
  return nums.length === 1 ? `Delete slide ${nums[0]}?` : `Delete ${nums.length} slides (${nums.join(', ')})?`;
}

export function runDeckTool(call: ClientToolCall, env: DeckToolEnv): string {
  const i = call.input;
  const ctl = requireDeck(env);
  const run = (fn: Parameters<DeckController['runAgent']>[1]) => ctl.runAgent(env.group, fn);

  switch (call.name) {
    case 'read_deck':
      return JSON.stringify({ ...deckOutline(ctl.deck, ctl.current), ...(ctl.selection.length ? { selected_elements: ctl.selection } : {}) });

    case 'add_slides': {
      const specs = (i.slides as Input[]).map(spec);
      for (const s of specs) if (s.image) checkImage(s.image);
      const at = i.at === undefined ? ctl.deck.slides.length : slideIndex(ctl, i.at);
      const slides = specs.map((s) => buildSlide(s.layout ?? 'title-body', s, newId));
      run((tx) => slides.forEach((s, k) => tx.insertSlide(at + k, s)));
      ctl.goTo(at + slides.length - 1);
      return JSON.stringify({ added_slides: slides.map((_, k) => at + k + 1), slide_count: ctl.deck.slides.length });
    }

    case 'update_slide': {
      const index = slideIndex(ctl, i.slide);
      const content = spec(i);
      if (content.image) checkImage(content.image);
      if (!Object.keys(content).length) throw new ToolError('Pass at least one property to change (title, body, notes, layout, ...).');
      run((tx) => tx.updateSlide(index, (s) => updateSlideContent(s, content, newId)));
      ctl.goTo(index);
      return JSON.stringify({ updated_slide: index + 1, changed: Object.keys(content) });
    }

    case 'edit_elements': {
      const index = slideIndex(ctl, i.slide);
      const sets = (i.set as Input[] | undefined) ?? [];
      const removes = new Set((i.remove as string[] | undefined) ?? []);
      if (!sets.length && !removes.size) throw new ToolError('Pass elements to set and/or ids to remove.');
      const slide = ctl.deck.slides[index];
      const byId = new Map(slide.elements.map((e) => [e.id, e]));
      for (const id of removes) if (!byId.has(id)) throw new ToolError(`Slide ${index + 1} has no element "${id}". Use read_deck for the ids.`);
      const changed: SlideElement[] = [];
      for (const s of sets) {
        const existing = typeof s.id === 'string' ? byId.get(s.id) : undefined;
        if (typeof s.id === 'string' && !existing) throw new ToolError(`Slide ${index + 1} has no element "${s.id}". Omit id to add a new element.`);
        const el = applyElementSpec(existing, s);
        const problem = validateElement(el, `slide ${index + 1}`);
        if (problem) throw new ToolError(problem);
        changed.push(el);
      }
      run((tx) =>
        tx.updateSlide(index, (s) => {
          let elements = s.elements.filter((e) => !removes.has(e.id));
          for (const el of changed) {
            const k = elements.findIndex((e) => e.id === el.id);
            if (k >= 0) elements = elements.map((e, j) => (j === k ? el : e));
            else elements = [...elements, el];
          }
          return { ...s, elements };
        }),
      );
      ctl.goTo(index);
      ctl.select(changed.map((e) => e.id));
      return JSON.stringify({ slide: index + 1, set: changed.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h })), removed: [...removes] });
    }

    case 'delete_slides': {
      const indices = [...new Set((i.slides as number[]).map((n) => slideIndex(ctl, n)))];
      if (indices.length >= ctl.deck.slides.length) throw new ToolError('Cannot delete every slide; a presentation keeps at least one.');
      const n = ctl.deleteSlidesAgent(env.group, indices);
      return JSON.stringify({ deleted: n, slide_count: ctl.deck.slides.length });
    }

    case 'move_slide': {
      const from = slideIndex(ctl, i.slide);
      const to = slideIndex(ctl, i.to);
      run((tx) => tx.moveSlide(from, to));
      ctl.goTo(to);
      return JSON.stringify({ moved_slide: from + 1, to: to + 1 });
    }

    case 'set_deck_theme': {
      run((tx) => tx.setTheme(i.theme as ThemeId));
      return JSON.stringify({ theme: ctl.deck.theme });
    }

    default:
      throw new ToolError(`Unknown tool ${call.name}.`);
  }
}
