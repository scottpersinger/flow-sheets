// Sizes the image editor works at. Kept apart from the editor so they can be used without loading it.

/** Longest side a picture keeps in the editor, in pixels; a larger one is scaled down to this when it opens. */
export const MAX_EDIT_IMAGE_DIM = 8192;
/** Most pixels an edited picture is saved with. */
export const MAX_EDIT_IMAGE_PIXELS = 64_000_000;

/** The size a picture has in the editor: its own, or scaled down so its longest side fits. */
export function editSize(width: number, height: number): { width: number; height: number; reduced: boolean } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDIT_IMAGE_DIM) return { width, height, reduced: false };
  const scale = MAX_EDIT_IMAGE_DIM / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), reduced: true };
}

/** The name of an edited copy of a picture, of the same type: "logo.jpg" becomes "logo-edited.jpg". */
export function editedCopyName(filename: string): string {
  const ext = /\.[a-z0-9]+$/i.exec(filename)?.[0] ?? '';
  return `${filename.slice(0, filename.length - ext.length).replace(/-edited$/, '')}-edited${ext}`;
}
