import { describe, expect, it } from 'vitest';
import { arcGeometry, arcTightBox, tightArc } from './shapes.ts';
import { buildSlide, deckOutline, fromParagraphs, newDeck, newId, slideContent, toParagraphs, updateSlideContent, validateDeck, type Deck, type TextElement } from './deck.ts';

const titleOf = (slide: ReturnType<typeof buildSlide>) => (slide.elements.find((e) => e.type === 'text' && e.role === 'title') as TextElement).paragraphs[0].text;

describe('deck model', () => {
  it('turns body lines into bullets with indent levels and back', () => {
    const ps = toParagraphs(['Plain', '- Bullet', '  - Nested', '    * Deeper'], false);
    expect(ps).toEqual([{ text: 'Plain' }, { text: 'Bullet', bullet: true }, { text: 'Nested', bullet: true, level: 1 }, { text: 'Deeper', bullet: true, level: 2 }]);
    expect(fromParagraphs(ps)).toEqual(['Plain', '- Bullet', '  - Nested', '    - Deeper']);
    // Body text is bulleted by default; empty lines stay plain.
    expect(toParagraphs(['One', ''], true)).toEqual([{ text: 'One', bullet: true }, { text: '' }]);
  });

  it('builds slides from layouts and reads their content back', () => {
    const slide = buildSlide('two-column', { title: 'Compare', body: ['a', 'b'], body2: ['c'], notes: 'say hi' }, newId);
    expect(slide.layout).toBe('two-column');
    expect(slide.notes).toBe('say hi');
    expect(titleOf(slide)).toBe('Compare');
    expect(slideContent(slide)).toEqual({ title: 'Compare', body: ['- a', '- b'], body2: ['- c'], notes: 'say hi' });

    const image = buildSlide('image', { title: 'Pic', image: 'https://example.com/a.png', caption: 'A picture' }, newId);
    expect(image.elements.map((e) => e.type)).toEqual(['text', 'image', 'text']);
    expect(slideContent(image)).toMatchObject({ title: 'Pic', image: 'https://example.com/a.png', caption: 'A picture' });

    // Missing content gets placeholders; a blank slide has no elements.
    expect(titleOf(buildSlide('title-body', {}, newId))).toBe('Slide title');
    expect(buildSlide('blank', {}, newId).elements).toEqual([]);
  });

  it('updates a slide by role without moving elements, and rebuilds when the layout changes', () => {
    const slide = buildSlide('title-body', { title: 'Old', body: ['x'] }, newId);
    const moved = { ...slide, elements: slide.elements.map((e) => (e.type === 'text' && e.role === 'title' ? { ...e, x: 123 } : e)) };
    const updated = updateSlideContent(moved, { title: 'New', notes: 'n' }, newId);
    expect(titleOf(updated)).toBe('New');
    expect(updated.elements.find((e) => e.type === 'text' && e.role === 'title')!.x).toBe(123);
    expect(updated.elements.map((e) => e.id)).toEqual(moved.elements.map((e) => e.id));
    expect(updated.notes).toBe('n');

    const rebuilt = updateSlideContent(updated, { layout: 'two-column', body2: ['right'] }, newId);
    expect(rebuilt.layout).toBe('two-column');
    expect(slideContent(rebuilt)).toMatchObject({ title: 'New', body: ['- x'], body2: ['- right'] });

    // A role the slide has no element for also rebuilds from the layout (a section header gains its subtitle).
    const withSubtitle = updateSlideContent(buildSlide('section', { title: 'T' }, newId), { subtitle: 's' }, newId);
    expect(slideContent(withSubtitle)).toMatchObject({ title: 'T', subtitle: 's' });
  });

  it('validates decks', () => {
    const deck = newDeck();
    expect(validateDeck(deck)).toBeNull();
    expect(validateDeck({ ...deck, slides: [] })).toMatch(/at least one slide/);
    expect(validateDeck({ ...deck, theme: 'neon' })).toMatch(/theme/);
    const dup: Deck = { ...deck, slides: [deck.slides[0], deck.slides[0]] };
    expect(validateDeck(dup)).toMatch(/duplicate slide id/);
    const badEl: Deck = { ...deck, slides: [{ ...deck.slides[0], elements: [{ id: 'e', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' }] }] };
    expect(validateDeck(badEl)).toMatch(/Image must be/);
    const badBox: Deck = { ...deck, slides: [{ ...deck.slides[0], elements: [{ id: 'e', type: 'shape', shape: 'rect', x: Number.NaN, y: 0, w: 10, h: 10 }] }] };
    expect(validateDeck(badBox)).toMatch(/invalid x/);
  });

  it('outlines a deck compactly for the assistant', () => {
    const deck: Deck = { version: 1, theme: 'dark', slides: [buildSlide('title-body', { title: 'Agenda', body: ['One', 'Two'], notes: 'n' }, newId)] };
    const out = deckOutline(deck, 0);
    expect(out).toMatchObject({ theme: 'dark', slide_count: 1, current_slide: 1 });
    expect(out.slides[0]).toMatchObject({ slide: 1, layout: 'title-body', notes: 'n' });
    expect(out.slides[0].elements.map((e) => (e as { text?: string }).text)).toEqual(['Agenda', '- One\n- Two']);
  });
});

describe('tight arcs', () => {
  it('converts a whole-ellipse arc to its tight box and back to the same ellipse', () => {
    const old = { x: 180, y: 187, w: 223, h: 223, startAngle: 310, endAngle: 345, strokeWidth: 3 };
    const t = tightArc(old);
    expect(t.tight).toBe(true);
    expect(t.w).toBeLessThan(100);
    const g = arcGeometry(t);
    expect(g.rx).toBeCloseTo(111.5);
    expect(g.cx).toBeCloseTo(291.5);
    expect(arcTightBox(g, 310, 345, 3).x).toBeCloseTo(t.x);
  });
});
