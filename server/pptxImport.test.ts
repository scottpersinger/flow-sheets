import { describe, expect, it } from 'vitest';
import { buildSlide, newId, slideTitle, type Deck, type ImageElement, type ShapeElement, type TextElement } from '../shared/deck.ts';
import { buildPptx, fontFace, hexColor } from '../shared/pptxExport.ts';
import { importPptx, isPptx } from './pptxImport.ts';

// A 1×1 red PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

async function pptxBuffer(deck: Deck): Promise<{ buf: Buffer; warnings: string[] }> {
  const { pres, warnings } = await buildPptx(deck, 'Round trip', async (src) => (src.startsWith('data:') ? src : null));
  const out = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
  return { buf: Buffer.from(out), warnings };
}

describe('pptx export and import', () => {
  it('converts colors and fonts for PowerPoint', () => {
    expect(hexColor('#1a73e8')).toBe('1A73E8');
    expect(hexColor('#abc')).toBe('AABBCC');
    expect(hexColor('red')).toBeUndefined();
    expect(fontFace("Georgia, 'Times New Roman', serif")).toBe('Georgia');
    expect(fontFace("'Google Sans', Roboto, sans-serif")).toBe('Arial');
  });

  it('round-trips text, bullets, shapes, pictures, backgrounds and notes', async () => {
    const title = buildSlide('title', { title: 'Quarterly review', subtitle: 'October 2026', notes: 'Welcome everyone' }, newId);
    const body = buildSlide('title-body', { title: 'Highlights', body: ['Revenue up 12%', '  Mostly in EMEA', 'Churn down'], background: '#123456' }, newId);
    body.elements.push(
      { id: newId(), type: 'shape', shape: 'ellipse', x: 700, y: 380, w: 120, h: 120, fill: '#00aa00', text: 'Go' },
      { id: newId(), type: 'shape', shape: 'line', x: 60, y: 500, w: 400, h: 0, stroke: '#ff0000', strokeWidth: 4 },
      { id: newId(), type: 'shape', shape: 'star', x: 500, y: 400, w: 100, h: 100, fill: '#ffcc00' },
      { id: newId(), type: 'shape', shape: 'rounded', x: 60, y: 420, w: 200, h: 40, fill: 'rgba(255, 255, 255, 0.12)', stroke: 'rgba(255, 255, 255, 0.3)', strokeWidth: 1 },
      { id: newId(), type: 'shape', shape: 'line', x: 480, y: 160, w: 0, h: 200, stroke: '#00ff00', strokeWidth: 2 },
      {
        id: newId(),
        type: 'text',
        x: 620,
        y: 400,
        w: 200,
        h: 100,
        paragraphs: [
          { text: '2-3x', size: 47, bold: false },
          { text: 'Average program cost reduction', bold: true },
        ],
        style: { size: 17, align: 'center', color: '#ffffff', font: 'Poppins', lineHeight: 1.5 },
      },
      { id: newId(), type: 'shape', shape: 'arrow', x: 300, y: 420, w: 160, h: 60, fill: 'none', stroke: '#0000ff', strokeWidth: 2 },
      { id: newId(), type: 'image', x: 600, y: 160, w: 200, h: 150, src: PNG },
    );
    const deck: Deck = { version: 1, theme: 'light', slides: [title, body] };

    const { buf, warnings: exportWarnings } = await pptxBuffer(deck);
    expect(exportWarnings).toEqual([]);
    expect(await isPptx(buf)).toBe(true);
    expect(await isPptx(Buffer.from('not a zip'))).toBe(false);

    const stored: { type: string; size: number }[] = [];
    const { deck: imported, warnings } = await importPptx(buf, async (type, data) => {
      stored.push({ type, size: data.length });
      return `/api/images/00000000-0000-0000-0000-00000000000${stored.length}`;
    });
    expect(warnings).toEqual([]);
    expect(imported.slides).toHaveLength(2);

    const s1 = imported.slides[0];
    expect(slideTitle(s1)).toBe('Quarterly review');
    expect(s1.notes).toBe('Welcome everyone');
    expect(s1.layout).toBe('title');
    const t1 = s1.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'title')!;
    // Positions survive within a point or two (EMU rounding).
    expect(Math.abs(t1.x - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(t1.w - 840)).toBeLessThanOrEqual(2);
    expect(t1.style).toMatchObject({ align: 'center', valign: 'bottom', size: 40 });
    const sub = s1.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'subtitle')!;
    expect(sub.paragraphs[0].text).toBe('October 2026');

    const s2 = imported.slides[1];
    expect(s2.bg).toBe('#123456');
    const bodyEl = s2.elements.find((e): e is TextElement => e.type === 'text' && e.role === 'body')!;
    expect(bodyEl.paragraphs).toEqual([
      { text: 'Revenue up 12%', bullet: true },
      { text: 'Mostly in EMEA', bullet: true, level: 1 },
      { text: 'Churn down', bullet: true },
    ]);
    const ellipse = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'ellipse')!;
    // A filled shape with text comes back as the shape plus a centered text element on top, so styling survives.
    expect(ellipse).toMatchObject({ fill: '#00aa00' });
    expect(ellipse.text).toBeUndefined();
    const go = s2.elements[s2.elements.indexOf(ellipse) + 1] as TextElement;
    expect(go).toMatchObject({ type: 'text', paragraphs: [{ text: 'Go' }], style: { align: 'center', valign: 'middle', color: '#ffffff' } });
    expect(Math.abs(ellipse.x - 700)).toBeLessThanOrEqual(2);
    const line = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'line')!;
    expect(line).toMatchObject({ stroke: '#ff0000', h: 0 });
    expect(line.strokeWidth).toBeGreaterThanOrEqual(3);
    // Translucent fills, vertical lines and per-paragraph sizes survive too.
    const pill = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'rounded')!;
    expect(pill.fill).toBe('rgba(255, 255, 255, 0.12)');
    expect(pill.stroke).toBe('rgba(255, 255, 255, 0.3)');
    const vline = s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'line' && e.w === 0)!;
    expect(Math.abs(vline.h - 200)).toBeLessThanOrEqual(2);
    expect(vline.stroke).toBe('#00ff00');
    const figure = s2.elements.find((e): e is TextElement => e.type === 'text' && e.paragraphs[0]?.text === '2-3x')!;
    expect(figure.style).toMatchObject({ size: 47, align: 'center', color: '#ffffff', font: 'Poppins', lineHeight: 1.5 });
    expect(figure.paragraphs[0].size).toBeUndefined(); // the first paragraph is the box's own style
    expect(figure.paragraphs[1]).toMatchObject({ text: 'Average program cost reduction', size: 17, bold: true });

    // Preset geometries map both ways through the shape table.
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'star')).toMatchObject({ fill: '#ffcc00', w: 100, h: 100 });
    expect(s2.elements.find((e): e is ShapeElement => e.type === 'shape' && e.shape === 'arrow')).toMatchObject({ fill: 'none', stroke: '#0000ff' });
    const img = s2.elements.find((e): e is ImageElement => e.type === 'image')!;
    expect(img.src).toBe('/api/images/00000000-0000-0000-0000-000000000001');
    expect(stored).toEqual([{ type: 'image/png', size: expect.any(Number) }]);
  });

  it('reports what it drops and rejects files that are not presentations', async () => {
    await expect(importPptx(Buffer.from('nope'), async () => '')).rejects.toThrow(/not a valid PowerPoint/);
    const deck: Deck = { version: 1, theme: 'dark', slides: [buildSlide('image', { title: 'Pic', image: 'https://example.com/missing.png' }, newId)] };
    const { buf, warnings } = await pptxBuffer(deck); // the image cannot be loaded in this test
    expect(warnings[0]).toMatch(/1 image could not be loaded/);
    const { deck: imported } = await importPptx(buf, async () => '');
    expect(imported.slides[0].bg).toBe('#1b1b1f'); // the dark theme's background travels as a slide color
    expect(imported.slides[0].elements.some((e) => e.type === 'text' && e.paragraphs[0].text === 'Image unavailable')).toBe(true);
  });
});
