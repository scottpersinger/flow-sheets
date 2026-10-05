// The editing canvas: the current slide scaled to fit, with selection outlines and resize handles. Elements
// are moved and resized with the mouse (one undo step per drag), text is edited inline on double-click, and
// image files dropped on the slide become image elements.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { SLIDE_H, SLIDE_W, type SlideElement } from '../../../shared/deck.ts';
import type { DeckController } from './controller.ts';
import { SlideView, type BoxPreview } from './SlideView.tsx';

type Box = { x: number; y: number; w: number; h: number };
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface Drag {
  kind: 'move' | 'resize';
  handle?: Handle;
  startX: number;
  startY: number;
  boxes: Record<string, Box>;
  ratios: Record<string, number | null>;
  preview: Record<string, BoxPreview>;
  moved: boolean;
}

const MIN_SIZE = 10;
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handlePos(h: Handle, b: Box): { left: number; top: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const left = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : cx;
  const top = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : cy;
  return { left, top };
}

function resizeBox(orig: Box, h: Handle, dx: number, dy: number, ratio: number | null): Box {
  let { x, y, w, h: hh } = orig;
  if (h.includes('e')) w = Math.max(MIN_SIZE, orig.w + dx);
  if (h.includes('w')) {
    w = Math.max(MIN_SIZE, orig.w - dx);
    x = orig.x + orig.w - w;
  }
  if (h.includes('s')) hh = Math.max(MIN_SIZE, orig.h + dy);
  if (h.includes('n')) {
    hh = Math.max(MIN_SIZE, orig.h - dy);
    y = orig.y + orig.h - hh;
  }
  // Corner handles keep the aspect ratio of images.
  if (ratio && h.length === 2) {
    hh = Math.max(MIN_SIZE, w * ratio);
    if (h.includes('n')) y = orig.y + orig.h - hh;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
}

export function DeckEditor({ ctl, onImageFiles }: { ctl: DeckController; onImageFiles(files: File[]): void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const scale = Math.max(0.1, Math.min((size.w - 48) / SLIDE_W, (size.h - 48) / SLIDE_H));
  const slide = ctl.slide;
  const selected = ctl.selected;

  const beginDrag = (e: ReactMouseEvent, kind: Drag['kind'], ids: string[], handle?: Handle) => {
    const boxes: Record<string, Box> = {};
    const ratios: Record<string, number | null> = {};
    for (const el of slide.elements) {
      if (!ids.includes(el.id)) continue;
      boxes[el.id] = { x: el.x, y: el.y, w: el.w, h: el.h };
      ratios[el.id] = el.type === 'image' && el.w > 0 ? el.h / el.w : null;
    }
    const d: Drag = { kind, handle, startX: e.clientX, startY: e.clientY, boxes, ratios, preview: {}, moved: false };
    dragRef.current = d;
    setDrag(d);
  };

  // Window-level listeners while dragging, so fast mouse moves outside the slide still count.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.startX) / scale;
      const dy = (e.clientY - d.startY) / scale;
      const preview: Record<string, BoxPreview> = {};
      for (const id in d.boxes) {
        const b = d.boxes[id];
        preview[id] = d.kind === 'move' ? { x: Math.round(b.x + dx), y: Math.round(b.y + dy) } : resizeBox(b, d.handle!, dx, dy, e.shiftKey ? null : d.ratios[id]);
      }
      const next = { ...d, preview, moved: d.moved || Math.abs(dx) + Math.abs(dy) >= 1 };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d?.moved) return;
      ctl.updateElements(Object.keys(d.preview), (el) => ({ ...el, ...d.preview[el.id] }));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag, scale]);

  const onElementMouseDown = (e: ReactMouseEvent, el: SlideElement) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (ctl.editing === el.id) return;
    if (ctl.editing) ctl.stopEditing();
    // The default is prevented below (so a drag doesn't select text), which would leave focus in whatever
    // field had it; take it so Delete, arrows and ⌘Z reach the editor.
    wrapRef.current?.focus();
    let ids: string[];
    if (e.shiftKey) {
      ids = ctl.selection.includes(el.id) ? ctl.selection.filter((x) => x !== el.id) : [...ctl.selection, el.id];
      ctl.select(ids);
    } else {
      ids = ctl.selection.includes(el.id) ? ctl.selection : [el.id];
      if (ids !== ctl.selection) ctl.select(ids);
    }
    e.preventDefault();
    if (ids.length) beginDrag(e, 'move', ids);
  };

  const onElementDoubleClick = (_e: ReactMouseEvent, el: SlideElement) => {
    if (el.type === 'text' || el.type === 'shape') ctl.startEditing(el.id);
  };

  const editing = ctl.editing
    ? {
        id: ctl.editing,
        onCommit: (paragraphs: { text: string; bullet?: boolean; level?: number }[]) => {
          const id = ctl.editing!;
          ctl.updateElements([id], (el) => {
            if (el.type === 'text') return { ...el, paragraphs };
            if (el.type === 'shape') {
              const text = paragraphs.map((p) => p.text).join('\n').trim();
              const next = { ...el };
              if (text) next.text = text;
              else delete next.text;
              return next;
            }
            return el;
          });
        },
        onStop: () => ctl.stopEditing(),
      }
    : null;

  const single = selected.length === 1 && !ctl.editing ? selected[0] : null;
  const boxOf = (el: SlideElement): Box => ({ x: el.x, y: el.y, w: el.w, h: el.h, ...drag?.preview[el.id] });
  const hs = 10 / scale; // handles keep their screen size

  return (
    <div
      ref={wrapRef}
      className={`deck-canvas${drag ? ` dragging ${drag.kind}` : ''}`}
      tabIndex={-1}
      onMouseDown={(e) => {
        // A click on the backdrop or the slide background clears the selection.
        if (e.button === 0 && (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('slide') || (e.target as HTMLElement).classList.contains('slide-scaler'))) {
          if (ctl.editing) ctl.stopEditing();
          ctl.select([]);
          wrapRef.current?.focus();
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        onImageFiles(files);
      }}
    >
      <SlideView slide={slide} theme={ctl.deck.theme} scale={scale} preview={drag?.preview} editing={editing} onElementMouseDown={onElementMouseDown} onElementDoubleClick={onElementDoubleClick} className="deck-canvas-slide">
        {selected.map((el) => {
          const b = boxOf(el);
          return <div key={el.id} className="sl-outline" style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderWidth: 1.5 / scale }} />;
        })}
        {single &&
          (single.type === 'shape' && single.shape === 'line' ? ((single.h > single.w ? ['n', 's'] : ['e', 'w']) as Handle[]) : HANDLES).map((h) => {
            const b = boxOf(single);
            const p = handlePos(h, b);
            return (
              <div
                key={h}
                className={`sl-handle sl-handle-${h}`}
                style={{ left: p.left - hs / 2, top: p.top - hs / 2, width: hs, height: hs, borderWidth: 1 / scale }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  wrapRef.current?.focus();
                  beginDrag(e, 'resize', [single.id], h);
                }}
              />
            );
          })}
      </SlideView>
    </div>
  );
}
