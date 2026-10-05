// The shapes a slide can hold. Rectangles, rounded rectangles, ellipses and lines are drawn with CSS; every
// other shape is a polygon given in a 100×100 box, stretched to the element's size. The same table drives
// the editor's shape picker, the renderer, and the PowerPoint export and import (`pptx` is the preset name).

export const SHAPE_KINDS = [
  'rect',
  'rounded',
  'ellipse',
  'triangle',
  'right-triangle',
  'diamond',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'parallelogram',
  'trapezoid',
  'arrow',
  'double-arrow',
  'chevron',
  'callout',
  'plus',
  'heart',
  'cylinder',
  'line',
  'arc',
] as const;

export type ShapeKind = (typeof SHAPE_KINDS)[number];

export interface ShapeDef {
  name: string;
  /** PowerPoint preset geometry name (pptxgenjs ShapeType and the prst attribute in .pptx files). */
  pptx: string;
  /** Polygon vertices in a 100×100 box, as [x, y, x, y, ...]; absent for the CSS-drawn shapes. */
  points?: number[];
  /** SVG path for a shape with curves, for a box of the given size (the cylinder). */
  path?: (w: number, h: number) => string;
  /** Keep width and height equal when inserted. */
  square?: boolean;
}

/** A heart outline as a polygon, from the classic parametric curve, scaled into the 100×100 box. */
function heartPoints(): number[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * 2 * Math.PI;
    pts.push([16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return pts.flatMap(([x, y]) => [Math.round(((x - x0) / (x1 - x0)) * 1000) / 10, Math.round(((y1 - y) / (y1 - y0)) * 1000) / 10]);
}

export const SHAPES: Record<ShapeKind, ShapeDef> = {
  rect: { name: 'Rectangle', pptx: 'rect' },
  rounded: { name: 'Rounded rectangle', pptx: 'roundRect' },
  ellipse: { name: 'Ellipse', pptx: 'ellipse' },
  triangle: { name: 'Triangle', pptx: 'triangle', points: [50, 0, 100, 100, 0, 100] },
  'right-triangle': { name: 'Right triangle', pptx: 'rtTriangle', points: [0, 0, 100, 100, 0, 100] },
  diamond: { name: 'Diamond', pptx: 'diamond', points: [50, 0, 100, 50, 50, 100, 0, 50], square: true },
  pentagon: { name: 'Pentagon', pptx: 'pentagon', points: [50, 0, 100, 38, 81, 100, 19, 100, 0, 38], square: true },
  hexagon: { name: 'Hexagon', pptx: 'hexagon', points: [25, 0, 75, 0, 100, 50, 75, 100, 25, 100, 0, 50] },
  octagon: { name: 'Octagon', pptx: 'octagon', points: [29, 0, 71, 0, 100, 29, 100, 71, 71, 100, 29, 100, 0, 71, 0, 29], square: true },
  star: { name: 'Star', pptx: 'star5', points: [50, 0, 61, 35, 98, 35, 68, 57, 79, 91, 50, 70, 21, 91, 32, 57, 2, 35, 39, 35], square: true },
  parallelogram: { name: 'Parallelogram', pptx: 'parallelogram', points: [25, 0, 100, 0, 75, 100, 0, 100] },
  trapezoid: { name: 'Trapezoid', pptx: 'trapezoid', points: [20, 0, 80, 0, 100, 100, 0, 100] },
  arrow: { name: 'Arrow', pptx: 'rightArrow', points: [0, 30, 60, 30, 60, 0, 100, 50, 60, 100, 60, 70, 0, 70] },
  'double-arrow': { name: 'Double arrow', pptx: 'leftRightArrow', points: [0, 50, 25, 0, 25, 30, 75, 30, 75, 0, 100, 50, 75, 100, 75, 70, 25, 70, 25, 100] },
  chevron: { name: 'Chevron', pptx: 'chevron', points: [0, 0, 75, 0, 100, 50, 75, 100, 0, 100, 25, 50] },
  callout: { name: 'Speech bubble', pptx: 'wedgeRectCallout', points: [0, 0, 100, 0, 100, 75, 40, 75, 18, 100, 24, 75, 0, 75] },
  plus: { name: 'Plus', pptx: 'mathPlus', points: [35, 0, 65, 0, 65, 35, 100, 35, 100, 65, 65, 65, 65, 100, 35, 100, 35, 65, 0, 65, 0, 35, 35, 35], square: true },
  heart: { name: 'Heart', pptx: 'heart', points: heartPoints(), square: true },
  cylinder: { name: 'Cylinder', pptx: 'can', path: cylinderPath },
  line: { name: 'Line', pptx: 'line' },
  arc: { name: 'Arc', pptx: 'arc', square: true },
};

/** A cylinder (database) outline: an elliptical top rim over a body with a curved bottom. */
function cylinderPath(w: number, h: number): string {
  const ry = Math.min(h / 4, w / 4); // half the rim's height
  const rx = w / 2;
  const n = (v: number) => Math.round(v * 100) / 100;
  // The outline: down the left side, round the bottom, up the right side, over the top; then the rim's front arc.
  return (
    `M0,${n(ry)} V${n(h - ry)} A${n(rx)},${n(ry)} 0 0 0 ${n(w)},${n(h - ry)} V${n(ry)} A${n(rx)},${n(ry)} 0 0 0 0,${n(ry)} Z ` +
    `M0,${n(ry)} A${n(rx)},${n(ry)} 0 0 0 ${n(w)},${n(ry)}`
  );
}

const BY_PPTX = new Map<string, ShapeKind>(SHAPE_KINDS.map((k) => [SHAPES[k].pptx, k]));
// Other PowerPoint presets that are close enough to one of ours.
const PPTX_ALIASES: Record<string, ShapeKind> = {
  round1Rect: 'rounded',
  snip1Rect: 'rect',
  snip2SameRect: 'rect',
  snip2DiagRect: 'rect',
  flowChartPunchedCard: 'rect',
  flowChartMagneticDisk: 'cylinder',
  flowChartMagneticDrum: 'cylinder',
  round2SameRect: 'rounded',
  round2DiagRect: 'rounded',
  snipRoundRect: 'rounded',
  straightConnector1: 'line',
  flowChartDecision: 'diamond',
  bentConnector3: 'line',
  curvedConnector3: 'line',
  flowChartProcess: 'rect',
  flowChartTerminator: 'rounded',
  flowChartConnector: 'ellipse',
  homePlate: 'chevron',
  notchedRightArrow: 'arrow',
  stripedRightArrow: 'arrow',
  plus: 'plus',
  star4: 'star',
  star6: 'star',
  star8: 'star',
  wedgeRoundRectCallout: 'callout',
  wedgeEllipseCallout: 'callout',
  isoTriangle: 'triangle',
  blockArc: 'arc',
};

/** Our shape for a PowerPoint preset geometry, or undefined if nothing is close. */
export function shapeFromPptx(prst: string | undefined): ShapeKind | undefined {
  if (!prst) return 'rect';
  return BY_PPTX.get(prst) ?? PPTX_ALIASES[prst];
}

/** SVG path of an open arc along the ellipse inscribed in a w×h box, from start to end degrees clockwise from 3 o'clock. */
export function arcPath(w: number, h: number, start = 270, end = 0): string {
  const rx = w / 2;
  const ry = h / 2;
  const pt = (deg: number) => `${rx + rx * Math.cos((deg * Math.PI) / 180)} ${ry + ry * Math.sin((deg * Math.PI) / 180)}`;
  const sweep = (((end - start) % 360) + 360) % 360;
  if (sweep === 0) return `M ${pt(start)}`;
  return `M ${pt(start)} A ${rx} ${ry} 0 ${sweep > 180 ? 1 : 0} 1 ${pt(end)}`;
}

/** True for shapes drawn by an SVG inside their box (polygons and paths) rather than with CSS. */
export function isDrawn(kind: ShapeKind): boolean {
  return kind === 'arc' || !!(SHAPES[kind].points || SHAPES[kind].path);
}

/** SVG polygon points for a polygon shape, scaled to a box; undefined for the CSS-drawn shapes. */
export function polygonPoints(kind: ShapeKind, w: number, h: number): string | undefined {
  const pts = SHAPES[kind].points;
  if (!pts) return undefined;
  const out: string[] = [];
  for (let i = 0; i < pts.length; i += 2) out.push(`${(pts[i] / 100) * w},${(pts[i + 1] / 100) * h}`);
  return out.join(' ');
}
