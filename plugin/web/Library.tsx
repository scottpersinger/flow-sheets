// The library, laid out like the app's home page: a search box, "Start something new" tiles for the kinds
// the plugin supports, and the files table with rename and delete.
import { useEffect, useState } from 'react';
import { DeckIcon, DocIcon } from '../../client/src/components/Logo.tsx';
import { ConfirmModal, PromptModal } from '../../client/src/components/Modal.tsx';
import type { FileKind, Host } from './host.ts';

interface FileSummary {
  kind: FileKind;
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
}

const KIND_NAMES = { doc: 'document', deck: 'presentation' } as const;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function Library({ host, onOpen }: { host: Host; onOpen(file: { kind: FileKind; id: string }): void }) {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<FileKind | null>(null);
  const [renaming, setRenaming] = useState<FileSummary | null>(null);
  const [deleting, setDeleting] = useState<FileSummary | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const load = () =>
    host
      .call<{ files: FileSummary[] }>('list_files')
      .then((r) => setFiles(r.files))
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), [host]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuFor]);

  const create = async (kind: FileKind, title: string) => {
    const r = await host.call<{ file: FileSummary }>(kind === 'doc' ? 'create_doc' : 'create_deck', { title });
    onOpen({ kind, id: r.file.id });
  };

  const q = filter.trim().toLowerCase();
  const visible = (files ?? []).filter((f) => !q || f.title.toLowerCase().includes(q));

  return (
    <div className="home docs-library">
      <header className="home-header">
        <div className="home-brand">
          <DocIcon size={28} />
          <span>Docs</span>
        </div>
        <input className="home-search" placeholder="Search presentations and documents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="home-user">
          <button className="btn" onClick={() => void host.ask('What documents and presentations do I have? List them with a one-line summary each.')}>
            Ask about my files
          </button>
        </div>
      </header>

      <section className="home-new">
        <div className="home-inner">
          <h2>Start something new</h2>
          <div className="tiles">
            <div>
              <button className="new-sheet-tile deck-tile" onClick={() => setCreating('deck')} aria-label="Create a blank presentation">
                <span className="plus">+</span>
              </button>
              <div className="tile-label">Blank presentation</div>
            </div>
            <div>
              <button className="new-sheet-tile doc-tile" onClick={() => setCreating('doc')} aria-label="Create a blank document">
                <span className="plus">+</span>
              </button>
              <div className="tile-label">Blank document</div>
            </div>
          </div>
          <div className="tile-hint">Or ask ChatGPT: “write me a one-page brief about…” or “make a five-slide deck on…”.</div>
        </div>
      </section>

      <section className="home-inner">
        <h2>Your files</h2>
        {error && <div className="form-error">{error}</div>}
        {files === null ? (
          <div className="muted">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state">{files.length ? 'Nothing matches your search.' : 'No files yet. Create a presentation or document to get started.'}</div>
        ) : (
          <table className="sheet-list">
            <thead>
              <tr>
                <th>Name</th>
                <th>Last modified</th>
                <th>Created</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map((f) => (
                <tr key={f.id} onClick={() => onOpen({ kind: f.kind, id: f.id })}>
                  <td>
                    <span className="sheet-title">
                      {f.kind === 'deck' ? <DeckIcon size={18} /> : <DocIcon size={18} />} {f.title}
                    </span>
                  </td>
                  <td>{formatWhen(f.updated_at)}</td>
                  <td>{formatWhen(f.created_at)}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      aria-label={`Actions for ${f.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(menuFor === f.id ? null : f.id);
                      }}
                    >
                      ⋮
                    </button>
                    {menuFor === f.id && (
                      <div className="dropdown">
                        <button onClick={() => onOpen({ kind: f.kind, id: f.id })}>Open</button>
                        <button onClick={() => (setMenuFor(null), setRenaming(f))}>Rename</button>
                        <button className="danger" onClick={() => (setMenuFor(null), setDeleting(f))}>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {creating && (
        <PromptModal
          title={`New ${KIND_NAMES[creating]}`}
          label="Name"
          initial={creating === 'doc' ? 'Untitled document' : 'Untitled presentation'}
          confirmText="Create"
          onConfirm={(title) => create(creating, title)}
          onClose={() => setCreating(null)}
        />
      )}
      {renaming && (
        <PromptModal
          title={`Rename ${KIND_NAMES[renaming.kind]}`}
          label="Name"
          initial={renaming.title}
          confirmText="Rename"
          onConfirm={async (title) => {
            await host.call('rename_file', { kind: renaming.kind, id: renaming.id, title });
            await load();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${KIND_NAMES[deleting.kind]}?`}
          message={<>“{deleting.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            await host.call('delete_file', { kind: deleting.kind, id: deleting.id });
            await load();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
