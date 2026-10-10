// The image editor's engine without its interface, for editing a picture that is not open: the assistant's
// transform_image on a stored file. It draws on a canvas kept off the screen. Loaded on demand, like the editor.
import type { AspBackgroundRemovalLoader, AspExportFormat } from '@ascentsparksoftware/react-image-editor';
import type { OpsEngine } from './imageOps.ts';
import { MAX_EDIT_IMAGE_DIM, MAX_EDIT_IMAGE_PIXELS } from './limits.ts';

const FORMATS: Record<string, AspExportFormat> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

export interface HiddenEngine {
  engine: OpsEngine;
  /** Flatten what has been done into a plain picture (see applyImageOps). */
  bake(): Promise<void>;
  /** The picture as it is now, as a file of this type (PNG for any type the editor does not write). */
  export(type: string): Promise<Blob>;
  close(): Promise<void>;
}

export async function openHiddenEngine(source: Blob, opts: { /** Makes remove_background available (see ImageEditorHost). */ backgroundRemovalLoader?: AspBackgroundRemovalLoader } = {}): Promise<HiddenEngine> {
  const { EditorEngine } = await import('@ascentsparksoftware/react-image-editor');
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:1024px;height:768px;visibility:hidden;pointer-events:none';
  holder.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  holder.append(canvas);
  document.body.append(holder);
  let engine;
  try {
    engine = await EditorEngine.create(canvas, {
      width: 1024,
      height: 768,
      exportBounds: 'image',
      maxImportDim: MAX_EDIT_IMAGE_DIM,
      maxExportPixels: MAX_EDIT_IMAGE_PIXELS,
      backgroundRemovalLoader: opts.backgroundRemovalLoader ?? null,
    });
    await engine.loadImage(source);
  } catch (e) {
    holder.remove();
    throw e;
  }
  const write = (format: AspExportFormat) => engine.exportImage(format, 92, [format]);
  return {
    engine,
    bake: async () => {
      const flat = await write('png');
      engine.clearCropRegion();
      engine.setOutputWidth(null);
      await engine.loadImage(flat);
    },
    export: (type) => write(FORMATS[type] ?? 'png'),
    close: async () => {
      // Fabric lets go of its canvas on the next animation frame, which a tab in the background never gets:
      // waiting for it there would hold the assistant's turn for as long as the tab stays hidden.
      await Promise.race([engine.destroy().catch(() => {}), new Promise((done) => setTimeout(done, 300))]);
      holder.remove();
    },
  };
}
