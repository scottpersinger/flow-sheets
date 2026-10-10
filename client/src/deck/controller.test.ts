import { describe, expect, it } from 'vitest';
import { newDeck } from '../../../shared/deck.ts';
import { DeckController } from './controller.ts';

describe('replacing a picture with its edited version', () => {
  it('puts the edited picture where the element is now, as one step that undo takes back', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addImage('/api/images/old', { w: 800, h: 600 });
    const before = ctl.slide.elements.find((e) => e.id === id)!;
    // The user moves to another slide while the image editor is open: the element is still found.
    ctl.addSlide();
    expect(ctl.slide.elements.some((e) => e.id === id)).toBe(false);
    expect(ctl.replacePicture(id, '/api/images/new', { width: 800, height: 600 }, { width: 800, height: 300 })).toBe(true);
    const after = ctl.deck.slides.flatMap((s) => s.elements).find((e) => e.id === id)!;
    expect(after).toMatchObject({ type: 'image', src: '/api/images/new', w: before.w, h: Math.round(before.w / (800 / 300)) });
    ctl.undo();
    expect(ctl.deck.slides.flatMap((s) => s.elements).find((e) => e.id === id)).toEqual(before);
  });

  it('says so when the picture is no longer in the presentation', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addImage('/api/images/old');
    ctl.select([id]);
    ctl.deleteSelected();
    expect(ctl.replacePicture(id, '/api/images/new', null, null)).toBe(false);
    // An element of another kind with that id is not a picture to replace.
    const title = ctl.slide.elements.find((e) => e.type === 'text');
    if (title) expect(ctl.replacePicture(title.id, '/api/images/new', null, null)).toBe(false);
  });
});
