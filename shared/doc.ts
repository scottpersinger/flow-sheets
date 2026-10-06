// Text document file format (stored as one JSON file per document on the server, next to spreadsheets and
// slide decks).
//
// A document is a ProseMirror document: a sequence of blocks (paragraphs, headings, lists, quotes, code
// blocks, images and rules) whose text carries marks (bold, italic, underline, strikethrough, code, links,
// colors). The schema below is the single definition of what a document may contain; the editor, the
// server's validation and the assistant's Markdown view all use it. `Doc.content` is the ProseMirror JSON of
// the top-level node, so a stored document can be rebuilt with `docSchema.nodeFromJSON`.
import { Node as PMNode, Schema, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { safeLinkUrl } from './links.ts';
import { checkCellImage } from './types.ts';

export interface Doc {
  version: 1;
  /** ProseMirror JSON of the document node (`{ type: 'doc', content: [...] }`). */
  content: DocJSON;
}

export interface DocJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJSON[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export const HEADING_LEVELS = [1, 2, 3] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

/** Block kinds the assistant and the toolbar can turn a block into. */
export const BLOCK_TYPES = ['paragraph', 'title', 'subtitle', 'heading1', 'heading2', 'heading3', 'bullet_list', 'ordered_list', 'blockquote', 'code_block'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const MAX_BLOCKS = 5000;
export const MAX_DOC_CHARS = 2_000_000;
/** Widest an image can be, in CSS pixels, matching the page width in the editor. */
export const DOC_PAGE_WIDTH = 760;
/** Font sizes offered by the toolbar, in points (the body text is 12pt). */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72] as const;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 200;
/** Font families offered by the toolbar: system fonts first, then ones loaded from Google Fonts. */
export const FONT_FAMILIES = [
  'Arial',
  'Helvetica',
  'Verdana',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Garamond',
  'Courier New',
  'Inter',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Nunito',
  'Poppins',
  'Merriweather',
  'Playfair Display',
  'Lora',
  'Libre Baskerville',
  'Source Sans 3',
] as const;

const alignAttr = (node: PMNode): Record<string, string> => (node.attrs.align && node.attrs.align !== 'left' ? { style: `text-align: ${node.attrs.align}` } : {});
const alignFromDOM = (dom: HTMLElement | string): Record<string, unknown> | false => {
  if (typeof dom === 'string') return false;
  const a = dom.style?.textAlign;
  return { align: a && (ALIGNMENTS as readonly string[]).includes(a) && a !== 'left' ? a : null };
};

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    content: 'inline*',
    group: 'block',
    attrs: { align: { default: null } },
    parseDOM: [{ tag: 'p', getAttrs: alignFromDOM }],
    toDOM: (node) => ['p', alignAttr(node), 0] as DOMOutputSpec,
  },
  heading: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: { level: { default: 1 }, align: { default: null } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((n) => ({ tag: `h${n}`, getAttrs: (dom: HTMLElement | string) => ({ level: Math.min(n, 3), ...(alignFromDOM(dom) || {}) }) })),
    toDOM: (node) => [`h${node.attrs.level}`, alignAttr(node), 0] as DOMOutputSpec,
  },
  // The first block node is what Enter creates at the end of a block, so paragraph stays first above; the
  // title and subtitle parse rules get a higher priority than heading's so their h1/h2 rules are tried first.
  title: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: { align: { default: null } },
    parseDOM: [{ tag: 'h1.doc-title', getAttrs: alignFromDOM, priority: 60 }, { tag: 'p.doc-title', getAttrs: alignFromDOM, priority: 60 }],
    toDOM: (node) => ['h1', { class: 'doc-title', ...alignAttr(node) }, 0] as DOMOutputSpec,
  },
  subtitle: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: { align: { default: null } },
    parseDOM: [{ tag: 'p.doc-subtitle', getAttrs: alignFromDOM, priority: 60 }, { tag: 'h2.doc-subtitle', getAttrs: alignFromDOM, priority: 60 }],
    toDOM: (node) => ['p', { class: 'doc-subtitle', ...alignAttr(node) }, 0] as DOMOutputSpec,
  },
  blockquote: { content: 'block+', group: 'block', defining: true, parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
  code_block: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM: () => ['pre', ['code', 0]],
  },
  horizontal_rule: { group: 'block', parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
  image: {
    group: 'block',
    draggable: true,
    selectable: true,
    attrs: { src: {}, alt: { default: '' }, width: { default: null }, align: { default: null } },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          if (typeof dom === 'string') return false;
          const src = dom.getAttribute('src') ?? '';
          if (checkCellImage(src)) return false;
          const w = Number.parseInt(dom.getAttribute('width') ?? dom.style?.width ?? '', 10);
          return { src, alt: dom.getAttribute('alt') ?? '', width: Number.isFinite(w) && w > 0 ? w : null, align: null };
        },
      },
    ],
    toDOM: (node) => [
      'figure',
      { class: 'doc-image', ...(node.attrs.align ? { 'data-align': node.attrs.align } : {}) },
      ['img', { src: node.attrs.src, alt: node.attrs.alt || null, ...(node.attrs.width ? { style: `width: ${node.attrs.width}px` } : {}) }],
    ],
  },
  bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
  ordered_list: {
    content: 'list_item+',
    group: 'block',
    attrs: { start: { default: 1 } },
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => (typeof dom === 'string' ? false : { start: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) || 1 : 1 }) }],
    toDOM: (node) => ['ol', node.attrs.start === 1 ? {} : { start: node.attrs.start }, 0] as DOMOutputSpec,
  },
  list_item: { content: 'paragraph block*', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
  text: { group: 'inline' },
  hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
};

const marks: Record<string, MarkSpec> = {
  // First in this list is outermost in the DOM.
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => (typeof dom === 'string' ? false : safeLinkUrl(dom.getAttribute('href') ?? '') ? { href: dom.getAttribute('href') } : false) }],
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.href, rel: 'noopener noreferrer' }, 0],
  },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  bold: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (dom) => (typeof dom === 'string' ? false : dom.style.fontWeight !== 'normal' && null) },
      { style: 'font-weight', getAttrs: (v) => (typeof v === 'string' && /^(bold(er)?|[5-9]\d{2})$/.test(v) ? null : false) },
    ],
    toDOM: () => ['strong', 0],
  },
  italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }], toDOM: () => ['em', 0] },
  underline: { parseDOM: [{ tag: 'u' }, { style: 'text-decoration', getAttrs: (v) => (typeof v === 'string' && v.includes('underline') ? null : false) }], toDOM: () => ['u', 0] },
  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration', getAttrs: (v) => (typeof v === 'string' && v.includes('line-through') ? null : false) }],
    toDOM: () => ['s', 0],
  },
  color: {
    attrs: { color: {} },
    parseDOM: [{ style: 'color', getAttrs: (v) => (typeof v === 'string' && isColor(v) ? { color: v } : false) }],
    toDOM: (mark) => ['span', { style: `color: ${mark.attrs.color}` }, 0],
  },
  font: {
    attrs: { family: {} },
    parseDOM: [{ style: 'font-family', getAttrs: (v) => (typeof v === 'string' && cleanFontFamily(v) ? { family: cleanFontFamily(v) } : false) }],
    toDOM: (mark) => ['span', { style: `font-family: ${fontFamilyCss(String(mark.attrs.family))}` }, 0],
  },
  size: {
    attrs: { size: {} },
    parseDOM: [{ style: 'font-size', getAttrs: (v) => (typeof v === 'string' && parseFontSize(v) ? { size: parseFontSize(v) } : false) }],
    toDOM: (mark) => ['span', { style: `font-size: ${Number(mark.attrs.size)}pt` }, 0],
  },
  highlight: {
    attrs: { color: {} },
    parseDOM: [{ tag: 'mark', getAttrs: () => ({ color: '#fff2a8' }) }, { style: 'background-color', getAttrs: (v) => (typeof v === 'string' && isColor(v) && !/transparent|rgba\(0, 0, 0, 0\)/.test(v) ? { color: v } : false) }],
    toDOM: (mark) => ['span', { style: `background-color: ${mark.attrs.color}` }, 0],
  },
};

export const docSchema = new Schema({ nodes, marks });

export const MARK_NAMES = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'color', 'highlight', 'font', 'size'] as const;

/** The first family of a CSS font-family list, without quotes, or null if it is not a plain font name. */
export function cleanFontFamily(v: string): string | null {
  const first = v.split(',')[0].trim().replace(/^['"]|['"]$/g, '').trim();
  return first && first.length <= 60 && /^[\w .+-]+$/.test(first) ? first : null;
}

/** CSS for a font family: quoted when it has spaces, with a generic fallback. */
export function fontFamilyCss(family: string): string {
  const generic = /courier|mono|consolas|menlo/i.test(family) ? 'monospace' : /georgia|times|garamond|serif|baskerville|playfair|merriweather|lora/i.test(family) ? 'serif' : 'sans-serif';
  return `${/[^\w-]/.test(family) ? `'${family}'` : family}, ${generic}`;
}

/** A font size in points from a CSS value ("14pt", "18px", "1.5em" relative to 12pt), or null. */
export function parseFontSize(v: string): number | null {
  const m = /^\s*([\d.]+)\s*(pt|px|em|rem)?\s*$/i.exec(v);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = (m[2] ?? 'pt').toLowerCase();
  const pt = unit === 'px' ? num * 0.75 : unit === 'em' || unit === 'rem' ? num * 12 : num;
  const rounded = Math.round(pt * 2) / 2;
  return Number.isFinite(rounded) && rounded >= MIN_FONT_SIZE && rounded <= MAX_FONT_SIZE ? rounded : null;
}
export type MarkName = (typeof MARK_NAMES)[number];

/** A CSS color the document may store: hex, rgb()/rgba(), hsl() or a plain color name. */
export function isColor(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 40 && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\)|[a-z]+)$/i.test(s.trim());
}

export function newDoc(): Doc {
  return { version: 1, content: { type: 'doc', content: [{ type: 'paragraph' }] } };
}

/** The ProseMirror node of a stored document. Throws for malformed content (use validateDoc first). */
export function docNode(doc: Doc): PMNode {
  return docSchema.nodeFromJSON(doc.content);
}

export function docFromNode(node: PMNode): Doc {
  return { version: 1, content: node.toJSON() as DocJSON };
}

/** Structural validation of an uploaded document: the schema, the size limits, and image and link addresses. */
export function validateDoc(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'Document must be an object';
  const doc = d as Doc;
  if (doc.version !== 1) return 'Unsupported document version';
  if (!doc.content || typeof doc.content !== 'object' || doc.content.type !== 'doc') return 'Invalid document content';
  let node: PMNode;
  try {
    node = docSchema.nodeFromJSON(doc.content);
    node.check();
  } catch (e) {
    return `Invalid document: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (node.childCount > MAX_BLOCKS) return 'Too many blocks';
  if (node.content.size > MAX_DOC_CHARS) return 'Document is too large';
  let problem: string | null = null;
  node.descendants((n) => {
    if (problem) return false;
    if (n.type.name === 'image') {
      const p = checkCellImage(n.attrs.src);
      if (p) problem = `Invalid image: ${p}`;
      if (n.attrs.width !== null && (typeof n.attrs.width !== 'number' || n.attrs.width < 1 || n.attrs.width > 10000)) problem = 'Invalid image width';
    }
    if ((n.attrs.align ?? null) !== null && !ALIGNMENTS.includes(n.attrs.align)) problem = 'Invalid alignment';
    if (n.type.name === 'heading' && !HEADING_LEVELS.includes(n.attrs.level)) problem = 'Invalid heading level';
    for (const m of n.marks) {
      if (m.type.name === 'link' && !safeLinkUrl(String(m.attrs.href))) problem = 'Invalid link';
      if ((m.type.name === 'color' || m.type.name === 'highlight') && !isColor(m.attrs.color)) problem = 'Invalid color';
      if (m.type.name === 'font' && (typeof m.attrs.family !== 'string' || !cleanFontFamily(m.attrs.family))) problem = 'Invalid font';
      if (m.type.name === 'size' && (typeof m.attrs.size !== 'number' || m.attrs.size < MIN_FONT_SIZE || m.attrs.size > MAX_FONT_SIZE)) problem = 'Invalid font size';
    }
    return true;
  });
  return problem;
}

/** The plain text of a document, one line per block, for searching and previews. */
export function docText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', (leaf) => (leaf.type.name === 'image' ? `[image${leaf.attrs.alt ? `: ${leaf.attrs.alt}` : ''}]` : leaf.type.name === 'hard_break' ? '\n' : ''));
}

/** The kind of a top-level block as the assistant sees it. */
export function blockType(node: PMNode): BlockType | 'image' | 'horizontal_rule' {
  switch (node.type.name) {
    case 'heading':
      return `heading${node.attrs.level as HeadingLevel}`;
    case 'title':
    case 'subtitle':
    case 'image':
    case 'horizontal_rule':
    case 'bullet_list':
    case 'ordered_list':
    case 'blockquote':
    case 'code_block':
      return node.type.name;
    default:
      return 'paragraph';
  }
}
