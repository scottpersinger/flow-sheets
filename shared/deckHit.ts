// What a click on a slide means when it lands inside a hollow shape. A shape with no fill and no text is an
// outline: a frame around a screenshot, a box drawn round a group of things. What the user sees in it, and is
// reaching for, is what lies under it. So a click inside such a shape goes to the element beneath, when there
// is one; a click on its outline, or inside it over nothing, is a click on the shape as before.
import type { SlideElement } from './deck.ts';

/** The point in an element's own frame: turned back by the element's rotation about its box's centre. */
function local(el: SlideElement, px: number, py: number): [number, number] {
  if (!el.rot) return [px, py];
  const [cx, cy] = [el.x + el.w / 2, el.y + el.h / 2];
  const a = (-el.rot * Math.PI) / 180;
  const [dx, dy] = [px - cx, py - cy];
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

function inBox(el: SlideElement, px: number, py: number): boolean {
  const [x, y] = local(el, px, py);
  return x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h;
}

/** True for a shape that is only an outline: nothing fills it and nothing is written in it. */
export function isHollow(el: SlideElement): boolean {
  return el.type === 'shape' && el.fill === 'none' && !el.text && el.shape !== 'line' && el.shape !== 'arc' && el.w > 0 && el.h > 0;
}

/** True if the point is on (within `reach` of) a hollow shape's outline rather than in its open middle. */
function onOutline(el: SlideElement, px: number, py: number, reach: number): boolean {
  const [x, y] = local(el, px, py);
  const within = reach + (el.type === 'shape' ? (el.strokeWidth ?? 2) : 0);
  if (el.type === 'shape' && el.shape === 'ellipse') {
    const [rx, ry] = [el.w / 2, el.h / 2];
    const [dx, dy] = [x - (el.x + rx), y - (el.y + ry)];
    // How far in from the edge, along the line from the centre, in the smaller radius's units.
    const r = Math.hypot(dx / rx, dy / ry);
    return (1 - r) * Math.min(rx, ry) <= within;
  }
  return Math.min(x - el.x, el.x + el.w - x, y - el.y, el.y + el.h - y) <= within;
}

/**
 * The element a click at (px, py) is for, given the element that received it (`hit`, the topmost there) and
 * the slide's elements in drawing order. `reach` is how near the outline counts as on it, in slide points.
 */
export function clickTarget(elements: SlideElement[], hit: SlideElement, px: number, py: number, reach: number): SlideElement {
  let target = hit;
  for (;;) {
    if (!isHollow(target) || onOutline(target, px, py, reach)) return target;
    const at = elements.findIndex((e) => e.id === target.id);
    let below: SlideElement | undefined;
    for (let i = at - 1; i >= 0 && !below; i--) if (inBox(elements[i], px, py)) below = elements[i];
    if (!below) return target;
    target = below;
  }
}
