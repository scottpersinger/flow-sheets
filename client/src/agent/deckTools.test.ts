import { describe, expect, it } from 'vitest';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { newDeck, slideContent, slideTitle, type TextElement } from '../../../shared/deck.ts';
import { DeckController } from '../deck/controller.ts';
import { confirmationFor, runClientTool, type ClientToolEnv } from './clientTools.ts';

function setup() {
  const deck = new DeckController(newDeck(), async () => {});
  const env: ClientToolEnv = {
    ctl: null,
    deck,
    doc: null,
    group: 'agent-1',
    openSheet: async () => Promise.reject(new Error('No sheet in this test.')),
    openDeck: async () => deck,
    openDoc: async () => Promise.reject(new Error('No doc in this test.')),
    requestAppChange: async () => ({ id: 'job-1' }),
    requestResearch: async () => ({ id: 'job-2', sheetIncluded: false }),
    uploadImage: async () => '/api/images/00000000-0000-0000-0000-000000000001',
    fetchConnectorData: async () => Promise.reject(new Error('x')),
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  return { deck, env, call };
}

describe('agent deck tools', () => {
  it('adds slides from layouts, reads the outline and undoes one request as a single step', async () => {
    const { deck, call } = setup();
    const res = await call('add_slides', {
      slides: [
        { title: 'Agenda', body: ['Intro', 'Numbers', '  Details'] },
        { layout: 'section', title: 'Part one' },
        { layout: 'two-column', title: 'Compare', body: ['a'], body2: ['b'] },
      ],
    });
    expect(res).toEqual({ added_slides: [2, 3, 4], slide_count: 4 });
    expect(deck.current).toBe(3);

    await call('set_deck_theme', { theme: 'ocean' });
    const outline = await call('read_deck');
    expect(outline.theme).toBe('ocean');
    expect(outline.slide_count).toBe(4);
    expect(outline.slides[1].layout).toBe('title-body');
    const body = outline.slides[1].elements.find((e: { role?: string }) => e.role === 'body');
    expect(body.text).toBe('- Intro\n- Numbers\n  - Details');

    deck.undo();
    expect(deck.deck.slides).toHaveLength(1);
    expect(deck.deck.theme).toBe('light');
  });

  it('updates a slide by role and rearranges with a layout', async () => {
    const { deck, call } = setup();
    await call('add_slides', { slides: [{ title: 'Old title', body: ['x'] }] });
    const title = deck.deck.slides[1].elements.find((e) => e.type === 'text' && e.role === 'title')!;

    let res = await call('update_slide', { slide: 2, title: 'New title', notes: 'Remember to smile', background: '#123456' });
    expect(res).toMatchObject({ updated_slide: 2 });
    const s = deck.deck.slides[1];
    expect(slideTitle(s)).toBe('New title');
    expect(s.notes).toBe('Remember to smile');
    expect(s.bg).toBe('#123456');
    expect(s.elements.find((e) => e.id === title.id)).toBeTruthy(); // same element, text replaced

    res = await call('update_slide', { slide: 2, layout: 'two-column', body2: ['right side'] });
    expect(deck.deck.slides[1].layout).toBe('two-column');
    expect(slideContent(deck.deck.slides[1])).toMatchObject({ title: 'New title', body: ['- x'], body2: ['- right side'] });

    await expect(call('update_slide', { slide: 9, title: 'x' })).rejects.toThrow(/no slide 9/);
    await expect(call('update_slide', { slide: 2 })).rejects.toThrow(/at least one property/);
  });

  it('edits individual elements: add, move, restyle and remove', async () => {
    const { deck, call } = setup();
    const before = deck.deck.slides[0].elements.map((e) => e.id);
    const res = await call('edit_elements', {
      slide: 1,
      set: [
        { id: before[0], x: 10, y: 20, bold: false, color: '#ff0000' },
        { type: 'shape', shape: 'ellipse', x: 700, y: 400, w: 100, h: 100, fill: '#00ff00', text: 'Go' },
        { type: 'image', src: 'https://example.com/pic.png', x: 0, y: 0, w: 200, h: 100 },
      ],
      remove: [before[1]],
    });
    expect(res.removed).toEqual([before[1]]);
    expect(res.set).toHaveLength(3);
    const slide = deck.deck.slides[0];
    expect(slide.elements).toHaveLength(3);
    const moved = slide.elements.find((e) => e.id === before[0]) as TextElement;
    expect(moved).toMatchObject({ x: 10, y: 20, style: { align: 'center', valign: 'bottom', color: '#ff0000' } });
    expect(moved.style?.bold).toBeUndefined();
    expect(slide.elements[1]).toMatchObject({ type: 'shape', shape: 'ellipse', fill: '#00ff00', text: 'Go' });
    expect(slide.elements[2]).toMatchObject({ type: 'image', src: 'https://example.com/pic.png' });
    expect(deck.selection).toEqual(res.set.map((e: { id: string }) => e.id));

    await expect(call('edit_elements', { slide: 1, set: [{ id: 'nope', x: 1 }] })).rejects.toThrow(/no element "nope"/);
    await expect(call('edit_elements', { slide: 1, set: [{ type: 'image', src: 'ftp://x/y.png' }] })).rejects.toThrow(/Image must be/);
    await expect(call('edit_elements', { slide: 1, set: [{ type: 'text', text: 'hi', x: Number.NaN }] })).rejects.toThrow(/invalid x/);
  });

  it('draws an elbow connector between two boxes that follows them, and reports it in read_deck', async () => {
    const { deck, call } = setup();
    await call('update_slide', { slide: 1, layout: 'blank' });
    const made = await call('edit_elements', {
      slide: 1,
      set: [
        { type: 'shape', shape: 'rect', x: 100, y: 50, w: 200, h: 60, fill: '#eeeeee', text: 'Fetch' },
        { type: 'shape', shape: 'rect', x: 400, y: 250, w: 200, h: 60, fill: '#eeeeee', text: 'Cache' },
      ],
    });
    const [a, b] = made.set.map((e: { id: string }) => e.id);
    const res = await call('edit_elements', {
      slide: 1,
      set: [{ type: 'line', kind: 'elbow', end_arrow: 'triangle', dash: 'dash', stroke: '#ff0000', stroke_width: 2, connect_start: { element_id: a, site: 'bottom' }, connect_end: { element_id: b, site: 'top' } }],
    });
    // The ends sit on the middles of the sides.
    expect(res.set[0]).toMatchObject({ type: 'line', x1: 200, y1: 110, x2: 500, y2: 250 });
    const id = res.set[0].id;
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ kind: 'elbow', endArrow: 'triangle', dash: 'dash', strokeColor: '#ff0000', strokeWidth: 2 });

    // Moving a box moves the end of the line with it.
    await call('edit_elements', { slide: 1, set: [{ id: b, x: 600, y: 300 }] });
    const outline = await call('read_deck');
    const line = outline.slides[0].elements.find((e: { id: string }) => e.id === id);
    expect(line).toMatchObject({ kind: 'elbow', x1: 200, y1: 110, x2: 700, y2: 300, end_arrow: 'triangle', start_arrow: 'none', connect_start: { element_id: a, site: 'bottom' }, connect_end: { element_id: b, site: 'top' } });

    // Removing a box detaches the line; the old `arrow` input still works; a connection needs a real element.
    await call('edit_elements', { slide: 1, remove: [b] });
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).not.toHaveProperty('endConnection');
    await call('edit_elements', { slide: 1, set: [{ id, arrow: 'both' }] });
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ startArrow: 'arrow', endArrow: 'arrow' });
    await expect(call('edit_elements', { slide: 1, set: [{ id, connect_end: { element_id: 'nope', site: 'left' } }] })).rejects.toThrow(/Cannot connect/);

    // Lines point any direction, and the legacy "shape: line" becomes a line element.
    const back = await call('edit_elements', { slide: 1, set: [{ type: 'line', x1: 300, y1: 400, x2: 100, y2: 350 }, { type: 'shape', shape: 'line', x: 10, y: 20, w: 0, h: 80, arrow: 'end' }] });
    expect(back.set[0]).toMatchObject({ x1: 300, y1: 400, x2: 100, y2: 350 });
    expect(deck.deck.slides[0].elements.find((e) => e.id === back.set[0].id)).toMatchObject({ x: 100, y: 350, w: 200, h: 50, flipH: true, flipV: true });
    expect(deck.deck.slides[0].elements.find((e) => e.id === back.set[1].id)).toMatchObject({ type: 'line', w: 0, h: 80, endArrow: 'arrow' });
  });

  it('keeps a drawn connector attached when a box is dragged or resized, and detaches it when only the line moves', () => {
    const { deck } = setup();
    const a = deck.addElement({ type: 'shape', shape: 'rect', x: 100, y: 100, w: 100, h: 50 });
    const b = deck.addElement({ type: 'shape', shape: 'rect', x: 400, y: 300, w: 100, h: 50 });
    const l = deck.addLine('elbow', true, { x1: 150, y1: 150, x2: 450, y2: 300, startConnection: { elementId: a, site: 'bottom' }, endConnection: { elementId: b, site: 'top' } });
    const line = () => deck.slide.elements.find((e) => e.id === l) as import('../../../shared/deck.ts').LineElement;
    expect(line()).toMatchObject({ kind: 'elbow', endArrow: 'arrow', x: 150, y: 150, w: 300, h: 150 });

    deck.moveElements({ [b]: { x: 600, y: 320 } });
    expect(line()).toMatchObject({ x: 150, y: 150, w: 500, h: 170 });
    deck.updateElements([a], (e) => ({ ...e, x: 0, w: 300 })); // resized: the bottom middle is now x = 150 still, wider box
    expect(line().startConnection).toBeDefined();

    deck.moveElements({ [l]: { x: 10, y: 10 } });
    expect(line().startConnection).toBeUndefined();
    expect(line().endConnection).toBeUndefined();
    deck.undo();
    expect(line().endConnection).toMatchObject({ elementId: b });
  });

  it('adds arcs with start and end angles and reports them', async () => {
    const { deck, call } = setup();
    const res = await call('edit_elements', { slide: 1, set: [{ type: 'shape', shape: 'arc', x: 10, y: 10, w: 100, h: 100, stroke: '#f00', stroke_width: 4, start_angle: 90, end_angle: 200 }] });
    const id = res.set[0].id;
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ shape: 'arc', stroke: '#f00', strokeWidth: 4, startAngle: 90, endAngle: 200 });
    const outline = await call('read_deck');
    expect(outline.slides[0].elements.find((e: { id: string }) => e.id === id)).toMatchObject({ shape: 'arc', start_angle: 90, end_angle: 200 });
  });

  it('styles shape labels with size, font, bold and color', async () => {
    const { deck, call } = setup();
    const res = await call('edit_elements', { slide: 1, set: [{ type: 'shape', text: 'Q1', size: 9, font: 'Poppins', bold: true, color: '#333' }] });
    const id = res.set[0].id;
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ text: 'Q1', textSize: 9, textFont: 'Poppins', textBold: true, textColor: '#333' });
    await call('edit_elements', { slide: 1, set: [{ id, bold: false, font: '' }] });
    const el = deck.deck.slides[0].elements.find((e) => e.id === id)!;
    expect(el).toMatchObject({ textSize: 9 });
    expect(el).not.toHaveProperty('textBold');
    expect(el).not.toHaveProperty('textFont');
    const outline = await call('read_deck');
    expect(outline.slides[0].elements.find((e: { id: string }) => e.id === id)).toMatchObject({ text: 'Q1', size: 9, color: '#333' });
    await expect(call('edit_elements', { slide: 1, set: [{ id, size: 2 }] })).rejects.toThrow(/label font size/);
  });

  it('renders a slide, attaches the picture and reports overflowing text', async () => {
    const { deck, env, call } = setup();
    await call('add_slides', { slides: [{ title: 'Roadmap' }] });
    const attached: unknown[] = [];
    const renders: { title: string; theme: string; scale: number }[] = [];
    env.attachImage = (img) => attached.push(img) <= 1;
    env.renderSlide = async (slide, theme, scale) => {
      renders.push({ title: slideTitle(slide), theme, scale });
      return {
        blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
        width: 960 * scale,
        height: 540 * scale,
        overflow: [{ id: 'e1', type: 'shape', box_w: 80, box_h: 20, text_w: 80, text_h: 44 }],
        missingImages: [],
      };
    };
    const res = await call('render_slide', { slide: 2 });
    expect(renders).toEqual([{ title: 'Roadmap', theme: 'light', scale: 1 }]);
    expect(res).toMatchObject({ slide: 2, width: 960, height: 540, image_url: '/api/images/00000000-0000-0000-0000-000000000001', overflow: [{ id: 'e1', text_h: 44 }] });
    expect(res.image).toMatch(/Attached/);
    expect(attached).toEqual([{ mediaType: 'image/png', data: 'iVBORw==', url: '/api/images/00000000-0000-0000-0000-000000000001' }]);

    // No room left for another picture in this message.
    expect((await call('render_slide', { slide: 1, scale: 0.5 })).image).toMatch(/Not attached/);

    await expect(call('render_slide', { slide: 3 })).rejects.toThrow(/no slide 3. The presentation has 2 slides/);
    await expect(runClientTool({ id: 'x', name: 'render_slide', input: { slide: 1 } }, { ...env, deck: null })).rejects.toThrow(/No presentation is open/);

    // Another saved presentation by id.
    env.deckId = 'open-one';
    env.loadDeck = async (id) => {
      if (id !== 'other') throw new Error('404');
      return { ...newDeck(), theme: 'ocean' };
    };
    await call('render_slide', { slide: 1, deck_id: 'other' });
    expect(renders.at(-1)).toMatchObject({ title: 'Presentation title', theme: 'ocean' });
    await expect(call('render_slide', { slide: 1, deck_id: 'missing' })).rejects.toThrow(/No presentation with id "missing"/);
    expect(deck.deck.slides).toHaveLength(2);
  });

  it('exports the deck as a PDF download named after its title', async () => {
    const { env, call } = setup();
    await call('add_slides', { slides: [{ title: 'Two' }] });
    const saved: { name: string; size: number }[] = [];
    env.deckTitle = 'BizTrip: Business Risk Review';
    env.makePdf = async (d) => new Blob([`pages:${d.slides.length}`]);
    env.saveFile = (name, file) => (saved.push({ name, size: file.size }), 'blob:x');
    expect(await call('export_deck', {})).toMatchObject({ filename: 'BizTrip_Business_Risk_Review.pdf', pages: 2, download_url: 'blob:x' });
    expect(saved).toEqual([{ name: 'BizTrip_Business_Risk_Review.pdf', size: 7 }]);

    env.loadDeck = async (id) => {
      if (id !== 'other') throw new Error('404');
      return newDeck();
    };
    env.loadDeckTitle = async () => 'Other deck';
    expect(await call('export_deck', { deck_id: 'other', format: 'pdf' })).toMatchObject({ filename: 'Other_deck.pdf', pages: 1 });
    await expect(call('export_deck', { deck_id: 'missing' })).rejects.toThrow(/No presentation with id "missing"/);
  });

  it('builds a PDF with one page per slide', async () => {
    const { buildPdf } = await import('../deck/pdf.ts');
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const text = await buildPdf([1, 2, 3].map(() => ({ jpeg, width: 1920, height: 1080 }))).text();
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
    expect(text).toContain('/MediaBox [0 0 960 540]');
  });

  it('deletes and moves slides, asking first and keeping one slide', async () => {
    const { deck, call } = setup();
    await call('add_slides', { slides: [{ title: 'Two' }, { title: 'Three' }] });
    const c = (name: string, input: Record<string, unknown>): ClientToolCall => ({ id: 'x', name, input });
    expect(confirmationFor(c('delete_slides', { slides: [2] }), null, deck)).toBe('Delete slide 2?');
    expect(confirmationFor(c('delete_slides', { slides: [2, 3] }), null, deck)).toBe('Delete 2 slides (2, 3)?');
    expect(confirmationFor(c('add_slides', { slides: [] }), null, deck)).toBeNull();

    await call('move_slide', { slide: 3, to: 1 });
    expect(deck.deck.slides.map(slideTitle)).toEqual(['Three', 'Presentation title', 'Two']);

    const res = await call('delete_slides', { slides: [1, 3] });
    expect(res).toEqual({ deleted: 2, slide_count: 1 });
    expect(slideTitle(deck.deck.slides[0])).toBe('Presentation title');
    await expect(call('delete_slides', { slides: [1] })).rejects.toThrow(/every slide/);
  });

  it('fails clearly when no presentation is open, and opens one', async () => {
    const { env, deck } = setup();
    const noDeck = { ...env, deck: null };
    await expect(runClientTool({ id: 'x', name: 'read_deck', input: {} }, noDeck)).rejects.toThrow(/No presentation is open/);
    await expect(runClientTool({ id: 'x', name: 'read_range', input: { range: 'A1' } }, env)).rejects.toThrow(/A presentation is open, not a spreadsheet/);
    const opened = JSON.parse(await runClientTool({ id: 'x', name: 'open_deck', input: { deck_id: 'd1' } }, noDeck));
    expect(opened).toMatchObject({ opened: true, slide_count: deck.deck.slides.length });
  });
});
