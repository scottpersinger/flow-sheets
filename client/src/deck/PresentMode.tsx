// Full-screen slideshow. Arrow keys, space and clicks move between slides; N shows the speaker notes;
// Escape leaves.
import { useEffect, useState } from 'react';
import { SLIDE_H, SLIDE_W } from '../../../shared/deck.ts';
import type { DeckController } from './controller.ts';
import { SlideView } from './SlideView.tsx';

const NOTES_HEIGHT = 0.28; // share of the window given to the notes panel

export function PresentMode({ ctl, onExit }: { ctl: DeckController; onExit(): void }) {
  const [index, setIndex] = useState(ctl.current);
  const [notes, setNotes] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const n = ctl.deck.slides.length;

  useEffect(() => {
    const el = document.querySelector('.present');
    if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    const onFs = () => {
      if (!document.fullscreenElement) onExit();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, [onExit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
      else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) setIndex((i) => Math.min(n - 1, i + 1));
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(n - 1);
      else if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey) setNotes((v) => !v);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [n, onExit]);

  // Leave the editor on the slide the show ended on.
  useEffect(() => () => ctl.goTo(index), [ctl, index]);

  const slideArea = notes ? size.h * (1 - NOTES_HEIGHT) : size.h;
  const scale = Math.min(size.w / SLIDE_W, slideArea / SLIDE_H);
  const slide = ctl.deck.slides[Math.min(index, n - 1)];
  const next = ctl.deck.slides[index + 1];
  return (
    <div className={`present${notes ? ' with-notes' : ''}`} onClick={() => setIndex((i) => Math.min(n - 1, i + 1))} role="presentation">
      <div className="present-stage" style={{ height: slideArea }}>
        <SlideView slide={slide} theme={ctl.deck.theme} scale={scale} />
      </div>
      {notes && (
        <div className="present-notes" style={{ height: size.h - slideArea }} onClick={(e) => e.stopPropagation()}>
          <div className="present-notes-text">{slide.notes?.trim() ? slide.notes : <span className="present-notes-empty">No notes for this slide.</span>}</div>
          <div className="present-next">
            <div className="present-next-label">{next ? `Next: slide ${index + 2}` : 'Last slide'}</div>
            {next && <SlideView slide={next} theme={ctl.deck.theme} scale={Math.min(220 / SLIDE_W, ((size.h - slideArea) * 0.6) / SLIDE_H)} />}
          </div>
        </div>
      )}
      <div className="present-counter">
        {index + 1} / {n}
      </div>
      <div className="present-controls" onClick={(e) => e.stopPropagation()}>
        <button className={`present-notes-btn${notes ? ' active' : ''}`} onClick={() => setNotes(!notes)} title="Speaker notes (N)" aria-pressed={notes}>
          Notes
        </button>
        <button className="present-exit" onClick={onExit} title="Exit (Esc)" aria-label="Exit presentation">
          ×
        </button>
      </div>
    </div>
  );
}
