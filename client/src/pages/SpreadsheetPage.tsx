import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { cellKey } from '../../../shared/cellref.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import {
  cellContextItems,
  dataItems,
  editItems,
  fileItems,
  formatItems,
  insertItems,
  tabContextItems,
  viewItems,
  type CommandHost,
} from '../commands.ts';
import { FilterMenu } from '../components/FilterMenu.tsx';
import { FormulaBar } from '../components/FormulaBar.tsx';
import { Logo } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { TabBar } from '../components/TabBar.tsx';
import { Toolbar } from '../components/Toolbar.tsx';
import { Grid } from '../grid/Grid.tsx';
import { checkExcelFile, pickExcelFile } from '../importFile.ts';
import { SheetController } from '../state/controller.ts';
import { useController } from '../state/useController.ts';

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCSV(ctl: SheetController): string {
  const tab = ctl.tab;
  const ext = ctl.store.engine.extent(tab.id);
  const rows: string[] = [];
  for (let r = 0; r < ext.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < ext.cols; c++) {
      const v = tab.cells[cellKey(r, c)] ? ctl.store.display(tab.id, r, c) : '';
      row.push(/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    }
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

export function SpreadsheetPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; ctl: SheetController } | { error: string } | null>(null);

  useEffect(() => {
    let ctl: SheetController | null = null;
    let cancelled = false;
    setState(null);
    api
      .getSheet(id!)
      .then(({ sheet, workbook }) => {
        if (cancelled) return;
        ctl = new SheetController(workbook, async (wb) => {
          await api.saveSheet(sheet.id, wb);
        });
        setState({ meta: sheet, ctl });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ error: e instanceof ApiError && e.status === 404 ? 'This spreadsheet does not exist or was deleted.' : String((e as Error).message ?? e) });
      });
    return () => {
      cancelled = true;
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id]);

  if (!state) return <div className="page-loading">Loading spreadsheet…</div>;
  if ('error' in state) {
    return (
      <div className="page-error">
        <p>{state.error}</p>
        <Link to="/" className="btn primary">
          Back to spreadsheets
        </Link>
      </div>
    );
  }
  return <Workbench key={state.meta.id} initialMeta={state.meta} ctl={state.ctl} />;
}

type Dialog = { kind: 'rename' } | { kind: 'deleteSheet' } | { kind: 'deleteTab'; tabId: string } | null;

function Workbench({ initialMeta, ctl }: { initialMeta: SheetMeta; ctl: SheetController }) {
  useController(ctl);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  // Notes from an Excel import: arrive via navigation state (home-page import) or from File → Import.
  const [importWarnings, setImportWarnings] = useState<string[]>(
    () => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? [],
  );
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const [meta, setMeta] = useState(initialMeta);
  const [title, setTitle] = useState(initialMeta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);

  useEffect(() => {
    document.title = `${meta.title} - Sheets`;
    return () => {
      document.title = 'Sheets';
    };
  }, [meta.title]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (ctl.edit) ctl.commitEdit();
      if (ctl.saver.hasUnsavedChanges()) {
        void ctl.saver.flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [ctl]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const renameSheet = async (t: string) => {
    const { sheet } = await api.renameSheet(meta.id, t);
    setMeta(sheet);
    setTitle(sheet.title);
  };

  const host: CommandHost = useMemo(
    () => ({
      ctl,
      notify,
      renameSheet: () => setDialog({ kind: 'rename' }),
      deleteSheet: () => setDialog({ kind: 'deleteSheet' }),
      deleteTab: (tabId) => setDialog({ kind: 'deleteTab', tabId }),
      newSheet: async () => {
        const { sheet } = await api.createSheet('Untitled spreadsheet');
        window.open(`/s/${sheet.id}`, '_blank');
      },
      goHome: () => navigate('/'),
      importXlsx: async () => {
        const file = await pickExcelFile();
        if (!file) return;
        const problem = checkExcelFile(file);
        if (problem) return notify(problem);
        notify(`Importing “${file.name}”…`);
        try {
          const { workbook, warnings } = await api.convertXlsx(file);
          const renamed = ctl.importTabs(workbook.tabs);
          const n = workbook.tabs.length;
          const notes = [...warnings];
          if (renamed.length) {
            notes.push(`Renamed to avoid clashing with existing sheets: ${renamed.map((r) => `"${r.from}" → "${r.to}"`).join(', ')}.`);
          }
          setImportWarnings(notes);
          notify(`Added ${n} sheet${n === 1 ? '' : 's'} from “${file.name}”. Press ${navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'} to undo.`);
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      },
      download: (kind) => {
        if (kind === 'json') downloadFile(`${meta.title}.json`, 'application/json', JSON.stringify(ctl.store.workbook, null, 2));
        else downloadFile(`${meta.title} - ${ctl.tab.name}.csv`, 'text/csv', toCSV(ctl));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl, notify, meta.title],
  );

  // Close top menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  // Context menu closes on outside click / Escape.
  useEffect(() => {
    if (!ctl.menu) return;
    const close = () => ctl.openMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', close);
    };
  }, [ctl, ctl.menu]);

  // Shift+F11: new sheet tab (global shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11' && e.shiftKey) {
        e.preventDefault();
        ctl.addTab();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl]);

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    { key: 'file', label: 'File', items: () => fileItems(host) },
    { key: 'edit', label: 'Edit', items: () => editItems(host) },
    { key: 'view', label: 'View', items: () => viewItems(host) },
    { key: 'insert', label: 'Insert', items: () => insertItems(host) },
    { key: 'format', label: 'Format', items: () => formatItems(host) },
    { key: 'data', label: 'Data', items: () => dataItems(host) },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const ctxMenu = ctl.menu;
  const ctxItems = ctxMenu ? (ctxMenu.kind === 'tab' ? tabContextItems(host, ctxMenu.tabId) : cellContextItems(host, ctxMenu.kind)) : null;
  const deletingTab = dialog?.kind === 'deleteTab' ? ctl.store.getTab(dialog.tabId) : null;

  return (
    <div className="workbench">
      <header className="wb-header">
        <Link to="/" className="wb-logo" title="Back to spreadsheets" onClick={() => void ctl.saver.flush()}>
          <Logo size={32} />
        </Link>
        <div className="wb-titles">
          <div className="wb-title-row">
            <input
              className="wb-title"
              value={title}
              aria-label="Spreadsheet name"
              size={Math.max(8, title.length + 1)}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                const t = title.trim();
                if (t && t !== meta.title) renameSheet(t).catch((e: Error) => notify(e.message));
                else setTitle(meta.title);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') {
                  setTitle(meta.title);
                  setTimeout(() => (e.target as HTMLInputElement).blur());
                }
              }}
            />
            <span className={`save-status ${ctl.saver.status}`}>{saveLabel}</span>
          </div>
          <nav className="menubar" onMouseDown={(e) => e.stopPropagation()}>
            {menus.map((m) => (
              <div key={m.key} className="menubar-entry">
                <button
                  className={`menubar-btn${openMenu === m.key ? ' open' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    if (ctl.edit) ctl.commitEdit();
                    setOpenMenu(openMenu === m.key ? null : m.key);
                  }}
                  onMouseEnter={() => openMenu && setOpenMenu(m.key)}
                >
                  {m.label}
                </button>
                {openMenu === m.key && <MenuList items={m.items()} onDone={() => setOpenMenu(null)} style={{ top: 26, left: 0 }} />}
              </div>
            ))}
          </nav>
        </div>
        <div className="wb-user">
          <span title={user?.email}>{user?.email}</span>
          <button className="btn" onClick={() => void ctl.saver.flush().then(logout)}>
            Sign out
          </button>
        </div>
      </header>
      <Toolbar host={host} />
      {importWarnings.length > 0 && (
        <div className="import-banner" role="status">
          <div>
            <strong>Imported with some changes:</strong>
            <ul>
              {importWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
          <button className="link" onClick={dismissImportWarnings}>
            Dismiss
          </button>
        </div>
      )}
      <FormulaBar ctl={ctl} />
      <Grid ctl={ctl} />
      <TabBar host={host} />

      {ctxMenu && ctxItems && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={ctxItems} onDone={() => ctl.openMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}
      {ctl.filterMenu && ctl.tab.filter && <FilterMenu key={`${ctl.tab.id}:${ctl.filterMenu.col}`} ctl={ctl} />}

      {dialog?.kind === 'rename' && (
        <PromptModal title="Rename spreadsheet" label="Name" initial={meta.title} confirmText="Rename" onConfirm={renameSheet} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'deleteSheet' && (
        <ConfirmModal
          title="Delete spreadsheet?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteSheet(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {deletingTab && (
        <ConfirmModal
          title="Delete sheet?"
          message={<>Delete the sheet “{deletingTab.name}”? You can undo this with {navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'}.</>}
          confirmText="Delete"
          danger
          onConfirm={() => ctl.deleteTab(deletingTab.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
