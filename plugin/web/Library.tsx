// The library, laid out like the app's home page: a search box, "Start something new" tiles for the kinds
// the plugin supports, and the files table with rename and delete.
import { useEffect, useState } from 'react';
import { DeckIcon, DocIcon } from '../../client/src/components/Logo.tsx';
import { ConfirmModal, Modal, PromptModal } from '../../client/src/components/Modal.tsx';
import type { FileKind, Host } from './host.ts';

interface FileSummary {
  kind: FileKind;
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
}

const KIND_NAMES = { doc: 'document', deck: 'presentation' } as const;
const IMPORT_TYPES = ['.docx', '.pptx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];

function pickImportFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMPORT_TYPES.join(',');
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

const titleFromFileName = (name: string) => name.replace(/\.[^.]+$/, '').trim() || 'Imported file';

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
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<{ file: FileSummary; warnings: string[] } | null>(null);

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

  /** Import: a one-time ticket from the server, then the bytes go straight to its import route. */
  const importFile = async (file: File) => {
    if (!/\.(docx|pptx)$/i.test(file.name)) return setError('Choose a Word document (.docx) or PowerPoint presentation (.pptx).');
    setError(null);
    setImporting(file.name);
    try {
      const { ticket, url } = await host.call<{ ticket: string; url: string }>('upload_ticket');
      const q = new URLSearchParams({ ticket, name: file.name, title: titleFromFileName(file.name) });
      const res = await fetch(`${url}?${q}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      const body = (await res.json()) as { file?: FileSummary; warnings?: string[]; error?: string };
      if (!res.ok || !body.file) throw new Error(body.error ?? `Import failed (${res.status}).`);
      if (body.warnings?.length) setImported({ file: body.file, warnings: body.warnings });
      else onOpen({ kind: body.file.kind, id: body.file.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
    }
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
            <div>
              <button
                className="new-sheet-tile import-tile"
                disabled={!!importing}
                onClick={async () => {
                  const file = await pickImportFile();
                  if (file) void importFile(file);
                }}
                aria-label="Import a Word or PowerPoint file"
              >
                <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="tile-label">Import Word or PowerPoint</div>
            </div>
          </div>
          <div className="tile-hint">You can also attach a Word or PowerPoint file in the chat and ask ChatGPT to import it, or ask it to write something new.</div>
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

      {importing && (
        <div className="modal-backdrop">
          <div className="modal import-progress" role="status">
            <div className="spinner" />
            Importing “{importing}”…
          </div>
        </div>
      )}
      {imported && (
        <Modal title="Imported with some changes" onClose={() => (setImported(null), onOpen({ kind: imported.file.kind, id: imported.file.id }))}>
          <ul>
            {imported.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => (setImported(null), onOpen({ kind: imported.file.kind, id: imported.file.id }))}>
              Open
            </button>
          </div>
        </Modal>
      )}
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
