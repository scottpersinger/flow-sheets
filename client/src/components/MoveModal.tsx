import { useEffect, useState } from 'react';
import { folderTrail, parentFolder } from '../../../shared/folders.ts';
import { api, type FolderInfo } from '../api.ts';
import { FolderIcon } from './FileLibrary.tsx';
import { Modal } from './Modal.tsx';

/** Pick a folder to move a file into, by browsing from the folder it is in. */
export function MoveModal(props: { title: string; from: string; rootName: string; onMove(folder: string): Promise<void>; onClose(): void }) {
  const [at, setAt] = useState(props.from);
  const [folders, setFolders] = useState<FolderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    setFolders(null);
    api.library(at).then(
      (r) => !stale && setFolders(r.folders),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [at]);

  const name = at ? folderTrail(at).pop()!.name : props.rootName;
  return (
    <Modal title={`Move “${props.title}”`} onClose={props.onClose}>
      <div className="folder-picker">
        {at && (
          <button onClick={() => setAt(parentFolder(at))}>
            ← {parentFolder(at) ? folderTrail(parentFolder(at)).pop()!.name : props.rootName}
          </button>
        )}
        {folders === null ? (
          <div className="muted">Loading…</div>
        ) : folders.length === 0 ? (
          <div className="muted">No folders in “{name}”.</div>
        ) : (
          folders.map((f) => (
            <button key={f.path} onClick={() => setAt(f.path)}>
              <FolderIcon /> {f.name}
            </button>
          ))
        )}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || at === props.from}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await props.onMove(at);
              props.onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          Move to “{name}”
        </button>
      </div>
    </Modal>
  );
}
