// Export a deck as a PowerPoint file with pptxgenjs. Our slide is 960×540 points at 96 per inch, which is
// exactly PowerPoint's 16:9 layout (10 × 5.625 inches), so positions map 1:1. Runs in the browser (File →
// Download as PowerPoint) and in Node (tests); the caller loads images, since that differs between the two.
import type PptxGenJS from 'pptxgenjs';
import { ROLE_SIZE, THEMES, type Deck, type SlideElement, type TextElement } from './deck.ts';
import { SHAPES } from './shapes.ts';

/** Returns a data URL for an image address, or null if it cannot be loaded. */
export type ImageLoader = (src: string) => Promise<string | null>;

const PX_PER_INCH = 96;
const inch = (px: number) => Math.round((px / PX_PER_INCH) * 10000) / 10000;
/** Font sizes are in CSS pixels on the slide; PowerPoint wants points. */
const pt = (px: number) => Math.round(px * 0.75 * 10) / 10;

/** A 6-digit hex color without '#' (from #rgb, #rrggbb, rgb() or rgba()), or undefined for anything else. */
export function hexColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (m) {
    const h = m[1];
    return (h.length === 3 ? h.split('').map((x) => x + x).join('') : h).toUpperCase();
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c.trim());
  if (!rgb) return undefined;
  return rgb
    .slice(1, 4)
    .map((v) => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** Transparency in percent for an rgba() color (0 for opaque colors). */
export function transparencyOf(c: string | undefined): number {
  const m = c && /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)$/i.exec(c.trim());
  if (!m) return 0;
  return Math.round((1 - Math.max(0, Math.min(1, Number(m[1])))) * 100);
}

/** A font PowerPoint is likely to have, from a CSS font stack. */
export function fontFace(stack: string): string {
  const first = stack.split(',')[0].replace(/['"]/g, '').trim();
  if (/georgia|times|serif/i.test(first)) return 'Georgia';
  if (/mono|courier/i.test(first)) return 'Courier New';
  return 'Arial';
}

function textOptions(el: TextElement, theme: (typeof THEMES)[keyof typeof THEMES]): PptxGenJS.TextPropsOptions {
  const role = el.role ?? 'body';
  const s = el.style ?? {};
  const heading = role === 'title' || role === 'subtitle';
  const color = hexColor(s.color) ?? hexColor(role === 'title' ? theme.heading : role === 'caption' || role === 'subtitle' ? theme.muted : theme.text);
  const size = s.size ?? ROLE_SIZE[role];
  return {
    x: inch(el.x),
    y: inch(el.y),
    w: inch(el.w),
    h: inch(el.h),
    fontSize: pt(size),
    fontFace: s.font ?? fontFace(heading ? theme.headingFont : theme.bodyFont),
    bold: s.bold ?? role === 'title',
    italic: !!s.italic,
    ...(color ? { color } : {}),
    align: s.align ?? 'left',
    valign: s.valign ?? 'top',
    margin: 0,
    paraSpaceAfter: pt(s.paraSpacing ?? size * 0.3),
    // PowerPoint's single spacing is about 1.2 × the font size; ours defaults to 1.25.
    lineSpacingMultiple: Math.round(((s.lineHeight ?? 1.25) / 1.2) * 100) / 100,
    fit: 'none',
  };
}

/** Build the presentation. Returns the pptxgenjs instance (write it with writeFile or write) and warnings. */
export async function buildPptx(deck: Deck, title: string, loadImage: ImageLoader): Promise<{ pres: PptxGenJS; warnings: string[] }> {
  const { default: PptxGen } = await import('pptxgenjs');
  const pres = new PptxGen();
  pres.layout = 'LAYOUT_16x9';
  pres.title = title;
  const theme = THEMES[deck.theme];
  const warnings: string[] = [];
  let missingImages = 0;

  for (const slide of deck.slides) {
    const s = pres.addSlide();
    const bg = hexColor(slide.bg) ?? hexColor(theme.bg);
    if (bg) s.background = { color: bg };
    for (const el of slide.elements) await addElement(s, el);
    if (slide.notes) s.addNotes(slide.notes);
  }
  if (missingImages) warnings.push(`${missingImages} image${missingImages === 1 ? '' : 's'} could not be loaded and ${missingImages === 1 ? 'was' : 'were'} left as a placeholder.`);
  return { pres, warnings };

  async function addElement(s: PptxGenJS.Slide, el: SlideElement): Promise<void> {
    const box = { x: inch(el.x), y: inch(el.y), w: inch(el.w), h: inch(el.h) };
    if (el.type === 'text') {
      const runs: PptxGenJS.TextProps[] = el.paragraphs.map((p) => ({
        text: p.text,
        options: {
          breakLine: true,
          ...(p.bullet ? { bullet: { indent: 18 }, indentLevel: p.level ?? 0 } : {}),
          ...(p.size !== undefined ? { fontSize: pt(p.size) } : {}),
          ...(p.bold !== undefined ? { bold: p.bold } : {}),
          ...(p.italic !== undefined ? { italic: p.italic } : {}),
          ...(hexColor(p.color) ? { color: hexColor(p.color) } : {}),
          ...(p.font ? { fontFace: p.font } : {}),
        },
      }));
      s.addText(runs.length ? runs : [{ text: '' }], textOptions(el, theme));
      return;
    }
    if (el.type === 'image') {
      const data = await loadImage(el.src);
      if (data) {
        s.addImage({ data, ...box, sizing: { type: el.fit === 'cover' ? 'cover' : 'contain', w: box.w, h: box.h } });
      } else {
        missingImages++;
        s.addText('Image unavailable', { ...box, shape: pres.ShapeType.rect, line: { color: '9AA0A6', width: 1 }, fill: { type: 'none' }, align: 'center', valign: 'middle', fontSize: 12, color: '9AA0A6' });
      }
      return;
    }
    // Shapes
    const accent = hexColor(theme.accent) ?? '1A73E8';
    const strokeColor = hexColor(el.stroke);
    if (el.shape === 'line') {
      const diagonal = el.w > 0 && el.h > 0;
      const vertical = el.h > el.w;
      const lineColor = el.stroke ?? el.fill;
      s.addShape(pres.ShapeType.line, {
        ...box,
        ...(diagonal ? {} : vertical ? { w: 0 } : { h: 0 }),
        ...(diagonal && el.flip ? { flipV: true } : {}),
        line: {
          color: hexColor(lineColor) ?? accent,
          width: pt(el.strokeWidth ?? 3),
          transparency: transparencyOf(lineColor),
          ...(el.arrow === 'start' || el.arrow === 'both' ? { beginArrowType: 'triangle' } : {}),
          ...(el.arrow === 'end' || el.arrow === 'both' ? { endArrowType: 'triangle' } : {}),
        },
      });
      return;
    }
    const fill: PptxGenJS.ShapeFillProps = el.fill === 'none' ? { type: 'none' } : { color: hexColor(el.fill) ?? accent, transparency: transparencyOf(el.fill) };
    const sw = el.strokeWidth ?? (strokeColor ? 2 : 0);
    const line: PptxGenJS.ShapeLineProps = strokeColor && sw ? { color: strokeColor, width: pt(sw), transparency: transparencyOf(el.stroke) } : { type: 'none' };
    const shapeType = (pres.ShapeType as unknown as Record<string, PptxGenJS.SHAPE_NAME>)[SHAPES[el.shape].pptx] ?? pres.ShapeType.rect;
    const common = {
      ...box,
      fill,
      line,
      ...(el.shape === 'rounded' ? { rectRadius: inch(16) } : {}),
      ...(el.shape === 'arc' ? { angleRange: [el.startAngle ?? 270, el.endAngle ?? 0] as [number, number] } : {}),
    };
    if (el.text) {
      const color = hexColor(el.textColor) ?? (el.fill === 'none' ? hexColor(theme.text) : 'FFFFFF');
      s.addText(el.text, { ...common, shape: shapeType, align: 'center', valign: 'middle', fontSize: pt(el.textSize ?? 18), fontFace: el.textFont ?? fontFace(theme.bodyFont), ...(el.textBold ? { bold: true } : {}), ...(el.textItalic ? { italic: true } : {}), ...(color ? { color } : {}) });
    } else {
      s.addShape(shapeType, common);
    }
  }
}
