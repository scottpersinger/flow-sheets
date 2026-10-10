// A stored picture being edited: the image editor over the file's bytes, with Save (over the file, keeping the
// version before for one revert), Save a copy (a new file next to it) and Close.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AspEditorHandle } from '@ascentsparksoftware/react-image-editor';
import type { StoredFile } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ConfirmModal } from '../components/Modal.tsx';
import { setActiveImageEditor } from './activeEditor.ts';
import { editedCopyName, editSize } from './limits.ts';
import { hasTransparency, pngName } from './transparency.ts';

const ImageEditorHost = lazy(() => import('./ImageEditorHost.tsx'));
const loadBackgroundRemoval = () => import('@imgly/background-removal');

export function ImageFileEditor({ file, onSaved, onCopied, onClose }: { file: StoredFile; /** The file was saved over. */ onSaved(file: StoredFile): void; /** A copy was made. */ onCopied(file: StoredFile): void; onClose(): void }) {
  const [source, setSource] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Said when the picture is too large to be edited at its own size. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null);
  const [ready, setReady] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const handle = useRef<AspEditorHandle | null>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      const res = await fetch(file.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Could not read the picture (${res.status})`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const size = editSize(bitmap.width, bitmap.height);
      const was = `${bitmap.width} × ${bitmap.height}`;
      bitmap.close();
      if (stop) return;
      if (size.reduced) setNotice(`This picture (${was}) is larger than the editor works with. It is edited, and saved, at ${size.width} × ${size.height}.`);
      // The editor is told the file's type, whatever the browser made of the response.
      setSource(blob.type === file.type ? blob : new Blob([blob], { type: file.type }));
    })().catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [file.url, file.type]);

  // While the editor is open the assistant's transform_image edits in it instead of the file.
  const onReady = useCallback(
    (h: AspEditorHandle) => {
      handle.current = h;
      setActiveImageEditor({ fileId: file.id, handle: h });
      setReady(true);
    },
    [file.id],
  );
  useEffect(() => () => setActiveImageEditor(null), [file.id]);

  const run = async (what: 'save' | 'copy') => {
    const h = handle.current;
    if (!h || busy) return;
    setBusy(what);
    setError(null);
    try {
      // A JPEG cannot be see-through: where the edit made the picture transparent (a removed background, the
      // corners of a straightened photo) it is saved as a PNG next to the JPEG, which stays as it was.
      const png = file.type === 'image/jpeg' ? await h.engine.exportImage('png', 100, ['png']) : null;
      if (png && (await hasTransparency(png))) onCopied(await api.uploadFile(what === 'save' ? pngName(file.filename) : editedCopyName(file.filename, 'image/png'), png, file.folder));
      else {
        const blob = await h.exportBlob();
        if (what === 'save') onSaved(await api.updateImageFile(file.id, blob));
        else onCopied(await api.uploadFile(editedCopyName(file.filename), blob, file.folder));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const close = () => {
    const engine = handle.current?.engine;
    if (engine && (engine.canUndo || engine.hasCropRegion())) setConfirmClose(true);
    else onClose();
  };

  return (
    <div className="image-editor">
      <div className="html-editor-bar">
        <span className="muted">{error ? <span className="form-error">{error}</span> : (notice ?? (file.type === 'image/jpeg' ? 'Save replaces the picture; the version before it is kept. With a transparent background it is saved as a PNG next to this JPEG.' : 'Save replaces the picture; the version before it is kept.'))}</span>
        <span className="html-editor-space" />
        <button className="btn" disabled={busy !== null} onClick={close}>
          Close
        </button>
        <button className="btn" disabled={!ready || busy !== null} onClick={() => void run('copy')} title="Keep this picture as it is and save the edited one as a new file next to it">
          {busy === 'copy' ? 'Saving…' : 'Save a copy'}
        </button>
        <button className="btn primary" disabled={!ready || busy !== null} onClick={() => void run('save')}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="image-editor-stage">
        {source ? (
          <Suspense fallback={<div className="muted">Loading the editor…</div>}>
            <ImageEditorHost source={source} type={file.type} onReady={onReady} onError={setError} backgroundRemovalLoader={loadBackgroundRemoval} />
          </Suspense>
        ) : (
          !error && <div className="muted">Loading…</div>
        )}
      </div>
      {confirmClose && <ConfirmModal title="Close without saving?" message="The changes to this picture have not been saved." confirmText="Discard changes" danger onConfirm={onClose} onClose={() => setConfirmClose(false)} />}
    </div>
  );
}
