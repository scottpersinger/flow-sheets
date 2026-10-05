// Convert an uploaded .pptx file into a deck. Keeps text boxes (with bullets, sizes, colors and alignment),
// pictures, simple shapes, slide backgrounds and speaker notes. Tables, charts, SmartArt, gradients, themed
// colors and animations are dropped and reported as warnings.
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import {
  newId,
  SLIDE_H,
  SLIDE_W,
  validateDeck,
  type Deck,
  type LayoutId,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TextElement,
  type TextRole,
  type TextStyle,
} from '../shared/deck.ts';
import { shapeFromPptx } from '../shared/shapes.ts';
import { MAX_CELL_IMAGE_BYTES } from '../shared/types.ts';
import { ImportError, IMPORT_LIMITS } from './xlsxImport.ts';

/** Stores an image for the importing user; returns its /api/images/... URL. */
export type ImageSink = (type: string, data: Buffer) => Promise<string>;

export interface PptxImportResult {
  deck: Deck;
  warnings: string[];
}

const EMU_PER_PX = 9525; // 914400 EMU per inch / 96 px per inch
const MAX_SLIDES = 500;
const MAX_SHAPES = 200;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// --- Tiny helpers over fast-xml-parser's ordered output ------------------------------------------------

type XNode = Record<string, unknown>;

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, trimValues: false });

const tagOf = (n: XNode): string => Object.keys(n).find((k) => k !== ':@') ?? '';
const kids = (n: XNode | undefined): XNode[] => (n ? ((n[tagOf(n)] as XNode[] | undefined) ?? []) : []);
const attrs = (n: XNode | undefined): Record<string, string> => ((n?.[':@'] as Record<string, string> | undefined) ?? {});
const child = (n: XNode | undefined, name: string): XNode | undefined => kids(n).find((c) => tagOf(c) === name);
const children = (n: XNode | undefined, name: string): XNode[] => kids(n).filter((c) => tagOf(c) === name);
/** Follow a path of child tag names. */
const path = (n: XNode | undefined, ...names: string[]): XNode | undefined => names.reduce<XNode | undefined>((cur, name) => child(cur, name), n);
const textOf = (n: XNode | undefined): string =>
  kids(n)
    .map((c) => ('#text' in c ? String(c['#text']) : ''))
    .join('');
const num = (v: string | undefined): number | undefined => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function parseXml(xml: string): XNode[] {
  return parser.parse(xml) as XNode[];
}

function root(doc: XNode[], name: string): XNode | undefined {
  return doc.find((n) => tagOf(n) === name);
}

/** Resolve a relationship target against the directory of the part that holds the .rels file. */
function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg) parts.push(seg);
  }
  return parts.join('/');
}

interface Rel {
  id: string;
  type: string;
  target: string;
}

// --- The importer -----------------------------------------------------------------------------------

class Importer {
  private zip: JSZip;
  private sink: ImageSink;
  private warn = new Map<string, number>();
  private imageCache = new Map<string, Promise<string | null>>();
  private xmlCache = new Map<string, Promise<XNode[] | null>>();
  private themeCache = new Map<string, Record<string, string>>();
  /** Color scheme of the master of the slide being converted. */
  private colors: Record<string, string> = {};
  // Scale and offset from the file's slide size to our 960×540 canvas.
  private scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(zip: JSZip, sink: ImageSink) {
    this.zip = zip;
    this.sink = sink;
  }

  private note(msg: string): void {
    this.warn.set(msg, (this.warn.get(msg) ?? 0) + 1);
  }

  warnings(): string[] {
    return [...this.warn.entries()].map(([msg, n]) => (n > 1 ? `${msg} (${n}×)` : msg));
  }

  private xml(file: string): Promise<XNode[] | null> {
    let p = this.xmlCache.get(file);
    if (!p) {
      p = (async () => {
        const f = this.zip.file(file);
        if (!f) return null;
        try {
          return parseXml(await f.async('string'));
        } catch {
          return null;
        }
      })();
      this.xmlCache.set(file, p);
    }
    return p;
  }

  private async rels(partFile: string): Promise<Rel[]> {
    const dir = partFile.includes('/') ? partFile.slice(0, partFile.lastIndexOf('/')) : '';
    const name = partFile.slice(dir.length + (dir ? 1 : 0));
    const doc = await this.xml(`${dir ? `${dir}/` : ''}_rels/${name}.rels`);
    if (!doc) return [];
    return children(root(doc, 'Relationships'), 'Relationship').map((r) => {
      const a = attrs(r);
      return { id: a.Id, type: a.Type, target: resolvePath(dir, a.Target) };
    });
  }

  async run(): Promise<Deck> {
    const presDoc = await this.xml('ppt/presentation.xml');
    const pres = presDoc && root(presDoc, 'p:presentation');
    if (!pres) throw new ImportError('This file is not a valid PowerPoint presentation (.pptx).');
    const size = attrs(child(pres, 'p:sldSz'));
    const w = (num(size.cx) ?? 9144000) / EMU_PER_PX;
    const h = (num(size.cy) ?? 5143500) / EMU_PER_PX;
    this.scale = Math.min(SLIDE_W / w, SLIDE_H / h);
    this.ox = (SLIDE_W - w * this.scale) / 2;
    this.oy = (SLIDE_H - h * this.scale) / 2;
    if (Math.abs(w / h - 16 / 9) > 0.05) this.note('The slides were not 16:9; they were scaled to fit and centered.');

    const presRels = await this.rels('ppt/presentation.xml');
    const ids = children(child(pres, 'p:sldIdLst'), 'p:sldId').map((s) => attrs(s)['r:id']);
    const files = ids.map((id) => presRels.find((r) => r.id === id)?.target).filter((t): t is string => !!t);
    if (!files.length) throw new ImportError('This presentation has no slides.');
    if (files.length > MAX_SLIDES) throw new ImportError(`This presentation has too many slides to import (${MAX_SLIDES} maximum).`);

    const slides: Slide[] = [];
    for (const file of files) slides.push(await this.slide(file));
    const deck: Deck = { version: 1, theme: 'light', slides };
    const problem = validateDeck(deck);
    if (problem) throw new ImportError(`The presentation could not be converted: ${problem}.`);
    return deck;
  }

  private async slide(file: string): Promise<Slide> {
    const doc = await this.xml(file);
    const sld = doc && root(doc, 'p:sld');
    const rels = await this.rels(file);
    const layoutFile = rels.find((r) => r.type.endsWith('/slideLayout'))?.target;
    const layoutDoc = layoutFile ? await this.xml(layoutFile) : null;
    const layout = layoutDoc && root(layoutDoc, 'p:sldLayout');
    const masterFile = layoutFile ? (await this.rels(layoutFile)).find((r) => r.type.endsWith('/slideMaster'))?.target : undefined;
    const masterDoc = masterFile ? await this.xml(masterFile) : null;
    const master = masterDoc && root(masterDoc, 'p:sldMaster');
    const inherit = [layout, master].filter((n): n is XNode => !!n);
    this.colors = await this.themeColors(masterFile, master ?? undefined);

    const elements: SlideElement[] = [];
    const cSld = child(sld ?? undefined, 'p:cSld');
    if (sld) await this.shapes(child(cSld, 'p:spTree'), rels, inherit, elements, null);
    if (elements.length > MAX_SHAPES) {
      this.note(`Slides with more than ${MAX_SHAPES} elements were truncated.`);
      elements.length = MAX_SHAPES;
    }

    assignRoles(elements);
    const slide: Slide = { id: newId(), layout: guessLayout(elements), elements };
    const bg = this.colorOf(path(cSld, 'p:bg', 'p:bgPr'));
    if (bg && bg !== 'none') slide.bg = bg;
    else if (path(cSld, 'p:bg') && !bg) this.note('Picture and gradient slide backgrounds were dropped.');

    const notesFile = rels.find((r) => r.type.endsWith('/notesSlide'))?.target;
    if (notesFile) {
      const notes = await this.notes(notesFile);
      if (notes) slide.notes = notes;
    }
    return slide;
  }

  private async notes(file: string): Promise<string> {
    const doc = await this.xml(file);
    const tree = path(root(doc ?? [], 'p:notes'), 'p:cSld', 'p:spTree');
    for (const sp of children(tree, 'p:sp')) {
      if (attrs(path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph')).type !== 'body') continue;
      return children(child(sp, 'p:txBody'), 'a:p')
        .map((p) => paragraphText(p))
        .join('\n')
        .trim();
    }
    return '';
  }

  /** Convert a shape tree (a slide's spTree or a group) into elements. */
  private async shapes(tree: XNode | undefined, rels: Rel[], inherit: XNode[], out: SlideElement[], group: GroupTransform | null): Promise<void> {
    for (const node of kids(tree)) {
      const tag = tagOf(node);
      if (tag === 'p:sp') {
        out.push(...(await this.shape(node, inherit, group)));
      } else if (tag === 'p:pic') {
        const el = await this.picture(node, rels, group);
        if (el) out.push(el);
      } else if (tag === 'p:cxnSp') {
        const el = this.connector(node, group);
        if (el) out.push(el);
      } else if (tag === 'p:grpSp') {
        const inner = this.groupTransform(child(node, 'p:grpSpPr'), group);
        await this.shapes(node, rels, inherit, out, inner);
      } else if (tag === 'p:graphicFrame') {
        const data = path(node, 'a:graphic', 'a:graphicData');
        const uri = attrs(data).uri ?? '';
        this.note(uri.includes('/table') ? 'Tables were dropped.' : uri.includes('/chart') ? 'Charts were dropped.' : uri.includes('/diagram') ? 'SmartArt was dropped.' : 'Embedded objects were dropped.');
      }
    }
  }

  /** Box of an xfrm in our slide units, through any group transforms. */
  private box(xfrm: XNode | undefined, group: GroupTransform | null): { x: number; y: number; w: number; h: number } | null {
    const off = attrs(child(xfrm, 'a:off'));
    const ext = attrs(child(xfrm, 'a:ext'));
    const x = num(off.x);
    const y = num(off.y);
    const cx = num(ext.cx);
    const cy = num(ext.cy);
    if (x === undefined || y === undefined || cx === undefined || cy === undefined) return null;
    let b = { x: x / EMU_PER_PX, y: y / EMU_PER_PX, w: cx / EMU_PER_PX, h: cy / EMU_PER_PX };
    for (let g = group; g; g = g.parent) b = g.apply(b);
    return {
      x: Math.round(this.ox + b.x * this.scale),
      y: Math.round(this.oy + b.y * this.scale),
      w: Math.round(b.w * this.scale),
      h: Math.round(b.h * this.scale),
    };
  }

  private groupTransform(grpSpPr: XNode | undefined, parent: GroupTransform | null): GroupTransform | null {
    const xfrm = child(grpSpPr, 'a:xfrm');
    const off = attrs(child(xfrm, 'a:off'));
    const ext = attrs(child(xfrm, 'a:ext'));
    const chOff = attrs(child(xfrm, 'a:chOff'));
    const chExt = attrs(child(xfrm, 'a:chExt'));
    const ox = num(off.x);
    const oy = num(off.y);
    const cw = num(chExt.cx);
    const ch = num(chExt.cy);
    if (ox === undefined || oy === undefined || !cw || !ch) return parent;
    const sx = (num(ext.cx) ?? cw) / cw;
    const sy = (num(ext.cy) ?? ch) / ch;
    const cox = num(chOff.x) ?? 0;
    const coy = num(chOff.y) ?? 0;
    const px = EMU_PER_PX;
    return {
      parent,
      apply: (b) => ({ x: (ox + (b.x * px - cox) * sx) / px, y: (oy + (b.y * px - coy) * sy) / px, w: b.w * sx, h: b.h * sy }),
    };
  }

  /** The placeholder's box from the layout or master when the slide's shape has no xfrm of its own. */
  private inheritedBox(ph: Record<string, string>, inherit: XNode[], group: GroupTransform | null) {
    for (const part of inherit) {
      const tree = path(part, 'p:cSld', 'p:spTree');
      const sps = children(tree, 'p:sp');
      const match = (byIdx: boolean) =>
        sps.find((sp) => {
          const a = attrs(path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph'));
          if (!path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph')) return false;
          return byIdx ? ph.idx !== undefined && a.idx === ph.idx : sameType(a.type, ph.type);
        });
      const sp = match(true) ?? match(false);
      const b = sp && this.box(path(sp, 'p:spPr', 'a:xfrm'), group);
      if (b) return b;
    }
    return null;
  }

  /** The theme's color scheme for a master (dk1, lt1, accent1, ... plus the bg1/tx1 aliases from its clrMap). */
  private async themeColors(masterFile: string | undefined, master: XNode | undefined): Promise<Record<string, string>> {
    if (!masterFile) return {};
    const cached = this.themeCache.get(masterFile);
    if (cached) return cached;
    const map: Record<string, string> = {};
    const themeFile = (await this.rels(masterFile)).find((r) => r.type.endsWith('/theme'))?.target;
    const themeDoc = themeFile ? await this.xml(themeFile) : null;
    const scheme = path(root(themeDoc ?? [], 'a:theme'), 'a:themeElements', 'a:clrScheme');
    for (const c of kids(scheme)) {
      const name = tagOf(c).replace('a:', '');
      const v = attrs(child(c, 'a:srgbClr')).val ?? attrs(child(c, 'a:sysClr')).lastClr;
      if (v && /^[0-9A-Fa-f]{6}$/.test(v)) map[name] = v.toLowerCase();
    }
    const clrMap = attrs(child(master, 'p:clrMap'));
    for (const k of ['bg1', 'tx1', 'bg2', 'tx2']) if (clrMap[k] && map[clrMap[k]]) map[k] = map[clrMap[k]];
    this.themeCache.set(masterFile, map);
    return map;
  }

  /**
   * The solid fill of a node (its a:solidFill child) as a CSS color: "#rrggbb", "rgba(...)" when it has an alpha,
   * "none" when fully transparent, or undefined when there is no solid fill. Theme colors resolve through the
   * master's color scheme.
   */
  private colorOf(parent: XNode | undefined): string | undefined {
    const fill = child(parent, 'a:solidFill');
    if (!fill) return undefined;
    const node = child(fill, 'a:srgbClr') ?? child(fill, 'a:schemeClr');
    if (!node) return undefined;
    const hex = tagOf(node) === 'a:srgbClr' ? attrs(node).val : this.colors[attrs(node).val];
    if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return undefined;
    const alpha = num(attrs(child(node, 'a:alpha')).val);
    if (alpha === undefined || alpha >= 100000) return `#${hex.toLowerCase()}`;
    if (alpha <= 0) return 'none';
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha / 1000) / 100})`;
  }

  /** colorOf without the "none" case, for text and outlines. */
  private solidColor(parent: XNode | undefined): string | undefined {
    const c = this.colorOf(parent);
    return c === 'none' ? undefined : c;
  }

  /** A shape becomes a shape element, a text element, or both (a filled shape with text keeps its text styling). */
  private async shape(sp: XNode, inherit: XNode[], group: GroupTransform | null): Promise<SlideElement[]> {
    const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph');
    const phAttrs = attrs(ph);
    const phType = ph ? (phAttrs.type ?? 'body') : undefined;
    // Dates, footers, slide numbers and empty picture placeholders are chrome, not content.
    if (phType && ['dt', 'ftr', 'sldNum', 'pic', 'media', 'clipArt', 'tbl', 'chart', 'dgm'].includes(phType)) return [];
    const spPr = child(sp, 'p:spPr');
    let box = this.box(child(spPr, 'a:xfrm'), group);
    if (!box && ph) box = this.inheritedBox(phAttrs, inherit, group);
    if (!box) return [];
    if (box.w <= 0 && box.h <= 0) return [];

    const txBody = child(sp, 'p:txBody');
    const paragraphs = children(txBody, 'a:p');
    const hasText = paragraphs.some((p) => paragraphText(p).trim() !== '');
    const role: TextRole = phType === 'title' || phType === 'ctrTitle' ? 'title' : phType === 'subTitle' ? 'subtitle' : 'body';

    const prst = attrs(child(spPr, 'a:prstGeom')).prst;
    const fillRaw = this.colorOf(spPr);
    const fillColor = fillRaw === 'none' ? undefined : fillRaw;
    const noFill = !!child(spPr, 'a:noFill') || fillRaw === 'none';
    const style = child(sp, 'p:style');
    const styledFill = !!style && attrs(child(style, 'a:fillRef')).idx !== '0' && !!attrs(child(style, 'a:fillRef')).idx;
    const ln = child(spPr, 'a:ln');
    const strokeColor = this.solidColor(ln);
    const noLine = !!child(ln, 'a:noFill');
    const styledLine = !!style && attrs(child(style, 'a:lnRef')).idx !== '0' && !!attrs(child(style, 'a:lnRef')).idx;
    const filled = !!fillColor || (!noFill && styledFill);
    const stroked = !!strokeColor || (!noLine && styledLine);
    const geometric = !!prst && prst !== 'rect';

    let onShape: ShapeElement | null = null;
    if (!ph && (filled || stroked || geometric)) {
      const el: ShapeElement = { id: newId(), type: 'shape', shape: shapeKind(prst, (m) => this.note(m)), ...box };
      if (el.shape === 'line') {
        if (box.h > box.w) el.w = 0;
        else el.h = 0;
      }
      if (fillColor) el.fill = fillColor;
      else if (!filled) el.fill = 'none';
      if (strokeColor) el.stroke = strokeColor;
      else if (stroked && !filled) el.stroke = '#5f6368';
      const w = num(attrs(ln).w);
      if (w !== undefined && (strokeColor || el.shape === 'line')) el.strokeWidth = Math.max(1, Math.round((w / EMU_PER_PX) * this.scale));
      if (!hasText) return [el];
      onShape = el; // the text goes in its own element on top, so sizes, fonts and colors survive
    }
    if (!hasText && !ph) return [];

    // Text sits inside the box's insets (PowerPoint's defaults are 0.1in left/right and 0.05in top/bottom).
    if (txBody) {
      const bp = attrs(child(txBody, 'a:bodyPr'));
      const inset = (k: string, dflt: number) => ((num(bp[k]) ?? dflt) / EMU_PER_PX) * this.scale;
      const [l, r, t, b] = [inset('lIns', 91440), inset('rIns', 91440), inset('tIns', 45720), inset('bIns', 45720)];
      box = { x: Math.round(box.x + l), y: Math.round(box.y + t), w: Math.max(1, Math.round(box.w - l - r)), h: Math.max(1, Math.round(box.h - t - b)) };
    }

    const bodyBullets = role === 'body';
    const ps: Paragraph[] = [];
    for (const p of paragraphs) {
      const pPr = child(p, 'a:pPr');
      const text = paragraphText(p);
      let bullet: boolean;
      if (child(pPr, 'a:buNone')) bullet = false;
      else if (child(pPr, 'a:buChar') || child(pPr, 'a:buAutoNum') || child(pPr, 'a:buBlip')) bullet = text.trim() !== '';
      else bullet = bodyBullets && !!ph && text.trim() !== '';
      const level = Math.min(4, num(attrs(pPr).lvl) ?? 0);
      ps.push({ text, ...(bullet ? { bullet: true } : {}), ...(bullet && level ? { level } : {}) });
    }
    // Trailing empty paragraphs are noise.
    while (ps.length > 1 && ps[ps.length - 1].text.trim() === '') ps.pop();
    if (!ps.length) ps.push({ text: '' });

    const el: TextElement = { id: newId(), type: 'text', role, ...box, paragraphs: ps };
    const st = this.textStyle(paragraphs, txBody, role) ?? {};
    if (onShape) {
      // PowerPoint centers text in shapes and draws it in the light theme color on filled ones.
      st.align ??= 'center';
      st.valign ??= 'middle';
      if (!st.color && onShape.fill !== 'none') st.color = '#ffffff';
    }
    if (Object.keys(st).length) el.style = st;
    // Paragraphs styled differently from the box (a big figure over a small caption) keep their own look.
    const base = { size: st?.size, bold: st?.bold ?? role === 'title', italic: !!st?.italic, color: st?.color, font: st?.font };
    paragraphs.forEach((p, k) => {
      const run = this.runProps(p);
      if (!run || !ps[k] || ps[k].text.trim() === '') return;
      if (run.size !== undefined && run.size !== base.size) ps[k].size = run.size;
      if (run.bold !== undefined && run.bold !== base.bold) ps[k].bold = run.bold;
      if (run.italic !== undefined && run.italic !== base.italic) ps[k].italic = run.italic;
      if (run.color && run.color !== base.color) ps[k].color = run.color;
      if (run.font && run.font !== base.font) ps[k].font = run.font;
    });
    return onShape ? [onShape, el] : [el];
  }

  /** Size, weight, slant, color and font of a paragraph's first run. */
  private runProps(p: XNode): { size?: number; bold?: boolean; italic?: boolean; color?: string; font?: string } | null {
    const run = children(p, 'a:r')[0] ?? children(p, 'a:fld')[0];
    if (!run) return null;
    const rPrNode = child(run, 'a:rPr');
    const rPr = attrs(rPrNode);
    const sz = num(rPr.sz);
    const face = fontOf(attrs(child(rPrNode, 'a:latin')).typeface);
    return {
      ...(sz ? { size: Math.round((((sz / 100) * 4) / 3) * this.scale) } : {}),
      ...(rPr.b !== undefined || face.bold ? { bold: rPr.b === '1' || face.bold } : {}),
      ...(rPr.i !== undefined ? { italic: rPr.i === '1' } : {}),
      ...(this.solidColor(rPrNode) ? { color: this.solidColor(rPrNode) } : {}),
      ...(face.name ? { font: face.name } : {}),
    };
  }

  /** The style of the first run (sizes and colors are per run in PowerPoint; we keep one per text box). */
  private textStyle(paragraphs: XNode[], txBody: XNode | undefined, role: TextRole): TextStyle | undefined {
    const st: TextStyle = {};
    const first = paragraphs.find((p) => paragraphText(p).trim() !== '') ?? paragraphs[0];
    const run = children(first, 'a:r')[0] ?? children(first, 'a:fld')[0];
    const rPrNode = child(run, 'a:rPr');
    const rPr = attrs(rPrNode);
    const sz = num(rPr.sz);
    if (sz) st.size = Math.round((((sz / 100) * 4) / 3) * this.scale);
    // Font families such as "Poppins Black" carry their weight in the name.
    const face = fontOf(attrs(child(rPrNode, 'a:latin')).typeface);
    if (face.name) st.font = face.name;
    if ((rPr.b === '1' || face.bold) && role !== 'title') st.bold = true;
    if (rPr.b === '0' && !face.bold && role === 'title') st.bold = false;
    if (rPr.i === '1') st.italic = true;
    const color = this.runColor(paragraphs);
    if (color) st.color = color;
    const pPr = child(first, 'a:pPr');
    const algn = attrs(pPr).algn;
    if (algn === 'ctr') st.align = 'center';
    else if (algn === 'r') st.align = 'right';
    // Line spacing: PowerPoint's 100% is about 1.2 × the font size.
    const pct = num(attrs(path(pPr, 'a:lnSpc', 'a:spcPct')).val);
    if (pct) {
      const lh = Math.round((pct / 100000) * 1.2 * 100) / 100;
      if (Math.abs(lh - 1.25) > 0.03) st.lineHeight = Math.min(4, Math.max(0.5, lh));
    }
    const before = num(attrs(path(pPr, 'a:spcBef', 'a:spcPts')).val);
    const after = num(attrs(path(pPr, 'a:spcAft', 'a:spcPts')).val);
    if (paragraphs.length > 1 && (before !== undefined || after !== undefined)) {
      st.paraSpacing = Math.min(200, Math.round((((before ?? 0) + (after ?? 0)) / 100) * (4 / 3) * this.scale * 10) / 10);
    }
    const anchor = attrs(child(txBody, 'a:bodyPr')).anchor;
    if (anchor === 'ctr') st.valign = 'middle';
    else if (anchor === 'b') st.valign = 'bottom';
    return Object.keys(st).length ? st : undefined;
  }

  private runColor(paragraphs: XNode[]): string | undefined {
    for (const p of paragraphs) {
      for (const r of children(p, 'a:r')) {
        const c = this.solidColor(child(r, 'a:rPr'));
        if (c) return c;
      }
    }
    return undefined;
  }

  private connector(cxn: XNode, group: GroupTransform | null): SlideElement | null {
    const spPr = child(cxn, 'p:spPr');
    const box = this.box(child(spPr, 'a:xfrm'), group);
    if (!box) return null;
    const ln = child(spPr, 'a:ln');
    const vertical = box.h > box.w;
    const el: ShapeElement = { id: newId(), type: 'shape', shape: 'line', ...box, ...(vertical ? { w: 0 } : { h: 0 }) };
    const color = this.solidColor(ln);
    if (color) el.stroke = color;
    const w = num(attrs(ln).w);
    if (w !== undefined) el.strokeWidth = Math.max(1, Math.round((w / EMU_PER_PX) * this.scale));
    if (box.h > 2 && box.w > 2) this.note('Diagonal lines were drawn straight.');
    return el;
  }

  private async picture(pic: XNode, rels: Rel[], group: GroupTransform | null): Promise<SlideElement | null> {
    const box = this.box(path(pic, 'p:spPr', 'a:xfrm'), group);
    if (!box) return null;
    const embed = attrs(path(pic, 'p:blipFill', 'a:blip'))['r:embed'];
    const target = rels.find((r) => r.id === embed)?.target;
    if (!target) {
      this.note('Linked pictures (not stored in the file) were dropped.');
      return null;
    }
    const src = await this.image(target);
    if (!src) return null;
    return { id: newId(), type: 'image', ...box, src };
  }

  private image(file: string): Promise<string | null> {
    let p = this.imageCache.get(file);
    if (!p) {
      p = (async () => {
        const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
        const type = IMAGE_TYPES[ext];
        if (!type) {
          this.note(`Pictures in ${ext.toUpperCase()} format were dropped (PNG, JPEG, GIF and WebP are supported).`);
          return null;
        }
        const f = this.zip.file(file);
        if (!f) {
          this.note('Some pictures were missing from the file.');
          return null;
        }
        const data = await f.async('nodebuffer');
        if (data.length > MAX_CELL_IMAGE_BYTES) {
          this.note('Pictures over 100 MB were dropped.');
          return null;
        }
        return this.sink(type, data);
      })();
      this.imageCache.set(file, p);
    }
    return p;
  }
}

interface GroupTransform {
  parent: GroupTransform | null;
  apply(b: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number };
}

const FONT_WEIGHT = /\s+(Black|Extra ?Bold|Heavy|Bold|Semi ?Bold|Medium|Regular|Light|Extra ?Light|Thin)$/i;

/** Split "Poppins Black" into the family and whether that weight counts as bold. */
function fontOf(typeface: string | undefined): { name?: string; bold: boolean } {
  if (!typeface) return { bold: false };
  const m = FONT_WEIGHT.exec(typeface);
  const name = (m ? typeface.slice(0, m.index) : typeface).trim();
  const weight = m?.[1].toLowerCase().replace(/\s/g, '');
  return { ...(name ? { name } : {}), bold: !!weight && ['black', 'extrabold', 'heavy', 'bold', 'semibold'].includes(weight) };
}

function sameType(a: string | undefined, b: string | undefined): boolean {
  const norm = (t: string | undefined) => (t === 'ctrTitle' ? 'title' : t === 'obj' || t === undefined ? 'body' : t);
  return norm(a) === norm(b);
}

/** The text of one paragraph: runs and fields, with line breaks as newlines. */
function paragraphText(p: XNode): string {
  let out = '';
  for (const c of kids(p)) {
    const t = tagOf(c);
    if (t === 'a:r' || t === 'a:fld') out += textOf(child(c, 'a:t'));
    else if (t === 'a:br') out += '\n';
  }
  return out;
}

function shapeKind(prst: string | undefined, note: (m: string) => void): ShapeElement['shape'] {
  const kind = shapeFromPptx(prst);
  if (kind) return kind;
  note(`Shapes of type "${prst}" were drawn as rectangles.`);
  return 'rect';
}

/**
 * Decks made without placeholders (including our own exports) have only plain text boxes. Treat the largest
 * big text as the title, and a single short line under it as the subtitle, so themes and update_slide apply.
 */
function assignRoles(elements: SlideElement[]): void {
  const texts = elements.filter((e): e is TextElement => e.type === 'text');
  if (texts.some((t) => t.role === 'title')) return;
  // The topmost big text is the title (a big figure further down a slide is not).
  const sized = texts.filter((t) => (t.style?.size ?? 0) >= 28).sort((a, b) => a.y - b.y || (b.style?.size ?? 0) - (a.style?.size ?? 0));
  const title = sized[0];
  if (!title) return;
  title.role = 'title';
  const rest = texts.filter((t) => t !== title);
  const single = rest.filter((t) => {
    const size = t.style?.size ?? 18;
    return t.paragraphs.length === 1 && !t.paragraphs[0].bullet && size >= 16 && size <= 26;
  });
  if (rest.length === 1 && single.length === 1) single[0].role = 'subtitle';
}

/** A layout for the UI's layout picker, from what the slide holds. */
function guessLayout(elements: SlideElement[]): LayoutId {
  const texts = elements.filter((e): e is TextElement => e.type === 'text');
  const title = texts.some((t) => t.role === 'title');
  const subtitle = texts.some((t) => t.role === 'subtitle');
  const bodies = texts.filter((t) => (t.role ?? 'body') === 'body').length;
  const image = elements.some((e) => e.type === 'image');
  if (!elements.length) return 'blank';
  if (title && subtitle && !bodies) return 'title';
  if (title && bodies >= 2) return 'two-column';
  if (title && image && !bodies) return 'image';
  if (title && bodies === 1) return 'title-body';
  if (title && !bodies && !image) return 'section';
  return 'blank';
}

/** Reject anything that is not a reasonably sized .pptx archive. */
async function openArchive(buf: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ImportError('This file is not a valid PowerPoint presentation (.pptx).');
  }
  const entries = Object.values(zip.files);
  if (entries.length > IMPORT_LIMITS.maxZipEntries) throw new ImportError('This presentation contains too many parts to import.');
  let total = 0;
  for (const f of entries) total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (total > IMPORT_LIMITS.maxUncompressedBytes) throw new ImportError('This presentation is too large to import.');
  if (!zip.file('ppt/presentation.xml')) throw new ImportError('This file is not a valid PowerPoint presentation (.pptx).');
  return zip;
}

/** True if the bytes look like a .pptx (a zip holding ppt/presentation.xml). */
export async function isPptx(buf: Buffer): Promise<boolean> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  try {
    const zip = await JSZip.loadAsync(buf);
    return !!zip.file('ppt/presentation.xml');
  } catch {
    return false;
  }
}

export async function importPptx(buf: Buffer, storeImage: ImageSink): Promise<PptxImportResult> {
  const zip = await openArchive(buf);
  const imp = new Importer(zip, storeImage);
  const deck = await imp.run();
  return { deck, warnings: imp.warnings() };
}
