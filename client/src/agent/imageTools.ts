// The assistant's transform_image: exact edits to a stored picture (crop, rotate, text, shapes, redaction and so
// on) made by the image editor's own engine. If the picture is open in the editor the edits happen there, as one
// undo step, and nothing is saved until the user saves; otherwise a hidden engine edits the file's bytes and the
// result is saved as a copy or over the file. (edit_image, by contrast, has an image model redraw the picture.)
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { EDITABLE_IMAGE_TYPES, type StoredFile } from '../../../shared/types.ts';
import { activeImageEditor } from '../image/activeEditor.ts';
import type { HiddenEngine } from '../image/hiddenEngine.ts';
import { applyImageOps, ImageOpError, type ImageOp } from '../image/imageOps.ts';
import { ToolError } from './toolError.ts';

export const IMAGE_TOOLS: ReadonlySet<string> = new Set(['transform_image']);

export interface ImageToolEnv {
  readFile?(id: string): Promise<{ file: StoredFile; data: ArrayBuffer }>;
  openFile?(id: string): Promise<StoredFile>;
  /** Save an edited picture over a stored one, or as a new file next to it. */
  saveImage?(id: string, image: Blob): Promise<StoredFile>;
  saveImageCopy?(of: StoredFile, image: Blob): Promise<StoredFile>;
  /** The editor's engine off screen, over these bytes (hiddenEngine.ts); tests pass a stand-in. */
  openImageEngine?(source: Blob): Promise<HiddenEngine>;
}

/** True when the call would save over a file, which the user is asked about first. */
export function replacesImageFile(call: ClientToolCall): boolean {
  return call.name === 'transform_image' && call.input.save === 'replace' && !activeImageEditor(String(call.input.file_id));
}

const fixable = (e: unknown): never => {
  throw e instanceof ImageOpError ? new ToolError(e.message) : e;
};

/** `attach` shows Claude a picture after the tool results (clientTools' attachPicture). */
export async function runImageTool(call: ClientToolCall, env: ImageToolEnv, attach: (file: StoredFile, data: ArrayBuffer) => Promise<string>): Promise<string> {
  const i = call.input;
  const id = String(i.file_id);
  const ops = Array.isArray(i.operations) ? (i.operations as ImageOp[]) : [];
  if (!ops.length) throw new ToolError('Give at least one operation.');
  if (!env.readFile) throw new ToolError('Stored files are not available here.');

  // Open in the editor: edit there, where the user sees it and can undo it.
  const open = activeImageEditor(id);
  if (open) {
    const { file } = await env.readFile(id);
    const applied = await open.engine.batch('Assistant edit', () => applyImageOps(open.engine, ops)).catch(fixable).finally(() => open.refresh());
    const shown = await open.exportBlob();
    const image = await attach(file, await shown.arrayBuffer()).catch(() => 'Not attached.');
    return JSON.stringify({ edited: true, file_id: id, filename: file.filename, applied, size: open.engine.getOutputSize(), saved: false, note: 'Done in the editor the user has open, as one undo step. It is not saved until the user saves there; tell them so.', image });
  }

  const { file, data } = await env.readFile(id);
  if (!EDITABLE_IMAGE_TYPES.includes(file.type)) throw new ToolError(`${file.filename} cannot be edited: only PNG, JPEG and WebP pictures can.`);
  if (!env.openImageEngine || !env.saveImage || !env.saveImageCopy) throw new ToolError('Pictures cannot be edited here.');
  const hidden = await env.openImageEngine(new Blob([data], { type: file.type }));
  let result: Blob;
  let applied: string[];
  let size: { width: number; height: number } | null;
  try {
    applied = await applyImageOps(hidden.engine, ops, hidden.bake).catch(fixable);
    size = hidden.engine.getOutputSize();
    result = await hidden.export(file.type);
  } finally {
    await hidden.close();
  }
  const replace = i.save === 'replace';
  const saved = replace ? await env.saveImage(id, result) : await env.saveImageCopy(file, result);
  // Show the user the result, and Claude too; the edit stands even if either fails.
  let opened = false;
  let image = 'Not attached. Call view_image to look at it.';
  try {
    opened = !!(await env.openFile?.(saved.id));
    image = await attach(saved, await result.arrayBuffer());
  } catch {
    // Reported in the result.
  }
  const note = replace ? 'Saved over the file; the version before it is kept (the user can put it back with Undo save on the file).' : `A new file${opened ? ', open now' : ''}; the original is unchanged.`;
  return JSON.stringify({ edited: true, file_id: saved.id, filename: saved.filename, ...(replace ? {} : { source_file_id: id }), applied, size, saved: true, note, image });
}
