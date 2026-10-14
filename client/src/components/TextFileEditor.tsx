// A stored file that is plain text (StoredFile.text: UTF-8, which ASCII is, found by looking at its bytes),
// edited as text whatever its name: a log, a config file, source code, a file with no extension. Saved with
// the Save button or Cmd/Ctrl+S, over the file (the server keeps the version before for one undo), with the
// line endings and byte order mark it had.
import { useEffect, useRef, useState } from 'react';
import type { StoredFile } from '../../../shared/types.ts';
import { api } from '../api.ts';

const BOM = '﻿';

export function TextFileEditor({ file, onSaved }: { file: StoredFile; onSaved(file: StoredFile): void }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  // How the file was written, so a save keeps it: Windows line ends, a byte order mark.
  const form = useRef({ crlf: false, bom: false });
  const dirty = text !== null && text !== saved;

  useEffect(() => {
    let gone = false;
    fetch(file.url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
        const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
        if (gone) return;
        const bom = raw.startsWith(BOM);
        const body = bom ? raw.slice(1) : raw;
        form.current = { crlf: /\r\n/.test(body), bom };
        // The text area works in \n; the file's own line ends come back when it is saved.
        const lf = body.replace(/\r\n/g, '\n');
        setText(lf);
        setSaved(lf);
      })
      .catch((e: unknown) => !gone && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [file.url]);

  const save = async () => {
    if (text === null || !dirty || state === 'saving') return;
    setState('saving');
    setError(null);
    try {
      const body = (form.current.bom ? BOM : '') + (form.current.crlf ? text.replace(/\n/g, '\r\n') : text);
      const updated = await api.updateFile(file.id, body);
      setSaved(text);
      setState('saved');
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('idle');
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return (
    <div className="text-file">
      <div className="text-file-bar">
        <span className="save-status">{state === 'saving' ? 'Saving…' : dirty ? 'Unsaved changes' : state === 'saved' ? 'Saved' : 'Plain text'}</span>
        <button className="btn primary" disabled={!dirty || state === 'saving'} onClick={() => void save()} title="Save (⌘S)">
          Save
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {text === null ? (
        !error && <div className="muted text-file-wait">Loading…</div>
      ) : (
        <textarea
          className="md-editor text-file-editor"
          value={text}
          onChange={(e) => (setText(e.target.value), state === 'saved' && setState('idle'))}
          spellCheck={false}
          autoFocus
          aria-label={file.filename}
          onKeyDown={(e) => {
            // Tab types a tab, as in any text editor.
            if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${el.value.slice(0, a)}\t${el.value.slice(b)}`;
            setText(next);
            requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
          }}
        />
      )}
    </div>
  );
}
