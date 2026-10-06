import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent } from '../agent/AgentProvider.tsx';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { DeckIcon, DocIcon, Logo } from '../components/Logo.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { useFavicon } from '../favicon.ts';
import { checkImportFile, isPowerPointFile, isWordFile, pickImportFile, titleFromFileName } from '../importFile.ts';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  useFavicon('home');
  const [sheets, setSheets] = useState<SheetMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<'sheet' | 'deck' | 'doc' | null>(null);
  const [renaming, setRenaming] = useState<SheetMeta | null>(null);
  const [deleting, setDeleting] = useState<SheetMeta | null>(null);
  const [filter, setFilter] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const importFile = async (file: File) => {
    const problem = checkImportFile(file);
    if (problem) return setError(problem);
    setError(null);
    setImporting(file.name);
    try {
      if (isPowerPointFile(file)) {
        const { deck, warnings } = await api.importPptx(file, titleFromFileName(file.name));
        navigate(`/d/${deck.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isWordFile(file)) {
        const { doc, warnings } = await api.importDocx(file, titleFromFileName(file.name));
        navigate(`/doc/${doc.id}`, { state: { importWarnings: warnings } });
        return;
      }
      const { sheet, warnings } = await api.importXlsx(file, titleFromFileName(file.name));
      navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  // Spreadsheets, presentations and documents in one list, most recently edited first.
  const load = () =>
    Promise.all([api.listSheets(), api.listDecks(), api.listDocs()])
      .then(([s, d, t]) => setSheets([...s.sheets, ...d.decks, ...t.docs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))))
      .catch((e: Error) => setError(e.message));

  const pathOf = (s: SheetMeta) => (s.kind === 'deck' ? `/d/${s.id}` : s.kind === 'doc' ? `/doc/${s.id}` : `/s/${s.id}`);
  const KIND_NAMES = { sheet: 'spreadsheet', deck: 'presentation', doc: 'document' } as const;

  // Reload after the assistant finishes a request, in case it created a spreadsheet.
  const { running: agentRunning } = useAgent();
  useEffect(() => {
    if (!agentRunning) void load();
  }, [agentRunning]);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const q = filter.trim().toLowerCase();
  // Show each branch right under its original (recursively); searching flattens the list.
  const visible: { s: SheetMeta; depth: number }[] = [];
  if (sheets) {
    if (q) for (const s of sheets) s.title.toLowerCase().includes(q) && visible.push({ s, depth: 0 });
    else {
      const ids = new Set(sheets.map((s) => s.id));
      const children = new Map<string, SheetMeta[]>();
      for (const s of sheets) {
        const p = s.branch && ids.has(s.branch.parentId) ? s.branch.parentId : null;
        if (p) children.set(p, [...(children.get(p) ?? []), s]);
      }
      const add = (s: SheetMeta, depth: number) => {
        visible.push({ s, depth });
        for (const c of children.get(s.id) ?? []) add(c, depth + 1);
      };
      for (const s of sheets) if (!(s.branch && ids.has(s.branch.parentId))) add(s, 0);
    }
  }
  const [branching, setBranching] = useState<SheetMeta | null>(null);

  return (
    <div
      className={`home${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file && !importing) void importFile(file);
      }}
    >
      <header className="home-header">
        <div className="home-brand">
          <Logo />
          <span>Sheets</span>
        </div>
        <input className="home-search" placeholder="Search spreadsheets, presentations and documents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="home-user">
          <Link to="/connectors" className="home-changes" title="Connect data sources such as Brex">
            Connectors
          </Link>
          <Link to="/changes" className="home-changes" title="Changes the assistant made to the app">
            Changes
          </Link>
          <AgentButton />
          <span>{user?.email}</span>
          <button className="btn" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      <section className="home-new">
        <div className="home-inner">
          <h2>Start something new</h2>
          <div className="tiles">
            <div>
              <button className="new-sheet-tile" onClick={() => setCreating('sheet')} aria-label="Create a blank spreadsheet">
                <span className="plus">+</span>
              </button>
              <div className="tile-label">Blank spreadsheet</div>
            </div>
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
                aria-label="Import an Excel, PowerPoint or Word file"
              >
                <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="tile-label">Import Excel, PowerPoint or Word</div>
            </div>
          </div>
          <div className="tile-hint">You can also drop an Excel (.xlsx, .xls), PowerPoint (.pptx) or Word (.docx) file anywhere on this page.</div>
        </div>
      </section>

      <section className="home-inner">
        <h2>Your files</h2>
        {error && <div className="form-error">{error}</div>}
        {sheets === null ? (
          <div className="muted">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state">{sheets.length ? 'Nothing matches your search.' : 'No files yet. Create a spreadsheet, presentation or document to get started.'}</div>
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
              {visible.map(({ s, depth }) => (
                <tr key={s.id} onClick={() => navigate(pathOf(s))}>
                  <td>
                    <Link to={pathOf(s)} className="sheet-title" onClick={(e) => e.stopPropagation()}>
                      <span style={{ width: depth * 22 }} className="tree-indent" />
                      {depth > 0 ? <span className="tree-elbow">└</span> : null}
                      {s.kind === 'deck' ? <DeckIcon size={18} /> : s.kind === 'doc' ? <DocIcon size={18} /> : <Logo size={18} />} {s.title}
                      {s.branch && <span className={`branch-tag${s.branch.detached ? ' detached' : ''}`}>{s.branch.detached ? `branch of deleted “${s.branch.parentTitle}”` : depth ? 'branch' : `branch of ${s.branch.parentTitle}`}</span>}
                    </Link>
                  </td>
                  <td>{formatWhen(s.updatedAt)}</td>
                  <td>{formatWhen(s.createdAt)}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      aria-label={`Actions for ${s.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor(menuFor === s.id ? null : s.id);
                      }}
                    >
                      ⋮
                    </button>
                    {menuFor === s.id && (
                      <div className="dropdown">
                        <button onClick={() => navigate(pathOf(s))}>Open</button>
                        <button onClick={() => (setMenuFor(null), window.open(pathOf(s), '_blank'))}>Open in new tab</button>
                        <button onClick={() => (setMenuFor(null), setRenaming(s))}>Rename</button>
                        {s.kind === 'sheet' && <button onClick={() => (setMenuFor(null), setBranching(s))}>Create branch</button>}
                        <button className="danger" onClick={() => (setMenuFor(null), setDeleting(s))}>
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
      {dragOver && !importing && <div className="drop-hint">Drop an Excel, PowerPoint or Word file to import it</div>}
      {creating === 'sheet' && (
        <PromptModal
          title="New spreadsheet"
          label="Name"
          initial="Untitled spreadsheet"
          confirmText="Create"
          onConfirm={async (title) => {
            const { sheet } = await api.createSheet(title);
            navigate(`/s/${sheet.id}`);
          }}
          onClose={() => setCreating(null)}
        />
      )}
      {creating === 'deck' && (
        <PromptModal
          title="New presentation"
          label="Name"
          initial="Untitled presentation"
          confirmText="Create"
          onConfirm={async (title) => {
            const { deck } = await api.createDeck(title);
            navigate(`/d/${deck.id}`);
          }}
          onClose={() => setCreating(null)}
        />
      )}
      {creating === 'doc' && (
        <PromptModal
          title="New document"
          label="Name"
          initial="Untitled document"
          confirmText="Create"
          onConfirm={async (title) => {
            const { doc } = await api.createDoc(title);
            navigate(`/doc/${doc.id}`);
          }}
          onClose={() => setCreating(null)}
        />
      )}
      {branching && (
        <PromptModal
          title="Create branch"
          label="Branch name"
          initial={`${branching.title} (branch)`}
          confirmText="Create branch"
          onConfirm={async (title) => {
            const { sheet } = await api.branchSheet(branching.id, title);
            navigate(`/s/${sheet.id}`);
          }}
          onClose={() => setBranching(null)}
        />
      )}
      {renaming && (
        <PromptModal
          title={`Rename ${KIND_NAMES[renaming.kind]}`}
          label="Name"
          initial={renaming.title}
          confirmText="Rename"
          onConfirm={async (title) => {
            await (renaming.kind === 'deck' ? api.renameDeck(renaming.id, title) : renaming.kind === 'doc' ? api.renameDoc(renaming.id, title) : api.renameSheet(renaming.id, title));
            await load();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${KIND_NAMES[deleting.kind]}?`}
          message={
            <>
              “{deleting.title}” will be permanently deleted. This cannot be undone.
            </>
          }
          confirmText="Delete"
          danger
          onConfirm={async () => {
            await (deleting.kind === 'deck' ? api.deleteDeck(deleting.id) : deleting.kind === 'doc' ? api.deleteDoc(deleting.id) : api.deleteSheet(deleting.id));
            await load();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
