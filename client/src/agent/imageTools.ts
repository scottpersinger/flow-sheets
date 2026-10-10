// The assistant's transform_image: exact edits to a stored picture (crop, rotate, text, shapes, redaction and so
// on) made by the image editor's own engine. If the picture is open in the editor the edits happen there, as one
// undo step, and nothing is saved until the user saves; otherwise a hidden engine edits the file's bytes and the
// result is saved as a copy or over the file. (edit_image, by contrast, has an image model redraw the picture.)
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { EDITABLE_IMAGE_TYPES, STORED_IMAGE_RE, type StoredFile } from '../../../shared/types.ts';
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
  /** The bytes of a stored image (/api/images/...), and storing a new one (resolves to its address). */
  readImage?(src: string): Promise<Blob>;
  uploadImage?(image: Blob): Promise<string>;
}

/** True when the call would save over a file, which the user is asked about first. */
export function replacesImageFile(call: ClientToolCall): boolean {
  return call.name === 'transform_image' && call.input.save === 'replace' && typeof call.input.file_id === 'string' && !!call.input.file_id && !activeImageEditor(call.input.file_id);
}

const fixable = (e: unknown): never => {
  throw e instanceof ImageOpError ? new ToolError(e.message) : e;
};

/** `attach` shows Claude a picture after the tool results (clientTools' attachPicture). */
export async function runImageTool(call: ClientToolCall, env: ImageToolEnv, attach: (file: StoredFile, data: ArrayBuffer) => Promise<string>): Promise<string> {
  const i = call.input;
  const ops = Array.isArray(i.operations) ? (i.operations as ImageOp[]) : [];
  if (!ops.length) throw new ToolError('Give at least one operation.');
  const hasFile = typeof i.file_id === 'string' && !!i.file_id;
  const hasImage = typeof i.image === 'string' && !!i.image;
  if (hasFile === hasImage) throw new ToolError('Give either file_id (a stored picture file) or image (the address of a picture inside a presentation, document or spreadsheet).');
  if (hasImage) return editEmbedded(String(i.image).trim(), ops, env, attach);
  const id = String(i.file_id);
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
  let transparentCopy = false;
  const replace = i.save === 'replace';
  try {
    applied = await applyImageOps(hidden.engine, ops, hidden.bake).catch(fixable);
    size = hidden.engine.getOutputSize();
    // A JPEG has no transparency: a copy whose background was removed is a PNG, so the background is gone
    // instead of black. Saved over the file, the picture keeps its type.
    transparentCopy = !replace && file.type === 'image/jpeg' && ops.some((op) => op.op === 'remove_background');
    result = await hidden.export(transparentCopy ? 'image/png' : file.type);
  } finally {
    await hidden.close();
  }
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
  const blackBackground = replace && file.type === 'image/jpeg' && ops.some((op) => op.op === 'remove_background');
  const note =
    (replace ? 'Saved over the file; the version before it is kept (the user can put it back with Undo save on the file).' : `A new file${opened ? ', open now' : ''}; the original is unchanged.`) +
    (transparentCopy ? ' It is a PNG, so the removed background is transparent.' : blackBackground ? ' The file is a JPEG, which has no transparency, so the removed background is black; save a copy instead to get a transparent PNG.' : '');
  return JSON.stringify({ edited: true, file_id: saved.id, filename: saved.filename, ...(replace ? {} : { source_file_id: id }), applied, size, saved: true, note, image });
}

/**
 * A picture inside a presentation, document or spreadsheet, by its stored address. It is never rewritten: the
 * edited picture is stored anew and its address returned for the model to put in place (which is an ordinary,
 * undoable edit of that file). Open in the image editor, it is edited there instead.
 */
async function editEmbedded(src: string, ops: ImageOp[], env: ImageToolEnv, attach: (file: StoredFile, data: ArrayBuffer) => Promise<string>): Promise<string> {
  if (!STORED_IMAGE_RE.test(src)) throw new ToolError('image must be a stored picture’s address (/api/images/...). A picture at a web address is saved first with import_file, and edited by its file_id.');
  // What attach needs to know of a picture that is not a file.
  const asFile = (address: string, type: string, size: number): StoredFile => ({ id: address, filename: 'picture', type, size, createdAt: '', url: address, downloadUrl: address });
  const open = activeImageEditor(src);
  if (open) {
    const applied = await open.engine.batch('Assistant edit', () => applyImageOps(open.engine, ops)).catch(fixable).finally(() => open.refresh());
    const shown = await open.exportBlob();
    const image = await attach(asFile(src, shown.type, shown.size), await shown.arrayBuffer()).catch(() => 'Not attached.');
    return JSON.stringify({ edited: true, image_address: src, applied, size: open.engine.getOutputSize(), saved: false, note: 'Done in the image editor the user has open on this picture, as one undo step. It goes into the file when the user saves there; tell them so.', image });
  }
  if (!env.readImage || !env.uploadImage || !env.openImageEngine) throw new ToolError('Pictures cannot be edited here.');
  const data = await env.readImage(src);
  if (!EDITABLE_IMAGE_TYPES.includes(data.type)) throw new ToolError('That picture cannot be edited: only PNG, JPEG and WebP pictures can.');
  const hidden = await env.openImageEngine(data);
  let result: Blob;
  let applied: string[];
  let size: { width: number; height: number } | null;
  try {
    applied = await applyImageOps(hidden.engine, ops, hidden.bake).catch(fixable);
    size = hidden.engine.getOutputSize();
    // Stored anew, so a picture whose background was removed can be a PNG whatever it was.
    result = await hidden.export(ops.some((op) => op.op === 'remove_background') ? 'image/png' : data.type);
  } finally {
    await hidden.close();
  }
  const address = await env.uploadImage(result);
  const image = await attach(asFile(address, result.type, result.size), await result.arrayBuffer()).catch(() => 'Not attached.');
  return JSON.stringify({
    edited: true,
    image_address: address,
    source_image: src,
    applied,
    size,
    saved: true,
    note: 'Stored as a new picture; nothing shows it yet. Put this address where the old one was: edit_elements (src) on a slide, set_cell_image in a cell, or insert_image in a document. If its shape changed (a crop or a turn), give the element a box of the new shape.',
    image,
  });
}
