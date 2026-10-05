// The list of slides on the left: click to edit, drag to reorder, right-click for slide commands.
import { useState, type MouseEvent } from 'react';
import { SLIDE_W, slideTitle } from '../../../shared/deck.ts';
import type { DeckController } from './controller.ts';
import { SlideView } from './SlideView.tsx';

const THUMB_W = 168;

export function ThumbnailStrip({ ctl, onContextMenu }: { ctl: DeckController; onContextMenu(e: MouseEvent, index: number): void }) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const scale = THUMB_W / SLIDE_W;
  return (
    <div className="deck-thumbs" role="listbox" aria-label="Slides">
      {ctl.deck.slides.map((s, i) => (
        <div
          key={s.id}
          role="option"
          aria-selected={i === ctl.current}
          className={`deck-thumb${i === ctl.current ? ' current' : ''}${over === i && dragFrom !== null && dragFrom !== i ? (dragFrom < i ? ' drop-after' : ' drop-before') : ''}`}
          title={slideTitle(s)}
          draggable
          onClick={() => ctl.goTo(i)}
          onContextMenu={(e) => {
            e.preventDefault();
            ctl.goTo(i);
            onContextMenu(e, i);
          }}
          onDragStart={(e) => {
            setDragFrom(i);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
          }}
          onDragOver={(e) => {
            if (dragFrom === null) return;
            e.preventDefault();
            setOver(i);
          }}
          onDragLeave={() => setOver((o) => (o === i ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && dragFrom !== i) ctl.moveSlide(dragFrom, i);
            setDragFrom(null);
            setOver(null);
          }}
          onDragEnd={() => {
            setDragFrom(null);
            setOver(null);
          }}
        >
          <span className="deck-thumb-num">{i + 1}</span>
          <div className="deck-thumb-pic">
            <SlideView slide={s} theme={ctl.deck.theme} scale={scale} />
          </div>
        </div>
      ))}
    </div>
  );
}
