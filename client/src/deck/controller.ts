// Editor state for an open presentation: the current slide, selected and edited elements, clipboard, and
// the operations the toolbar, menus, keyboard and the assistant's deck tools use.
import { useSyncExternalStore } from 'react';
import {
  buildSlide,
  layoutElements,
  newId,
  SLIDE_H,
  SLIDE_W,
  slideContent,
  type Deck,
  type LayoutId,
  type LineElement,
  type LineKind,
  type ShapeKind,
  type Slide,
  type SlideContent,
  type SlideElement,
  type TextElement,
  type TextStyle,
  type ThemeId,
  withEditedPicture,
  type ImageElement,
} from '../../../shared/deck.ts';
import { boxFromEnds, cloneElements, DEFAULT_LINE_WIDTH } from '../../../shared/lines.ts';
import { SHAPES } from '../../../shared/shapes.ts';
import { AutoSaver } from '../state/store.ts';
import { DeckStore, type DeckTx } from './store.ts';

interface Meta {
  slideId: string;
  selection: string[];
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward';

/** An element without an id yet (one is assigned when it is added). */
export type NewElement = { [K in SlideElement['type']]: Omit<Extract<SlideElement, { type: K }>, 'id'> & { id?: string } }[SlideElement['type']];

export class DeckController {
  readonly store: DeckStore<Meta>;
  readonly saver: AutoSaver<Deck>;
  /** Index of the slide being edited. */
  current = 0;
  /** Ids of the selected elements on the current slide. */
  selection: string[] = [];
  /** Element whose text is being edited inline. */
  editing: string | null = null;
  /** The picture element being cropped (its crop frame is on the slide), if any. */
  cropping: string | null = null;
  /** The line tool picked in the toolbar: the next drag on the slide draws this kind of line. */
  tool: { kind: LineKind; arrow: boolean } | null = null;
  /** Presenting (full-screen) mode. */
  presenting = false;
  /** The prompt to the assistant, while it is open on the slide (Mod-J), with the text that was selected in the text box being edited. */
  assistant: { text?: string } | null = null;
  /** How many times replaceWith brought in a version saved elsewhere (the page can tell the user). */
  externalChanges = 0;
  version = 0;
  private clipboard: SlideElement[] = [];
  private listeners = new Set<() => void>();

  constructor(deck: Deck, save: (deck: Deck) => Promise<void>) {
    this.store = new DeckStore<Meta>(deck);
    this.saver = new AutoSaver<Deck>(this.store, save);
    this.store.subscribe(() => {
      this.clamp();
      this.emit();
    });
  }

  dispose(): void {
    this.saver.dispose();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  get deck(): Deck {
    return this.store.deck;
  }

  get slide(): Slide {
    return this.deck.slides[this.current];
  }

  /** Keep the current slide and selection valid after any change. */
  private clamp(): void {
    this.current = Math.max(0, Math.min(this.current, this.deck.slides.length - 1));
    const ids = new Set(this.slide.elements.map((e) => e.id));
    this.selection = this.selection.filter((id) => ids.has(id));
    if (this.editing && !ids.has(this.editing)) this.editing = null;
    if (this.cropping && !ids.has(this.cropping)) this.cropping = null;
  }

  private meta(): Meta {
    return { slideId: this.slide.id, selection: this.selection };
  }

  private restoreMeta(m: Meta): void {
    const i = this.deck.slides.findIndex((s) => s.id === m.slideId);
    if (i >= 0) this.current = i;
    this.selection = m.selection;
    this.editing = null;
    this.cropping = null;
    this.clamp();
  }

  run(fn: (tx: DeckTx) => void): boolean {
    const before = this.meta();
    const changed = this.store.transact(fn, { before });
    if (changed) this.store.amendLastMeta(this.meta());
    this.emit();
    return changed;
  }

  /** A change made by the agent. All changes with the same group (one agent request) undo as one step. */
  runAgent(group: string, fn: (tx: DeckTx) => void): boolean {
    this.editing = null;
    this.cropping = null;
    const before = this.meta();
    const changed = this.store.transact(fn, { before }, group);
    if (changed) this.store.amendLastMeta(this.meta());
    this.emit();
    return changed;
  }

  /**
   * Swap in another version of the presentation (saved elsewhere, e.g. by the assistant in ChatGPT) as one
   * undoable step, slide by slide, so the current slide and selection survive where they still exist.
   */
  replaceWith(next: Deck): boolean {
    const cur = this.deck;
    if (JSON.stringify(cur) === JSON.stringify(next)) return false;
    const changed = this.run((tx) => {
      if (cur.theme !== next.theme) tx.setTheme(next.theme);
      const shared = Math.min(cur.slides.length, next.slides.length);
      for (let i = 0; i < shared; i++) if (JSON.stringify(cur.slides[i]) !== JSON.stringify(next.slides[i])) tx.replaceSlide(i, next.slides[i]);
      for (let i = cur.slides.length - 1; i >= shared; i--) tx.removeSlide(i);
      for (let i = shared; i < next.slides.length; i++) tx.insertSlide(i, next.slides[i]);
    });
    if (changed) this.externalChanges++;
    return changed;
  }

  undo(): void {
    const e = this.store.undo();
    if (e?.metaBefore) this.restoreMeta(e.metaBefore);
    this.emit();
  }

  redo(): void {
    const e = this.store.redo();
    if (e?.metaAfter) this.restoreMeta(e.metaAfter);
    this.emit();
  }

  // --- Navigation and selection -------------------------------------------------

  goTo(index: number): void {
    const i = Math.max(0, Math.min(index, this.deck.slides.length - 1));
    if (i === this.current && !this.selection.length && !this.editing && !this.cropping) return;
    this.current = i;
    this.selection = [];
    this.editing = null;
    this.cropping = null;
    this.emit();
  }

  select(ids: string[]): void {
    this.selection = ids;
    if (this.editing && !ids.includes(this.editing)) this.editing = null;
    if (this.cropping && !ids.includes(this.cropping)) this.cropping = null;
    this.emit();
  }

  toggleSelect(id: string): void {
    this.select(this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id]);
  }

  startEditing(id: string): void {
    const el = this.slide.elements.find((e) => e.id === id);
    if (!el || (el.type !== 'text' && el.type !== 'shape')) return;
    this.selection = [id];
    this.editing = id;
    this.cropping = null;
    this.emit();
  }

  /** Put the crop frame on a picture of the current slide (DeckEditor draws it; CropOverlay ends it). */
  startCropping(id: string): void {
    const el = this.slide.elements.find((e) => e.id === id);
    if (!el || el.type !== 'image') return;
    this.selection = [id];
    this.editing = null;
    this.cropping = id;
    this.emit();
  }

  /** Take the crop frame away; with `cropped`, the element as the frame leaves it (one step, for undo). */
  stopCropping(cropped?: ImageElement): void {
    const id = this.cropping;
    if (!id) return;
    this.cropping = null;
    const now = this.slide.elements.find((e) => e.id === id);
    if (cropped && now && JSON.stringify(now) !== JSON.stringify(cropped)) this.updateElements([id], (e) => (e.type === 'image' ? cropped : e));
    else this.emit();
  }

  stopEditing(): void {
    if (!this.editing) return;
    this.editing = null;
    this.emit();
  }

  setTool(tool: DeckController['tool']): void {
    this.tool = tool;
    if (tool) {
      this.editing = null;
      this.cropping = null;
      this.selection = [];
    }
    this.emit();
  }

  setAssistant(assistant: DeckController['assistant']): void {
    if (!assistant && !this.assistant) return;
    this.assistant = assistant;
    this.emit();
  }

  setPresenting(on: boolean): void {
    this.presenting = on;
    this.assistant = null;
    this.editing = null;
    this.cropping = null;
    this.emit();
  }

  /** The selected elements of the current slide. */
  get selected(): SlideElement[] {
    return this.slide.elements.filter((e) => this.selection.includes(e.id));
  }

  // --- Slides --------------------------------------------------------------------

  /** Add a slide after the current one (or at `at`) and go to it. */
  addSlide(layout: LayoutId = 'title-body', content: SlideContent = {}, at?: number): number {
    const index = at ?? this.current + 1;
    this.run((tx) => tx.insertSlide(index, buildSlide(layout, content, newId)));
    this.goTo(Math.min(index, this.deck.slides.length - 1));
    return this.current;
  }

  duplicateSlide(index = this.current): void {
    const src = this.deck.slides[index];
    if (!src) return;
    const copy: Slide = { ...src, id: newId(), elements: cloneElements(src.elements, newId) };
    this.run((tx) => tx.insertSlide(index + 1, copy));
    this.goTo(index + 1);
  }

  /** Delete slides by index; the deck keeps at least one slide. Returns how many were deleted. */
  deleteSlides(indices: number[]): number {
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.deck.slides.length).sort((a, b) => b - a);
    const keep = Math.max(0, this.deck.slides.length - sorted.length);
    const toDelete = keep === 0 ? sorted.slice(0, -1) : sorted;
    if (!toDelete.length) return 0;
    this.run((tx) => {
      for (const i of toDelete) tx.removeSlide(i);
    });
    return toDelete.length;
  }

  /** deleteSlides for the agent: part of its undo group. */
  deleteSlidesAgent(group: string, indices: number[]): number {
    const sorted = [...new Set(indices)].sort((a, b) => b - a).slice(0, Math.max(0, this.deck.slides.length - 1));
    if (!sorted.length) return 0;
    this.runAgent(group, (tx) => {
      for (const i of sorted) tx.removeSlide(i);
    });
    return sorted.length;
  }

  moveSlide(from: number, to: number): void {
    this.run((tx) => tx.moveSlide(from, to));
    if (this.current === from) this.goTo(to);
  }

  setLayout(layout: LayoutId, index = this.current): void {
    this.run((tx) =>
      tx.updateSlide(index, (s) => ({ ...s, layout, elements: layoutElements(layout, slideContent(s), newId) })),
    );
  }

  setTheme(theme: ThemeId): void {
    this.run((tx) => tx.setTheme(theme));
  }

  setBackground(bg: string | undefined, index = this.current): void {
    this.run((tx) =>
      tx.updateSlide(index, (s) => {
        const next = { ...s };
        if (bg) next.bg = bg;
        else delete next.bg;
        return next;
      }),
    );
  }

  setNotes(notes: string, index = this.current): void {
    this.run((tx) =>
      tx.updateSlide(index, (s) => {
        const next = { ...s };
        if (notes) next.notes = notes;
        else delete next.notes;
        return next;
      }),
    );
  }

  // --- Elements -------------------------------------------------------------------

  /** Add an element to the current slide and select it. */
  addElement(el: NewElement): string {
    const id = el.id ?? newId();
    const full = { ...el, id } as SlideElement;
    this.run((tx) => tx.updateSlide(this.current, (s) => ({ ...s, elements: [...s.elements, full] })));
    this.select([id]);
    return id;
  }

  addText(role: TextElement['role'] = 'body'): string {
    const w = 400;
    const h = 80;
    return this.addElement({ type: 'text', role, x: (SLIDE_W - w) / 2, y: (SLIDE_H - h) / 2, w, h, paragraphs: [{ text: role === 'title' ? 'Title' : 'Text' }] });
  }

  addShape(shape: ShapeKind): string {
    if (shape === 'line') return this.addLine('straight');
    const square = SHAPES[shape].square;
    const w = square ? 150 : 200;
    const h = square ? 150 : 120;
    return this.addElement({ type: 'shape', shape, x: (SLIDE_W - w) / 2, y: (SLIDE_H - h) / 2, w, h });
  }

  /** Add a line from (x1, y1) to (x2, y2), by default one across the middle of the slide. */
  addLine(kind: LineKind, arrow = false, ends?: { x1: number; y1: number; x2: number; y2: number } & Partial<Pick<LineElement, 'startConnection' | 'endConnection'>>): string {
    const el: Omit<LineElement, 'id'> = ends
      ? { type: 'line', kind, ...boxFromEnds(ends.x1, ends.y1, ends.x2, ends.y2), strokeWidth: DEFAULT_LINE_WIDTH }
      : { type: 'line', kind, x: (SLIDE_W - 300) / 2, y: SLIDE_H / 2, w: 300, h: kind === 'straight' ? 0 : 100, strokeWidth: DEFAULT_LINE_WIDTH };
    if (arrow) el.endArrow = 'arrow';
    if (ends?.startConnection) el.startConnection = ends.startConnection;
    if (ends?.endConnection) el.endConnection = ends.endConnection;
    return this.addElement(el);
  }

  /** Apply a patch to the selected lines (undefined removes a property). */
  styleLines(patch: Partial<Omit<LineElement, 'id' | 'type'>>): void {
    this.updateElements(this.selection, (e) => {
      if (e.type !== 'line') return e;
      const next = { ...e, ...patch } as Record<string, unknown>;
      for (const k in patch) if (next[k] === undefined) delete next[k];
      return next as unknown as LineElement;
    });
  }

  /** Move elements to new positions (a drag or nudge); lines that move without the shapes they are attached to come loose. */
  moveElements(to: Record<string, { x: number; y: number }>): void {
    const moving = new Set(Object.keys(to));
    this.run((tx) =>
      tx.updateSlide(this.current, (s) => ({
        ...s,
        elements: s.elements.map((e) => {
          if (!moving.has(e.id)) return e;
          const next = { ...e, ...to[e.id] } as SlideElement;
          if (next.type === 'line') {
            if (next.startConnection && !moving.has(next.startConnection.elementId)) delete next.startConnection;
            if (next.endConnection && !moving.has(next.endConnection.elementId)) delete next.endConnection;
          }
          return next;
        }),
      })),
    );
  }

  /** Add an image scaled to fit the slide (natural size is used when known). */
  addImage(src: string, natural?: { w: number; h: number }): string {
    let w = 480;
    let h = 270;
    if (natural && natural.w > 0 && natural.h > 0) {
      const scale = Math.min(1, (SLIDE_W - 120) / natural.w, (SLIDE_H - 120) / natural.h);
      w = Math.round(natural.w * scale);
      h = Math.round(natural.h * scale);
    }
    return this.addElement({ type: 'image', src, x: Math.round((SLIDE_W - w) / 2), y: Math.round((SLIDE_H - h) / 2), w, h });
  }

  /**
   * Put an edited picture in place of an image element's, wherever that element is now (the presentation may
   * have changed while the image editor was open). False when the element is gone.
   */
  replacePicture(id: string, src: string, before: { width: number; height: number } | null, after: { width: number; height: number } | null): boolean {
    const at = this.store.deck.slides.findIndex((s) => s.elements.some((e) => e.id === id && e.type === 'image'));
    if (at < 0) return false;
    return this.run((tx) => tx.updateSlide(at, (s) => ({ ...s, elements: s.elements.map((e) => (e.id === id && e.type === 'image' ? withEditedPicture(e, src, before, after) : e)) })));
  }

  /** Change elements of the current slide with a function (used for drags and style changes). */
  updateElements(ids: string[], fn: (el: SlideElement) => SlideElement): void {
    const set = new Set(ids);
    this.run((tx) => tx.updateSlide(this.current, (s) => ({ ...s, elements: s.elements.map((e) => (set.has(e.id) ? fn(e) : e)) })));
  }

  /** Apply a text style patch to the selected text elements (undefined removes a property). */
  styleSelected(patch: Partial<Record<keyof TextStyle, unknown>>): void {
    this.updateElements(this.selection, (e) => {
      if (e.type !== 'text') return e;
      const style: Record<string, unknown> = { ...e.style };
      for (const k in patch) {
        if (patch[k as keyof TextStyle] === undefined) delete style[k];
        else style[k] = patch[k as keyof TextStyle];
      }
      const next = { ...e } as TextElement;
      if (Object.keys(style).length) next.style = style as TextStyle;
      else delete next.style;
      return next;
    });
  }

  /** Turn bullets on or off for every paragraph of the selected text elements. */
  toggleBullets(): void {
    const texts = this.selected.filter((e): e is TextElement => e.type === 'text');
    if (!texts.length) return;
    const allBullets = texts.every((e) => e.paragraphs.every((p) => p.bullet || !p.text));
    this.updateElements(
      texts.map((e) => e.id),
      (e) => (e.type === 'text' ? { ...e, paragraphs: e.paragraphs.map((p) => (allBullets ? { text: p.text } : { ...p, bullet: true })) } : e),
    );
  }

  removeElements(ids: string[]): void {
    const set = new Set(ids);
    this.run((tx) => tx.updateSlide(this.current, (s) => ({ ...s, elements: s.elements.filter((e) => !set.has(e.id)) })));
  }

  deleteSelected(): void {
    if (this.selection.length) this.removeElements(this.selection);
  }

  reorder(ids: string[], how: ZOrder): void {
    const set = new Set(ids);
    this.run((tx) =>
      tx.updateSlide(this.current, (s) => {
        const els = [...s.elements];
        const moving = els.filter((e) => set.has(e.id));
        const rest = els.filter((e) => !set.has(e.id));
        if (how === 'front') return { ...s, elements: [...rest, ...moving] };
        if (how === 'back') return { ...s, elements: [...moving, ...rest] };
        const idx = els.findIndex((e) => set.has(e.id));
        const last = els.length - 1 - [...els].reverse().findIndex((e) => set.has(e.id));
        if (how === 'forward' && last < els.length - 1) {
          const target = els[last + 1];
          const without = els.filter((e) => e !== target);
          without.splice(idx, 0, target);
          return { ...s, elements: without };
        }
        if (how === 'backward' && idx > 0) {
          const target = els[idx - 1];
          const without = els.filter((e) => e !== target);
          without.splice(last, 0, target);
          return { ...s, elements: without };
        }
        return s;
      }),
    );
  }

  nudge(dx: number, dy: number): void {
    if (!this.selection.length) return;
    const to: Record<string, { x: number; y: number }> = {};
    for (const e of this.selected) to[e.id] = { x: e.x + dx, y: e.y + dy };
    this.moveElements(to);
  }

  copySelected(): void {
    this.clipboard = this.selected.map((e) => ({ ...e }));
  }

  /** Paste copied elements onto the current slide, offset a little, and select them. */
  paste(): void {
    if (!this.clipboard.length) return;
    const copies = cloneElements(this.clipboard, newId, 20, 20);
    this.run((tx) => tx.updateSlide(this.current, (s) => ({ ...s, elements: [...s.elements, ...copies] })));
    this.select(copies.map((c) => c.id));
  }

  duplicateSelected(): void {
    if (!this.selection.length) return;
    this.copySelected();
    this.paste();
  }
}

/** Re-render whenever the controller (selection, current slide or deck) changes. */
export function useDeckController(ctl: DeckController): number {
  return useSyncExternalStore(ctl.subscribe, ctl.getVersion);
}
