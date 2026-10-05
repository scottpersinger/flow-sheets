// Browser side of the PowerPoint export: loads the deck's images as data URLs and saves the file.
import { buildPptx } from '../../../shared/pptxExport.ts';
import type { Deck } from '../../../shared/deck.ts';

async function loadImage(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return src;
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null; // cross-origin images without CORS headers end up here
  }
}

/** Download the deck as <title>.pptx. Resolves with warnings about anything that could not be exported. */
export async function downloadPptx(deck: Deck, title: string): Promise<string[]> {
  const { pres, warnings } = await buildPptx(deck, title, loadImage);
  await pres.writeFile({ fileName: `${title.replace(/[\\/:*?"<>|]+/g, '-')}.pptx` });
  return warnings;
}
