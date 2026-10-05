// Renders one slide at a scale. The same component draws the editor canvas, the thumbnails, the present mode
// and the print layout, so a slide always looks the same. Elements are absolutely positioned in a 960×540 box
// that is scaled with a CSS transform.
import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  ROLE_SIZE,
  SLIDE_H,
  SLIDE_W,
  THEMES,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TextElement,
  type Theme,
  type ThemeId,
} from '../../../shared/deck.ts';
import { arcPath, polygonPoints, SHAPES } from '../../../shared/shapes.ts';

/** A box override while an element is being dragged or resized. */
export type BoxPreview = Partial<Pick<SlideElement, 'x' | 'y' | 'w' | 'h'>>;

export interface SlideViewProps {
  slide: Slide;
  theme: ThemeId;
  scale: number;
  /** Live positions during a drag, by element id. */
  preview?: Record<string, BoxPreview>;
  /** Element whose text is being edited inline, with the callback that commits the text. */
  editing?: { id: string; onCommit(paragraphs: Paragraph[]): void; onStop(): void } | null;
  onElementMouseDown?(e: MouseEvent, el: SlideElement): void;
  onElementDoubleClick?(e: MouseEvent, el: SlideElement): void;
  /** Drawn on top of the elements (selection handles). */
  children?: ReactNode;
  className?: string;
}

export function themeVars(t: Theme): CSSProperties {
  return {
    '--sl-bg': t.bg,
    '--sl-text': t.text,
    '--sl-heading': t.heading,
    '--sl-muted': t.muted,
    '--sl-accent': t.accent,
    '--sl-heading-font': t.headingFont,
    '--sl-body-font': t.bodyFont,
  } as CSSProperties;
}

export function textStyleOf(el: TextElement, theme: Theme): CSSProperties {
  const role = el.role ?? 'body';
  const s = el.style ?? {};
  const heading = role === 'title' || role === 'subtitle';
  const size = s.size ?? ROLE_SIZE[role];
  const themeFont = heading ? theme.headingFont : theme.bodyFont;
  return {
    fontSize: size,
    fontFamily: s.font ? `"${s.font.replace(/"/g, '')}", ${themeFont}` : themeFont,
    lineHeight: s.lineHeight ?? 1.25,
    ['--sl-para' as string]: `${s.paraSpacing ?? size * 0.3}px`,
    fontWeight: s.bold ?? role === 'title' ? 700 : 400,
    fontStyle: s.italic ? 'italic' : 'normal',
    color: s.color ?? (role === 'title' ? theme.heading : role === 'caption' || role === 'subtitle' ? theme.muted : theme.text),
    textAlign: s.align ?? 'left',
    justifyContent: s.valign === 'middle' ? 'center' : s.valign === 'bottom' ? 'flex-end' : 'flex-start',
  };
}

function boxStyle(el: SlideElement, preview?: BoxPreview): CSSProperties {
  const b = { x: el.x, y: el.y, w: el.w, h: el.h, ...preview };
  const style: CSSProperties = { left: b.x, top: b.y, width: b.w, height: b.h };
  // A line's thickness comes from its stroke; the vertical/horizontal style overrides the zero dimension.
  if (el.type === 'shape' && el.shape === 'line') {
    const sw = el.strokeWidth ?? 3;
    if (el.h > el.w) {
      style.width = sw;
      style.left = b.x - sw / 2;
    } else {
      style.height = sw;
      style.top = b.y - sw / 2;
    }
  }
  return style;
}

function shapeStyle(el: ShapeElement, theme: Theme): CSSProperties {
  const fill = el.fill === 'none' ? 'transparent' : (el.fill ?? theme.accent);
  const stroke = el.stroke ?? (el.shape === 'line' ? theme.accent : undefined);
  const sw = el.strokeWidth ?? (el.shape === 'line' ? 3 : stroke ? 2 : 0);
  if (el.shape === 'line') return { background: el.stroke ?? el.fill ?? theme.accent };
  const text: CSSProperties = {
    color: el.textColor ?? (el.fill === 'none' ? theme.text : '#fff'),
    fontFamily: el.textFont ? `"${el.textFont.replace(/"/g, '')}", ${theme.bodyFont}` : theme.bodyFont,
    fontSize: el.textSize ?? 18,
    ...(el.textBold ? { fontWeight: 700 } : {}),
    ...(el.textItalic ? { fontStyle: 'italic' } : {}),
  };
  // Polygon shapes are drawn by an SVG inside the box (see ShapePolygon); the box itself stays transparent.
  if (SHAPES[el.shape].points || el.shape === 'arc') return text;
  return {
    background: fill,
    borderRadius: el.shape === 'ellipse' ? '50%' : el.shape === 'rounded' ? 16 : 0,
    border: sw ? `${sw}px solid ${stroke ?? fill}` : undefined,
    ...text,
  };
}

/** The polygon of a non-CSS shape, in the element's own coordinates so strokes scale with the slide. */
function ShapePolygon({ el, theme, box }: { el: ShapeElement; theme: Theme; box: BoxPreview }) {
  const w = box.w ?? el.w;
  const h = box.h ?? el.h;
  if (el.shape === 'arc') {
    return (
      <svg className="sl-shape-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
        <path d={arcPath(w, h, el.startAngle, el.endAngle)} fill="none" stroke={el.stroke ?? theme.accent} strokeWidth={el.strokeWidth ?? 2} />
      </svg>
    );
  }
  const points = polygonPoints(el.shape, w, h);
  if (!points) return null;
  const fill = el.fill === 'none' ? 'none' : (el.fill ?? theme.accent);
  const sw = el.strokeWidth ?? (el.stroke ? 2 : 0);
  return (
    <svg className="sl-shape-svg" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polygon points={points} fill={fill} stroke={sw ? (el.stroke ?? fill) : 'none'} strokeWidth={sw} strokeLinejoin="round" />
    </svg>
  );
}

/** Inline style for a paragraph's own overrides (size, weight, color, font). */
function paragraphStyle(p: Paragraph): CSSProperties {
  const s: CSSProperties = { paddingLeft: p.bullet ? 28 + (p.level ?? 0) * 28 : (p.level ?? 0) * 28 };
  if (p.size !== undefined) s.fontSize = p.size;
  if (p.bold !== undefined) s.fontWeight = p.bold ? 700 : 400;
  if (p.italic !== undefined) s.fontStyle = p.italic ? 'italic' : 'normal';
  if (p.color) s.color = p.color;
  if (p.font) s.fontFamily = `"${p.font.replace(/"/g, '')}", inherit`;
  return s;
}

export const Paragraphs = memo(function Paragraphs({ paragraphs }: { paragraphs: Paragraph[] }) {
  return (
    <>
      {paragraphs.map((p, i) => (
        <div key={i} className={`sl-p${p.bullet ? ' bullet' : ''}`} data-bullet={p.bullet ? '1' : undefined} data-level={p.level || undefined} data-p={i} style={paragraphStyle(p)}>
          {p.text || '​'}
        </div>
      ))}
    </>
  );
});

/**
 * Read paragraphs back from an edited contentEditable: each block is a paragraph. Blocks keep their bullet, and
 * their style overrides come from the original paragraph with the same data-p index (a block the browser made
 * by splitting one inherits from the paragraph before it).
 */
function parseEditedText(root: HTMLElement, original: Paragraph[]): Paragraph[] {
  const out: Paragraph[] = [];
  const blocks = Array.from(root.children).filter((c) => c instanceof HTMLElement) as HTMLElement[];
  if (!blocks.length) {
    for (const line of (root.textContent ?? '').split('\n')) out.push({ ...overridesOf(original[0]), text: line });
    return out.length ? out : [{ text: '' }];
  }
  let prev: Paragraph | undefined;
  for (const b of blocks) {
    const text = (b.innerText ?? b.textContent ?? '').replace(/​/g, '').replace(/\n$/, '');
    const bullet = b.dataset.bullet !== undefined ? b.dataset.bullet === '1' : !!prev?.bullet;
    const level = b.dataset.level !== undefined ? Number(b.dataset.level) || 0 : (prev?.level ?? 0);
    const source = b.dataset.p !== undefined ? original[Number(b.dataset.p)] : prev;
    const p: Paragraph = { ...overridesOf(source), text, ...(bullet ? { bullet: true } : {}), ...(bullet && level ? { level } : {}) };
    out.push(p);
    prev = p;
  }
  return out;
}

function overridesOf(p: Paragraph | undefined): Partial<Paragraph> {
  if (!p) return {};
  const o: Partial<Paragraph> = {};
  if (p.size !== undefined) o.size = p.size;
  if (p.bold !== undefined) o.bold = p.bold;
  if (p.italic !== undefined) o.italic = p.italic;
  if (p.color !== undefined) o.color = p.color;
  if (p.font !== undefined) o.font = p.font;
  return o;
}

const PLACEHOLDERS = new Set(['Presentation title', 'Subtitle', 'Section title', 'Slide title', 'Click to add text', 'Left column', 'Right column', 'Title', 'Text']);

/** Inline editor for a text element. Uncontrolled: the DOM is the draft; the text is committed on blur. */
function TextEditor({ initial, onCommit, onStop, style }: { initial: Paragraph[]; onCommit(p: Paragraph[]): void; onStop(): void; style: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current || !ref.current) return;
    committed.current = true;
    onCommit(parseEditedText(ref.current, initial));
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    // Placeholder text is replaced by typing; real text gets the caret at the end.
    if (!(initial.length === 1 && PLACEHOLDERS.has(initial[0].text))) range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      className="sl-text sl-editing"
      style={style}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onBlur={() => {
        commit();
        onStop();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          commit();
          onStop();
        } else if (e.key === 'Tab') {
          // Indent or outdent the bullet the caret is in.
          e.preventDefault();
          const node = window.getSelection()?.anchorNode;
          let block: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
          while (block && block.parentElement !== ref.current) block = block.parentElement;
          if (!block) return;
          const level = Math.max(0, Math.min(4, (Number(block.dataset.level) || 0) + (e.shiftKey ? -1 : 1)));
          block.dataset.level = level ? String(level) : '';
          if (!level) delete block.dataset.level;
          if (block.dataset.bullet === undefined && !e.shiftKey) block.dataset.bullet = '1';
          const bullet = block.dataset.bullet === '1';
          block.style.paddingLeft = `${(bullet ? 28 : 0) + level * 28}px`;
          block.classList.toggle('bullet', bullet);
        } else if ((e.metaKey || e.ctrlKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
          e.preventDefault(); // Styling applies to the whole element from the toolbar.
        }
      }}
      onPaste={(e) => {
        // Plain text only, as paragraphs.
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        const sel = window.getSelection();
        if (!sel?.rangeCount) return;
        sel.deleteFromDocument();
        const lines = text.split(/\r?\n/);
        const range = sel.getRangeAt(0);
        range.insertNode(document.createTextNode(lines.join(' ')));
        range.collapse(false);
      }}
    >
      <Paragraphs paragraphs={initial} />
    </div>
  );
}

export function SlideView({ slide, theme: themeId, scale, preview, editing, onElementMouseDown, onElementDoubleClick, children, className }: SlideViewProps) {
  const theme = THEMES[themeId];
  return (
    <div className={`slide-scaler${className ? ` ${className}` : ''}`} style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
      <div className="slide" style={{ ...themeVars(theme), width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, background: slide.bg ?? theme.bg }}>
        {slide.elements.map((el) => {
          const box = boxStyle(el, preview?.[el.id]);
          const common = {
            'data-el': el.id,
            onMouseDown: onElementMouseDown ? (e: MouseEvent) => onElementMouseDown(e, el) : undefined,
            onDoubleClick: onElementDoubleClick ? (e: MouseEvent) => onElementDoubleClick(e, el) : undefined,
          };
          if (el.type === 'text') {
            const style = { ...box, ...textStyleOf(el, theme) };
            if (editing?.id === el.id) {
              return (
                <div key={el.id} className="sl-el" style={box} data-el={el.id}>
                  <TextEditor initial={el.paragraphs} onCommit={editing.onCommit} onStop={editing.onStop} style={{ ...textStyleOf(el, theme), width: '100%', height: '100%' }} />
                </div>
              );
            }
            return (
              <div key={el.id} {...common} className="sl-el sl-text" style={style}>
                <Paragraphs paragraphs={el.paragraphs} />
              </div>
            );
          }
          if (el.type === 'image') {
            return (
              <div key={el.id} {...common} className="sl-el sl-image" style={box}>
                <img src={el.src} alt="" draggable={false} style={{ objectFit: el.fit ?? 'contain' }} />
              </div>
            );
          }
          const style = { ...box, ...shapeStyle(el, theme) };
          const polygon = <ShapePolygon el={el} theme={theme} box={preview?.[el.id] ?? {}} />;
          if (editing?.id === el.id) {
            return (
              <div key={el.id} className="sl-el sl-shape" style={style} data-el={el.id}>
                {polygon}
                <TextEditor
                  initial={[{ text: el.text ?? '' }]}
                  onCommit={(ps) => editing.onCommit(ps)}
                  onStop={editing.onStop}
                  style={{ width: '100%', height: '100%', justifyContent: 'center', textAlign: 'center', fontSize: el.textSize ?? 18 }}
                />
              </div>
            );
          }
          return (
            <div key={el.id} {...common} className={`sl-el sl-shape sl-${el.shape}`} style={style}>
              {polygon}
              {el.text ? <span>{el.text}</span> : null}
            </div>
          );
        })}
        {children}
      </div>
    </div>
  );
}
