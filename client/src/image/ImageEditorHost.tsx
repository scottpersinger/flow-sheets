// The image editor itself: our fork of react-image-editor (github.com/freeflow-community/react-image-editor), on
// Fabric.js. It is in a module of its own, loaded only when a picture is edited, so the editor, its stylesheet
// and Fabric stay out of the app's first load. It knows nothing about where the picture came from or where it
// is saved: the surface that opens it (an image file, later a picture in a document) supplies both.
import { useMemo } from 'react';
import { ImageEditor, type AspEditorError, type AspEditorHandle, type AspExportFormat } from '@ascentsparksoftware/react-image-editor';
import '@ascentsparksoftware/react-image-editor/styles.css';
import { MAX_EDIT_IMAGE_DIM, MAX_EDIT_IMAGE_PIXELS } from './limits.ts';

const FORMATS: Record<string, AspExportFormat> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

export interface ImageEditorHostProps {
  source: Blob;
  /** The type the edited picture is delivered as (PNG, JPEG or WebP); anything else gives PNG. */
  type: string;
  /** The editor's engine, each time the picture has loaded into it; `exportBlob()` gives the edited picture. */
  onReady(handle: AspEditorHandle): void;
  onError(message: string): void;
}

export default function ImageEditorHost({ source, type, onReady, onError }: ImageEditorHostProps) {
  const formats = useMemo(() => [FORMATS[type] ?? 'png'], [type]);
  return (
    <ImageEditor
      src={source}
      mode="advanced"
      // The picture itself at its own size, not the editing surface at the size it is drawn on screen.
      exportBounds="image"
      maxImportDim={MAX_EDIT_IMAGE_DIM}
      maxExportPixels={MAX_EDIT_IMAGE_PIXELS}
      exportFormats={formats}
      exportQuality={92}
      accentColor="#1a73e8"
      onReady={onReady}
      onError={(e: AspEditorError) => onError(e.message)}
    />
  );
}
