// Load web fonts a deck uses (imported PowerPoint decks often use Inter, Poppins, ...). Only fonts known to be on
// Google Fonts are requested; anything else falls back to the theme font.
import { useEffect } from 'react';
import type { Deck } from '../../../shared/deck.ts';

const GOOGLE_FONTS = new Set([
  'Inter',
  'Poppins',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Oswald',
  'Raleway',
  'Nunito',
  'Nunito Sans',
  'Playfair Display',
  'Merriweather',
  'Source Sans 3',
  'Work Sans',
  'DM Sans',
  'Manrope',
  'Space Grotesk',
  'Rubik',
  'Ubuntu',
  'PT Sans',
  'Noto Sans',
  'Fira Sans',
  'Quicksand',
  'Karla',
  'Josefin Sans',
  'Libre Baskerville',
  'Lora',
  'Barlow',
  'Mulish',
  'IBM Plex Sans',
]);

const loaded = new Set<string>();

/** Fonts named anywhere in the deck. */
export function fontsIn(deck: Deck): string[] {
  const out = new Set<string>();
  for (const s of deck.slides) {
    for (const e of s.elements) {
      if (e.type === 'shape' && e.textFont) out.add(e.textFont);
      if (e.type !== 'text') continue;
      if (e.style?.font) out.add(e.style.font);
      for (const p of e.paragraphs) if (p.font) out.add(p.font);
    }
  }
  return [...out];
}

/** Add a Google Fonts stylesheet for each font the deck uses that we know is available there. */
export function ensureFonts(fonts: string[]): void {
  const wanted = fonts.filter((f) => GOOGLE_FONTS.has(f) && !loaded.has(f));
  if (!wanted.length) return;
  for (const f of wanted) loaded.add(f);
  const families = wanted.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,900;1,400`).join('&');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  document.head.appendChild(link);
}

export function useDeckFonts(deck: Deck): void {
  const key = fontsIn(deck).sort().join('|');
  useEffect(() => {
    if (key) ensureFonts(key.split('|'));
  }, [key]);
}
