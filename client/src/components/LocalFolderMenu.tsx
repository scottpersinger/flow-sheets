// The desktop app's folder button, left of the open folder's name over the file list: open another folder
// (the app's Open Folder dialog), or a file or folder by its path.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { PromptModal } from './Modal.tsx';

export function LocalFolderMenu({ onFile, onFolder }: {
  /** Show a file of the open folder, by its path there. */
  onFile(rel: string): void;
  /** Show a folder of the open folder, by its path there ('' for the top). */
  onFolder(rel: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="local-folder" ref={ref}>
      <button className="local-folder-btn" aria-label="Open a folder or file" title="Open a folder or file" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="home-more-menu local-folder-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAsking(true);
            }}
          >
            Open file by path…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void api.chooseLocalFolder();
            }}
          >
            Open Folder…
          </button>
        </div>
      )}
      {asking && (
        <PromptModal
          title="Open file by path"
          label="File or folder"
          initial=""
          placeholder="~/Documents/report.docx"
          maxLength={4096}
          confirmText="Open"
          onConfirm={async (p) => {
            const res = await api.openLocalPath(p);
            // Otherwise the app is switching folders and this window is about to be replaced.
            if (res.file !== undefined) onFile(res.file);
            else if (res.folder !== undefined) onFolder(res.folder);
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </span>
  );
}
