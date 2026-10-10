import { describe, expect, it } from 'vitest';
import type { SlideElement } from './deck.ts';
import { clickTarget, isHollow } from './deckHit.ts';

const picture: SlideElement = { id: 'pic', type: 'image', src: '/api/images/x', x: 100, y: 100, w: 400, h: 300 };
const frame: SlideElement = { id: 'frame', type: 'shape', shape: 'rect', fill: 'none', stroke: '#c4c7cc', x: 100, y: 100, w: 400, h: 300 };
const id = (els: SlideElement[], hit: SlideElement, x: number, y: number) => clickTarget(els, hit, x, y, 6).id;

describe('a click inside a hollow shape', () => {
  it('knows an outline from a filled or labelled shape', () => {
    expect(isHollow(frame)).toBe(true);
    expect(isHollow({ ...frame, fill: '#ffffff' } as SlideElement)).toBe(false);
    expect(isHollow({ ...frame, fill: undefined } as SlideElement)).toBe(false);
    expect(isHollow({ ...frame, text: 'Label' } as SlideElement)).toBe(false);
    expect(isHollow({ ...frame, shape: 'line' } as SlideElement)).toBe(false);
    expect(isHollow(picture)).toBe(false);
  });

  it('goes to the picture under a frame, and to the frame on its outline', () => {
    const els = [picture, frame];
    expect(id(els, frame, 300, 250)).toBe('pic');
    expect(id(els, frame, 103, 250)).toBe('frame');
    expect(id(els, frame, 300, 396)).toBe('frame');
    // A thick outline is the frame as far in as it is drawn.
    expect(id([picture, { ...frame, strokeWidth: 20 } as SlideElement], frame, 120, 250)).toBe('pic');
    expect(clickTarget([picture, { ...frame, strokeWidth: 20 } as SlideElement], { ...frame, strokeWidth: 20 } as SlideElement, 120, 250, 6).id).toBe('frame');
  });

  it('stays the shape when nothing is under it there, or it is not hollow', () => {
    expect(id([frame], frame, 300, 250)).toBe('frame');
    const small = { ...picture, w: 50, h: 50 } as SlideElement;
    expect(id([small, frame], frame, 300, 250)).toBe('frame');
    expect(id([small, frame], frame, 120, 120)).toBe('pic');
    const filled = { ...frame, fill: '#ffffff' } as SlideElement;
    expect(id([picture, filled], filled, 300, 250)).toBe('frame');
    // Only what is under the shape, not what is drawn over it.
    expect(id([frame, picture], frame, 300, 250)).toBe('frame');
  });

  it('goes through frames stacked on one another, to the first thing that is not one', () => {
    const outer = { ...frame, id: 'outer', x: 50, y: 50, w: 500, h: 400 } as SlideElement;
    expect(id([picture, frame, outer], outer, 300, 250)).toBe('pic');
    expect(id([frame, outer], outer, 300, 250)).toBe('frame');
    expect(id([picture, frame, outer], outer, 52, 250)).toBe('outer');
  });

  it('measures an ellipse from its curve and a turned shape in its own frame', () => {
    const ring = { ...frame, id: 'ring', shape: 'ellipse' } as SlideElement;
    // The box's corner is far outside the curve; the middle of a side is on it.
    expect(id([picture, ring], ring, 300, 250)).toBe('pic');
    expect(id([picture, ring], ring, 300, 102)).toBe('ring');
    const turned = { ...frame, id: 'turned', x: 200, y: 0, w: 200, h: 600, rot: 90 } as SlideElement;
    const under = { ...picture, x: 0, y: 200, w: 600, h: 200 } as SlideElement;
    // Turned a quarter, the tall box lies wide: its outline is along y = 200 and y = 400.
    expect(id([under, turned], turned, 300, 300)).toBe('pic');
    expect(id([under, turned], turned, 300, 202)).toBe('turned');
  });
});
