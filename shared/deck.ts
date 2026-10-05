// Slide deck file format (stored as one JSON file per deck on the server, next to spreadsheets).
//
// A slide is a fixed 960×540 point canvas (PowerPoint's default 16:9 size, so an export maps 1:1) with
// absolutely positioned elements. Elements are text boxes (paragraphs with per-paragraph bullets), images
// (same storage as cell images) and simple shapes. Slides are usually built from a layout: a handful of
// named arrangements (title, title + body, two columns, ...) that turn plain content into positioned
// elements, so both the UI and the assistant can make slides without choosing coordinates.
import { SHAPE_KINDS, tightArc, type ShapeKind } from './shapes.ts';
import { checkCellImage } from './types.ts';

export type { ShapeKind };

export const SLIDE_W = 960;
export const SLIDE_H = 540;

export const THEME_IDS = ['light', 'dark', 'ocean', 'forest', 'sunset', 'paper'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const LAYOUT_IDS = ['title', 'section', 'title-body', 'two-column', 'image', 'blank'] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];

export type TextRole = 'title' | 'subtitle' | 'body' | 'caption';

export interface TextStyle {
  /** Font size in points; defaults depend on the role. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  /** CSS color; defaults to the theme's text (or heading) color. */
  color?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  /** Font family name (e.g. "Inter"); the theme font is the fallback. */
  font?: string;
  /** Line height as a multiple of the font size. Defaults to 1.25. */
  lineHeight?: number;
  /** Space between paragraphs in points. Defaults to 0.3 × the font size. */
  paraSpacing?: number;
}

export interface Paragraph {
  text: string;
  bullet?: boolean;
  /** Indent level for bullets, 0 to 4. */
  level?: number;
  /** Overrides of the element's text style for this paragraph (a big number over a small caption, say). */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
}

interface ElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextElement extends ElementBase {
  type: 'text';
  /** What the text box is for; the theme picks the default font, size and color from it. */
  role?: TextRole;
  paragraphs: Paragraph[];
  style?: TextStyle;
}

export interface ImageElement extends ElementBase {
  type: 'image';
  /** Same addresses as cell images: /api/images/<id>, a data:image URL or an http(s) URL. */
  src: string;
  /** How the image fills the box. Defaults to contain. */
  fit?: 'contain' | 'cover';
}

export interface ShapeElement extends ElementBase {
  type: 'shape';
  /** A line is horizontal when it is wider than tall (h is usually 0), vertical otherwise (w is 0). */
  shape: ShapeKind;
  /** Fill color (any CSS color, including rgba() for translucency); defaults to the theme accent. "none" for no fill. */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  /** Arc shapes: start and end angle in degrees, clockwise from 3 o'clock. Default 270 and 0 (the top-right quarter). */
  startAngle?: number;
  endAngle?: number;
  /** Arc shapes: the box tightly bounds the arc stroke (the ellipse is derived from box, angles and stroke width). Absent on old arcs whose box is the whole ellipse. */
  tight?: boolean;
  /** Optional label centered in the shape. */
  text?: string;
  textColor?: string;
  /** Label font size in points. Defaults to 18. */
  textSize?: number;
  textBold?: boolean;
  textItalic?: boolean;
  /** Label font family (e.g. "Inter"); the theme body font is the fallback. */
  textFont?: string;
}

export type SlideElement = TextElement | ImageElement | ShapeElement;

export interface Slide {
  id: string;
  /** Layout the slide was built from, for the UI's "layout" picker. */
  layout?: LayoutId;
  /** Background color; defaults to the theme background. */
  bg?: string;
  /** Speaker notes. */
  notes?: string;
  /** In drawing order (last is on top). */
  elements: SlideElement[];
}

export interface Deck {
  version: 1;
  theme: ThemeId;
  slides: Slide[];
}

// ---------------------------------------------------------------------------
// Themes

export interface Theme {
  id: ThemeId;
  name: string;
  bg: string;
  text: string;
  heading: string;
  muted: string;
  accent: string;
  headingFont: string;
  bodyFont: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  light: {
    id: 'light',
    name: 'Light',
    bg: '#ffffff',
    text: '#1f1f1f',
    heading: '#1f1f1f',
    muted: '#5f6368',
    accent: '#1a73e8',
    headingFont: "'Google Sans', Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  dark: {
    id: 'dark',
    name: 'Dark',
    bg: '#1b1b1f',
    text: '#e8eaed',
    heading: '#ffffff',
    muted: '#9aa0a6',
    accent: '#8ab4f8',
    headingFont: "'Google Sans', Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  ocean: {
    id: 'ocean',
    name: 'Ocean',
    bg: '#0b2545',
    text: '#e0e7f1',
    heading: '#ffffff',
    muted: '#8da9c4',
    accent: '#13a3b5',
    headingFont: "Georgia, 'Times New Roman', serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  forest: {
    id: 'forest',
    name: 'Forest',
    bg: '#f4f7f2',
    text: '#243126',
    heading: '#1e4d2b',
    muted: '#5e6f61',
    accent: '#2e7d32',
    headingFont: "'Google Sans', Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    bg: '#fff7f0',
    text: '#3a2a22',
    heading: '#b23a1b',
    muted: '#8a6f63',
    accent: '#f28c28',
    headingFont: "Georgia, 'Times New Roman', serif",
    bodyFont: "Roboto, -apple-system, 'Segoe UI', Arial, sans-serif",
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    bg: '#faf8f3',
    text: '#2b2b2b',
    heading: '#2b2b2b',
    muted: '#6b6b6b',
    accent: '#8d6e63',
    headingFont: "Georgia, 'Times New Roman', serif",
    bodyFont: "Georgia, 'Times New Roman', serif",
  },
};

/** Default font size (points) for a text role. */
export const ROLE_SIZE: Record<TextRole, number> = { title: 40, subtitle: 22, body: 18, caption: 14 };

// ---------------------------------------------------------------------------
// Layouts

/** Plain content for a slide; the layout decides where it goes. */
export interface SlideContent {
  title?: string;
  subtitle?: string;
  /** Body text: one string per paragraph. Lines starting with "- " or "* " become bullets. */
  body?: string[];
  /** Right column of a two-column layout. */
  body2?: string[];
  /** Image address for the image layout. */
  image?: string;
  caption?: string;
  notes?: string;
  background?: string;
}

const M = 60; // slide margin

/** Turn body lines into paragraphs: "- text" or "* text" is a bullet; leading two spaces per level indent it. */
export function toParagraphs(lines: string[] | undefined, bulletsByDefault = false): Paragraph[] {
  const out: Paragraph[] = [];
  for (const raw of lines ?? []) {
    for (const line of raw.split('\n')) {
      const m = /^(\s*)([-*•]\s+)?(.*)$/.exec(line)!;
      const level = Math.min(4, Math.floor(m[1].length / 2));
      const bullet = !!m[2] || (bulletsByDefault && line.trim() !== '');
      const text = m[3];
      out.push({ text, ...(bullet ? { bullet: true } : {}), ...(bullet && level ? { level } : {}) });
    }
  }
  return out;
}

/** Paragraphs back to body lines (the inverse of toParagraphs). */
export function fromParagraphs(ps: Paragraph[]): string[] {
  return ps.map((p) => (p.bullet ? `${'  '.repeat(p.level ?? 0)}- ${p.text}` : p.text));
}

function textEl(id: string, role: TextRole, paragraphs: Paragraph[], box: [number, number, number, number], style?: TextStyle): TextElement {
  const [x, y, w, h] = box;
  return { id, type: 'text', role, x, y, w, h, paragraphs, ...(style ? { style } : {}) };
}

const one = (s: string | undefined, fallback: string): Paragraph[] => [{ text: s ?? fallback }];

/**
 * Elements for a slide built from a layout. Missing content gets a placeholder so the user sees where to type.
 * `nextId` supplies element ids.
 */
export function layoutElements(layout: LayoutId, c: SlideContent, nextId: () => string): SlideElement[] {
  const W = SLIDE_W;
  const H = SLIDE_H;
  switch (layout) {
    case 'title':
      return [
        textEl(nextId(), 'title', one(c.title, 'Presentation title'), [M, 170, W - 2 * M, 110], { align: 'center', valign: 'bottom' }),
        textEl(nextId(), 'subtitle', one(c.subtitle, 'Subtitle'), [M, 290, W - 2 * M, 60], { align: 'center', valign: 'top' }),
      ];
    case 'section':
      return [
        { id: nextId(), type: 'shape', shape: 'rect', x: M, y: 300, w: 120, h: 6 },
        textEl(nextId(), 'title', one(c.title, 'Section title'), [M, 180, W - 2 * M, 110], { valign: 'bottom' }),
        ...(c.subtitle !== undefined ? [textEl(nextId(), 'subtitle', one(c.subtitle, ''), [M, 320, W - 2 * M, 60])] : []),
      ];
    case 'title-body': {
      const body = c.body?.length ? toParagraphs(c.body, true) : [{ text: 'Click to add text', bullet: true }];
      return [textEl(nextId(), 'title', one(c.title, 'Slide title'), [M, 40, W - 2 * M, 80], { valign: 'bottom' }), textEl(nextId(), 'body', body, [M, 140, W - 2 * M, H - 140 - M])];
    }
    case 'two-column': {
      const colW = (W - 2 * M - 40) / 2;
      const left = c.body?.length ? toParagraphs(c.body, true) : [{ text: 'Left column', bullet: true }];
      const right = c.body2?.length ? toParagraphs(c.body2, true) : [{ text: 'Right column', bullet: true }];
      return [
        textEl(nextId(), 'title', one(c.title, 'Slide title'), [M, 40, W - 2 * M, 80], { valign: 'bottom' }),
        textEl(nextId(), 'body', left, [M, 140, colW, H - 140 - M]),
        textEl(nextId(), 'body', right, [M + colW + 40, 140, colW, H - 140 - M]),
      ];
    }
    case 'image': {
      const els: SlideElement[] = [textEl(nextId(), 'title', one(c.title, 'Slide title'), [M, 40, W - 2 * M, 80], { valign: 'bottom' })];
      const imgBox = { x: M, y: 140, w: W - 2 * M, h: c.caption !== undefined ? H - 140 - M - 50 : H - 140 - M };
      if (c.image) els.push({ id: nextId(), type: 'image', src: c.image, ...imgBox });
      else els.push({ id: nextId(), type: 'shape', shape: 'rounded', fill: 'none', stroke: '#9aa0a6', strokeWidth: 2, text: 'Insert an image', ...imgBox });
      if (c.caption !== undefined) els.push(textEl(nextId(), 'caption', one(c.caption, ''), [M, H - M - 40, W - 2 * M, 40], { align: 'center' }));
      return els;
    }
    case 'blank':
      return [];
  }
}

/** A new slide from a layout and content. */
export function buildSlide(layout: LayoutId, content: SlideContent, nextId: () => string): Slide {
  const elements = layoutElements(layout, content, nextId);
  return {
    id: nextId(),
    layout,
    elements,
    ...(content.notes ? { notes: content.notes } : {}),
    ...(content.background ? { bg: content.background } : {}),
  };
}

/** The content of a slide by role, for rebuilding it with another layout or changing one part of it. */
export function slideContent(slide: Slide): SlideContent {
  const texts = slide.elements.filter((e): e is TextElement => e.type === 'text');
  const byRole = (role: TextRole, skip = 0) => texts.filter((e) => (e.role ?? 'body') === role)[skip];
  const title = byRole('title');
  const subtitle = byRole('subtitle');
  const body = byRole('body');
  const body2 = byRole('body', 1);
  const caption = byRole('caption');
  const image = slide.elements.find((e): e is ImageElement => e.type === 'image');
  return {
    ...(title ? { title: title.paragraphs.map((p) => p.text).join('\n') } : {}),
    ...(subtitle ? { subtitle: subtitle.paragraphs.map((p) => p.text).join('\n') } : {}),
    ...(body ? { body: fromParagraphs(body.paragraphs) } : {}),
    ...(body2 ? { body2: fromParagraphs(body2.paragraphs) } : {}),
    ...(image ? { image: image.src } : {}),
    ...(caption ? { caption: caption.paragraphs.map((p) => p.text).join('\n') } : {}),
    ...(slide.notes ? { notes: slide.notes } : {}),
    ...(slide.bg ? { background: slide.bg } : {}),
  };
}

/**
 * Change parts of a slide by role without moving its elements. A text role the slide has no element for, or a
 * new layout, rebuilds the elements from the layout with the merged content.
 */
export function updateSlideContent(slide: Slide, content: SlideContent & { layout?: LayoutId }, nextId: () => string): Slide {
  const next: Slide = { ...slide };
  if (content.notes !== undefined) {
    if (content.notes) next.notes = content.notes;
    else delete next.notes;
  }
  if (content.background !== undefined) {
    if (content.background) next.bg = content.background;
    else delete next.bg;
  }
  const texts = slide.elements.filter((e): e is TextElement => e.type === 'text');
  const roleEl = (role: TextRole, skip = 0) => texts.filter((e) => (e.role ?? 'body') === role)[skip];
  const wanted: [TextRole, number, string[] | undefined][] = [
    ['title', 0, content.title === undefined ? undefined : [content.title]],
    ['subtitle', 0, content.subtitle === undefined ? undefined : [content.subtitle]],
    ['body', 0, content.body],
    ['body', 1, content.body2],
    ['caption', 0, content.caption === undefined ? undefined : [content.caption]],
  ];
  const image = slide.elements.find((e): e is ImageElement => e.type === 'image');
  const missing = wanted.some(([role, skip, lines]) => lines !== undefined && !roleEl(role, skip)) || (content.image !== undefined && !image);
  if (content.layout || missing) {
    const merged = { ...slideContent(slide), ...content };
    const layout = content.layout ?? slide.layout ?? 'title-body';
    return { ...next, layout, elements: layoutElements(layout, merged, nextId) };
  }
  let elements = slide.elements;
  for (const [role, skip, lines] of wanted) {
    if (lines === undefined) continue;
    const el = roleEl(role, skip)!;
    const paragraphs = role === 'body' ? toParagraphs(lines, true) : toParagraphs(lines);
    elements = elements.map((e) => (e.id === el.id ? { ...el, paragraphs } : e));
  }
  if (content.image !== undefined && image) elements = elements.map((e) => (e.id === image.id ? { ...image, src: content.image! } : e));
  return { ...next, elements };
}

let idCounter = 0;
/** Short unique ids for slides and elements. */
export function newId(): string {
  idCounter = (idCounter + 1) % 1296;
  return `${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export function newDeck(): Deck {
  return { version: 1, theme: 'light', slides: [buildSlide('title', {}, newId)] };
}

/** The text of a slide for the thumbnail strip and the agent: the title if any, else the first text. */
export function slideTitle(slide: Slide): string {
  const title = slide.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'title');
  const first = title ?? slide.elements.find((e): e is TextElement => e.type === 'text');
  return first?.paragraphs.map((p) => p.text).join(' ').trim() ?? '';
}

// ---------------------------------------------------------------------------
// Validation (guards saved files and tool input, not a full schema)

const MAX_SLIDES = 500;
const MAX_ELEMENTS = 200;
const MAX_PARAGRAPHS = 500;
const MAX_TEXT = 20_000;
const COORD = 20_000;

const isColor = (v: unknown) => typeof v === 'string' && v.length <= 64;
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

export function validateElement(e: unknown, where: string): string | null {
  if (!e || typeof e !== 'object') return `${where}: element must be an object`;
  const el = e as SlideElement;
  if (typeof el.id !== 'string' || !el.id) return `${where}: element without id`;
  for (const k of ['x', 'y', 'w', 'h'] as const) if (!num(el[k], -COORD, COORD)) return `${where}: element ${el.id} has an invalid ${k}`;
  if (el.w < 0 || el.h < 0) return `${where}: element ${el.id} has a negative size`;
  switch (el.type) {
    case 'text': {
      if (el.role !== undefined && !['title', 'subtitle', 'body', 'caption'].includes(el.role)) return `${where}: invalid text role`;
      if (!Array.isArray(el.paragraphs) || el.paragraphs.length > MAX_PARAGRAPHS) return `${where}: invalid paragraphs`;
      let chars = 0;
      for (const p of el.paragraphs) {
        if (!p || typeof p.text !== 'string') return `${where}: invalid paragraph`;
        if (p.level !== undefined && !num(p.level, 0, 4)) return `${where}: invalid bullet level`;
        if (p.size !== undefined && !num(p.size, 4, 400)) return `${where}: invalid paragraph font size`;
        if (p.color !== undefined && !isColor(p.color)) return `${where}: invalid paragraph color`;
        if (p.font !== undefined && (typeof p.font !== 'string' || p.font.length > 64)) return `${where}: invalid paragraph font`;
        chars += p.text.length;
      }
      if (chars > MAX_TEXT) return `${where}: too much text in one element`;
      const s = el.style;
      if (s !== undefined) {
        if (!s || typeof s !== 'object') return `${where}: invalid style`;
        if (s.size !== undefined && !num(s.size, 4, 400)) return `${where}: invalid font size`;
        if (s.color !== undefined && !isColor(s.color)) return `${where}: invalid color`;
        if (s.align !== undefined && !['left', 'center', 'right'].includes(s.align)) return `${where}: invalid align`;
        if (s.valign !== undefined && !['top', 'middle', 'bottom'].includes(s.valign)) return `${where}: invalid valign`;
        if (s.font !== undefined && (typeof s.font !== 'string' || s.font.length > 64)) return `${where}: invalid font`;
        if (s.lineHeight !== undefined && !num(s.lineHeight, 0.5, 4)) return `${where}: invalid line height`;
        if (s.paraSpacing !== undefined && !num(s.paraSpacing, 0, 200)) return `${where}: invalid paragraph spacing`;
      }
      return null;
    }
    case 'image': {
      const problem = checkCellImage(el.src);
      if (problem) return `${where}: ${problem}`;
      if (el.fit !== undefined && el.fit !== 'contain' && el.fit !== 'cover') return `${where}: invalid fit`;
      return null;
    }
    case 'shape': {
      if (!SHAPE_KINDS.includes(el.shape)) return `${where}: invalid shape`;
      if (el.fill !== undefined && !isColor(el.fill)) return `${where}: invalid fill`;
      if (el.stroke !== undefined && !isColor(el.stroke)) return `${where}: invalid stroke`;
      if (el.strokeWidth !== undefined && !num(el.strokeWidth, 0, 100)) return `${where}: invalid stroke width`;
      if (el.startAngle !== undefined && !num(el.startAngle, -360, 720)) return `${where}: invalid start angle`;
      if (el.endAngle !== undefined && !num(el.endAngle, -360, 720)) return `${where}: invalid end angle`;
      if (el.text !== undefined && (typeof el.text !== 'string' || el.text.length > MAX_TEXT)) return `${where}: invalid shape text`;
      if (el.textColor !== undefined && !isColor(el.textColor)) return `${where}: invalid text color`;
      if (el.textSize !== undefined && !num(el.textSize, 4, 400)) return `${where}: invalid label font size`;
      if (el.textFont !== undefined && (typeof el.textFont !== 'string' || el.textFont.length > 64)) return `${where}: invalid label font`;
      return null;
    }
    default:
      return `${where}: unknown element type`;
  }
}

export function validateDeck(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'Deck must be an object';
  const deck = d as Deck;
  if (deck.version !== 1) return 'Unsupported deck version';
  if (!THEME_IDS.includes(deck.theme)) return 'Unknown theme';
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) return 'Deck must have at least one slide';
  if (deck.slides.length > MAX_SLIDES) return 'Too many slides';
  const ids = new Set<string>();
  for (let i = 0; i < deck.slides.length; i++) {
    const s = deck.slides[i];
    const where = `slide ${i + 1}`;
    if (!s || typeof s !== 'object') return `${where}: invalid slide`;
    if (typeof s.id !== 'string' || !s.id || ids.has(s.id)) return `${where}: invalid or duplicate slide id`;
    ids.add(s.id);
    if (s.layout !== undefined && !LAYOUT_IDS.includes(s.layout)) return `${where}: unknown layout`;
    if (s.bg !== undefined && !isColor(s.bg)) return `${where}: invalid background`;
    if (s.notes !== undefined && (typeof s.notes !== 'string' || s.notes.length > MAX_TEXT)) return `${where}: invalid notes`;
    if (!Array.isArray(s.elements) || s.elements.length > MAX_ELEMENTS) return `${where}: invalid elements`;
    const eids = new Set<string>();
    for (const e of s.elements) {
      const problem = validateElement(e, where);
      if (problem) return problem;
      if (eids.has(e.id)) return `${where}: duplicate element id ${e.id}`;
      eids.add(e.id);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
/** Convert arcs stored with the whole-ellipse box to the tight box, in place. */
export function migrateArcs(deck: Deck): Deck {
  for (const s of deck.slides) {
    s.elements = s.elements.map((e) => (e.type === 'shape' && e.shape === 'arc' && !e.tight ? tightArc(e) : e));
  }
  return deck;
}

// Compact description for the assistant

export function deckOutline(deck: Deck, current?: number) {
  return {
    theme: deck.theme,
    slide_count: deck.slides.length,
    ...(current !== undefined ? { current_slide: current + 1 } : {}),
    slides: deck.slides.map((s, i) => ({
      slide: i + 1,
      ...(s.layout ? { layout: s.layout } : {}),
      ...(s.bg ? { background: s.bg } : {}),
      elements: s.elements.map((e) => {
        if (e.type === 'shape' && e.shape === 'arc') e = tightArc(e);
        const box = { id: e.id, x: e.x, y: e.y, w: e.w, h: e.h };
        if (e.type === 'text') return { ...box, type: 'text', ...(e.role ? { role: e.role } : {}), text: fromParagraphs(e.paragraphs).join('\n'), ...(e.style ? { style: e.style } : {}) };
        if (e.type === 'image') return { ...box, type: 'image', src: e.src.length > 80 ? `${e.src.slice(0, 77)}...` : e.src };
        const label = e.text
          ? {
              text: e.text,
              ...(e.textSize !== undefined ? { size: e.textSize } : {}),
              ...(e.textFont ? { font: e.textFont } : {}),
              ...(e.textBold ? { bold: true } : {}),
              ...(e.textItalic ? { italic: true } : {}),
              ...(e.textColor ? { color: e.textColor } : {}),
            }
          : {};
        return { ...box, type: 'shape', shape: e.shape, ...(e.fill ? { fill: e.fill } : {}), ...(e.shape === 'arc' ? { start_angle: e.startAngle ?? 270, end_angle: e.endAngle ?? 0 } : {}), ...label };
      }),
      ...(s.notes ? { notes: s.notes } : {}),
    })),
  };
}
