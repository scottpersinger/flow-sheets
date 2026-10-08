// The file library: the header with search, the "Start something new" tiles, and the files table with a
// per-row menu, plus the create, rename and delete prompts and the import progress. It is the home page
// of the app (client/src/pages/HomePage.tsx) and the library inside ChatGPT (plugin/web/Library.tsx);
// each passes its own data source, actions and header controls, so both look and behave the same.
import { useEffect, useState, type ReactNode } from 'react';
import type { SheetMeta } from '../../../shared/types.ts';
import { DeckIcon, DocIcon, Logo, MarkdownIcon } from './Logo.tsx';
import { ConfirmModal, PromptModal } from './Modal.tsx';

/** What a row can be: a spreadsheet, presentation, document or Markdown document, or a stored file such as a PDF. */
export type LibraryKind = SheetMeta['kind'] | 'file';

export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  /** A spreadsheet stored as a CSV file. */
  format?: SheetMeta['format'];
  title: string;
  updatedAt: string;
  createdAt: string;
  branch?: SheetMeta['branch'];
}

export interface LibraryAction {
  label: string;
  onClick(): void | Promise<void>;
  danger?: boolean;
}

export const KIND_NAMES: Record<LibraryKind, string> = { sheet: 'spreadsheet', deck: 'presentation', doc: 'document', markdown: 'Markdown document', file: 'file' };

/** The Type column: a short label per kind (stored files show their file type). */
export function kindLabel(item: Pick<LibraryItem, 'kind' | 'title' | 'format'>): string {
  if (item.format === 'csv') return 'CSV';
  if (item.kind === 'file') {
    const ext = /\.([a-z0-9]+)$/i.exec(item.title)?.[1];
    return ext ? ext.toUpperCase() : 'File';
  }
  return { sheet: 'Spreadsheet', deck: 'Presentation', doc: 'Document', markdown: 'Markdown' }[item.kind];
}

export type SortKey = 'title' | 'kind' | 'updatedAt' | 'createdAt';
export interface SortOrder {
  key: SortKey;
  dir: 'asc' | 'desc';
}
const DEFAULT_SORT: SortOrder = { key: 'updatedAt', dir: 'desc' };
const SORT_STORAGE_KEY = 'ui.fileSort';

function loadSort(): SortOrder {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? 'null') as Partial<SortOrder> | null;
    if (raw && ['title', 'kind', 'updatedAt', 'createdAt'].includes(raw.key as string) && (raw.dir === 'asc' || raw.dir === 'desc')) return raw as SortOrder;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SORT;
}

function saveSort(sort: SortOrder): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Not remembered, that's all.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Order items by the sort key; ties (same type, same minute) fall back to the title, then to most recent. */
export function compareItems(a: LibraryItem, b: LibraryItem, sort: SortOrder): number {
  const dir = sort.dir === 'asc' ? 1 : -1;
  let c = 0;
  if (sort.key === 'title') c = collator.compare(a.title, b.title);
  else if (sort.key === 'kind') c = collator.compare(kindLabel(a), kindLabel(b));
  else c = a[sort.key] < b[sort.key] ? -1 : a[sort.key] > b[sort.key] ? 1 : 0;
  if (c) return c * dir;
  if (sort.key !== 'title') {
    const t = collator.compare(a.title, b.title);
    if (t) return t;
  }
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/** A short icon label for a MIME type (also used by file chips in the chat). */
export function fileIcon(type: string): string {
  if (type === 'application/pdf') return 'PDF';
  if (type.startsWith('image/')) return 'IMG';
  return 'FILE';
}

/** The icon for a row. */
export function kindIcon(item: Pick<LibraryItem, 'kind' | 'title'>, size = 18): ReactNode {
  if (item.kind === 'deck') return <DeckIcon size={size} />;
  if (item.kind === 'doc') return <DocIcon size={size} />;
  if (item.kind === 'markdown') return <MarkdownIcon size={size} />;
  if (item.kind === 'file') return <span className="file-chip-icon">{fileIcon(item.title.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '')}</span>;
  return <Logo size={size} />;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export interface FileLibraryProps {
  /** Shown top left, e.g. the logo and "FreeFlow Docs". */
  brand: ReactNode;
  /** Controls at the right of the header (menus, buttons). */
  headerActions?: ReactNode;
  /** The rows, or null while loading. */
  items: LibraryItem[] | null;
  error?: string | null;
  /** Kinds the "Start something new" tiles offer. */
  createKinds?: Exclude<LibraryKind, 'file'>[];
  onCreate(kind: Exclude<LibraryKind, 'file'>, title: string): Promise<void>;
  /** Importing: the picker's accept list, the tile label, the hint under the tiles, and what to do with the file. */
  importAccept: string;
  importLabel: string;
  importHint: string;
  /** Name of the file being imported, shown as progress; null when idle. */
  importing: string | null;
  onImport(file: File): void;
  onOpen(item: LibraryItem): void;
  /** Wraps a row's title so the page can make it a real link (middle-click, right-click). Defaults to a span. */
  titleLink?(item: LibraryItem, children: ReactNode): ReactNode;
  /** Whether a row can be renamed; stored files cannot. */
  canRename?(item: LibraryItem): boolean;
  onRename(item: LibraryItem, title: string): Promise<void>;
  onDelete(item: LibraryItem): Promise<void>;
  /** Extra entries in a row's menu, between Open and Rename. */
  rowActions?(item: LibraryItem, closeMenu: () => void): LibraryAction[];
  /** Extra modals and overlays rendered by the page. */
  children?: ReactNode;
}

const ALL_KINDS: Exclude<LibraryKind, 'file'>[] = ['sheet', 'deck', 'doc', 'markdown'];
const TILE_CLASS: Record<Exclude<LibraryKind, 'file'>, string> = { sheet: 'new-sheet-tile', deck: 'new-sheet-tile deck-tile', doc: 'new-sheet-tile doc-tile', markdown: 'new-sheet-tile markdown-tile' };

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export function FileLibrary(props: FileLibraryProps) {
  const { items, error, importing, onOpen } = props;
  const createKinds = props.createKinds ?? ALL_KINDS;
  const [filter, setFilter] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState<Exclude<LibraryKind, 'file'> | null>(null);
  const [renaming, setRenaming] = useState<LibraryItem | null>(null);
  const [deleting, setDeleting] = useState<LibraryItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [sort, setSortState] = useState<SortOrder>(loadSort);
  const setSort = (key: SortKey) => {
    // A new column sorts the natural way (names A–Z, dates newest first); the same column again flips it.
    const next: SortOrder = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'title' || key === 'kind' ? 'asc' : 'desc' };
    setSortState(next);
    saveSort(next);
  };

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const q = filter.trim().toLowerCase();
  // Show each branch right under its original (recursively), siblings in the chosen order; searching
  // flattens the list.
  const visible: { s: LibraryItem; depth: number }[] = [];
  if (items) {
    const sorted = [...items].sort((a, b) => compareItems(a, b, sort));
    if (q) for (const s of sorted) s.title.toLowerCase().includes(q) && visible.push({ s, depth: 0 });
    else {
      const ids = new Set(sorted.map((s) => s.id));
      const children = new Map<string, LibraryItem[]>();
      for (const s of sorted) {
        const p = s.branch && ids.has(s.branch.parentId) ? s.branch.parentId : null;
        if (p) children.set(p, [...(children.get(p) ?? []), s]);
      }
      const add = (s: LibraryItem, depth: number) => {
        visible.push({ s, depth });
        for (const c of children.get(s.id) ?? []) add(c, depth + 1);
      };
      for (const s of sorted) if (!(s.branch && ids.has(s.branch.parentId))) add(s, 0);
    }
  }

  const titleLink = props.titleLink ?? ((_item: LibraryItem, children: ReactNode) => <span className="sheet-title">{children}</span>);
  const canRename = props.canRename ?? ((item: LibraryItem) => item.kind !== 'file');

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
        if (file && !importing) props.onImport(file);
      }}
    >
      <header className="home-header">
        <div className="home-brand">{props.brand}</div>
        <input className="home-search" placeholder="Search spreadsheets, presentations and documents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="home-user">{props.headerActions}</div>
      </header>

      <section className="home-new">
        <div className="home-inner">
          <h2>Start something new</h2>
          <div className="tiles">
            {createKinds.map((kind) => (
              <div key={kind}>
                <button className={TILE_CLASS[kind]} onClick={() => setCreating(kind)} aria-label={`Create a blank ${KIND_NAMES[kind]}`}>
                  <span className="plus">+</span>
                </button>
                <div className="tile-label">Blank {KIND_NAMES[kind]}</div>
              </div>
            ))}
            <div>
              <button
                className="new-sheet-tile import-tile"
                disabled={!!importing}
                onClick={async () => {
                  const file = await pickFile(props.importAccept);
                  if (file) props.onImport(file);
                }}
                aria-label={props.importLabel}
              >
                <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="tile-label">{props.importLabel}</div>
            </div>
          </div>
          <div className="tile-hint">{props.importHint}</div>
        </div>
      </section>

      <section className="home-inner">
        <h2>Your files</h2>
        {error && <div className="form-error">{error}</div>}
        {items === null ? (
          <div className="muted">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state">{items.length ? 'Nothing matches your search.' : 'No files yet. Create a spreadsheet, presentation or document to get started.'}</div>
        ) : (
          <table className="sheet-list">
            <thead>
              <tr>
                {(
                  [
                    ['title', 'Name'],
                    ['kind', 'Type'],
                    ['updatedAt', 'Last modified'],
                    ['createdAt', 'Created'],
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <th key={key} className={key === 'kind' ? 'col-type' : undefined} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className={`sort-btn${sort.key === key ? ' active' : ''}`} onClick={() => setSort(key)} title={`Sort by ${label.toLowerCase()}`}>
                      {label}
                      <span className="sort-arrow" aria-hidden="true">
                        {sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''}
                      </span>
                    </button>
                  </th>
                ))}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map(({ s, depth }) => (
                <tr key={s.id} onClick={() => onOpen(s)}>
                  <td>
                    {titleLink(
                      s,
                      <>
                        <span style={{ width: depth * 22 }} className="tree-indent" />
                        {depth > 0 ? <span className="tree-elbow">└</span> : null}
                        {kindIcon(s)} {s.title}
                        {s.branch && <span className={`branch-tag${s.branch.detached ? ' detached' : ''}`}>{s.branch.detached ? `branch of deleted “${s.branch.parentTitle}”` : depth ? 'branch' : `branch of ${s.branch.parentTitle}`}</span>}
                      </>,
                    )}
                  </td>
                  <td className="col-type">{kindLabel(s)}</td>
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
                        <button onClick={() => onOpen(s)}>Open</button>
                        {(props.rowActions?.(s, () => setMenuFor(null)) ?? []).map((a) => (
                          <button key={a.label} className={a.danger ? 'danger' : undefined} onClick={() => (setMenuFor(null), void a.onClick())}>
                            {a.label}
                          </button>
                        ))}
                        {canRename(s) && <button onClick={() => (setMenuFor(null), setRenaming(s))}>Rename</button>}
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
      {dragOver && !importing && <div className="drop-hint">Drop a file to import it</div>}
      {creating && (
        <PromptModal
          title={`New ${KIND_NAMES[creating]}`}
          label="Name"
          initial={`Untitled ${KIND_NAMES[creating]}`}
          confirmText="Create"
          onConfirm={(title) => props.onCreate(creating, title)}
          onClose={() => setCreating(null)}
        />
      )}
      {renaming && (
        <PromptModal
          title={`Rename ${KIND_NAMES[renaming.kind]}`}
          label="Name"
          initial={renaming.title}
          confirmText="Rename"
          onConfirm={(title) => props.onRename(renaming, title)}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={`Delete ${KIND_NAMES[deleting.kind]}?`}
          message={<>“{deleting.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={() => props.onDelete(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
      {props.children}
    </div>
  );
}
