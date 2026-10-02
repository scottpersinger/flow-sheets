import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { SheetMeta } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Logo } from '../components/Logo.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { checkExcelFile, pickExcelFile, titleFromFileName } from '../importFile.ts';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sheets, setSheets] = useState<SheetMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<SheetMeta | null>(null);
  const [deleting, setDeleting] = useState<SheetMeta | null>(null);
  const [filter, setFilter] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const importFile = async (file: File) => {
    const problem = checkExcelFile(file);
    if (problem) return setError(problem);
    setError(null);
    setImporting(file.name);
    try {
      const { sheet, warnings } = await api.importXlsx(file, titleFromFileName(file.name));
      navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  const load = () =>
    api
      .listSheets()
      .then((r) => setSheets(r.sheets))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

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
        <input className="home-search" placeholder="Search spreadsheets" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="home-user">
          <span>{user?.email}</span>
          <button className="btn" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      <section className="home-new">
        <div className="home-inner">
          <h2>Start a new spreadsheet</h2>
          <div className="tiles">
            <div>
              <button className="new-sheet-tile" onClick={() => setCreating(true)} aria-label="Create a blank spreadsheet">
                <span className="plus">+</span>
              </button>
              <div className="tile-label">Blank spreadsheet</div>
            </div>
            <div>
              <button
                className="new-sheet-tile import-tile"
                disabled={!!importing}
                onClick={async () => {
                  const file = await pickExcelFile();
                  if (file) void importFile(file);
                }}
                aria-label="Import an Excel file"
              >
                <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="tile-label">Import Excel (.xlsx, .xls)</div>
            </div>
          </div>
          <div className="tile-hint">You can also drop an Excel file anywhere on this page.</div>
        </div>
      </section>

      <section className="home-inner">
        <h2>Your spreadsheets</h2>
        {error && <div className="form-error">{error}</div>}
        {sheets === null ? (
          <div className="muted">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state">{sheets.length ? 'No spreadsheets match your search.' : 'No spreadsheets yet. Create one to get started.'}</div>
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
                <tr key={s.id} onClick={() => navigate(`/s/${s.id}`)}>
                  <td>
                    <Link to={`/s/${s.id}`} className="sheet-title" onClick={(e) => e.stopPropagation()}>
                      <span style={{ width: depth * 22 }} className="tree-indent" />
                      {depth > 0 ? <span className="tree-elbow">└</span> : null}
                      <Logo size={18} /> {s.title}
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
                        <button onClick={() => navigate(`/s/${s.id}`)}>Open</button>
                        <button onClick={() => (setMenuFor(null), window.open(`/s/${s.id}`, '_blank'))}>Open in new tab</button>
                        <button onClick={() => (setMenuFor(null), setRenaming(s))}>Rename</button>
                        <button onClick={() => (setMenuFor(null), setBranching(s))}>Create branch</button>
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
      {dragOver && !importing && <div className="drop-hint">Drop an Excel file to import it</div>}
      {creating && (
        <PromptModal
          title="New spreadsheet"
          label="Name"
          initial="Untitled spreadsheet"
          confirmText="Create"
          onConfirm={async (title) => {
            const { sheet } = await api.createSheet(title);
            navigate(`/s/${sheet.id}`);
          }}
          onClose={() => setCreating(false)}
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
          title="Rename spreadsheet"
          label="Name"
          initial={renaming.title}
          confirmText="Rename"
          onConfirm={async (title) => {
            await api.renameSheet(renaming.id, title);
            await load();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete spreadsheet?"
          message={
            <>
              “{deleting.title}” will be permanently deleted. This cannot be undone.
            </>
          }
          confirmText="Delete"
          danger
          onConfirm={async () => {
            await api.deleteSheet(deleting.id);
            await load();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
