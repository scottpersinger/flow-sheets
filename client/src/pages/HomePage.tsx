import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DeletedFile, StoredFile } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent } from '../agent/AgentProvider.tsx';
import { api, type FolderInfo } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Account } from '../components/Account.tsx';
import { FileLibrary, formatWhen, kindIcon, type LibraryItem } from '../components/FileLibrary.tsx';
import { FileThumb } from '../components/FileThumb.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { Modal, PromptModal } from '../components/Modal.tsx';
import { MoveModal } from '../components/MoveModal.tsx';
import { useFavicon } from '../favicon.ts';
import { rememberListing } from '../listing.ts';
import { checkImportFile, CSV_ACCEPT, DOCX_ACCEPT, EXCEL_ACCEPT, HTML_ACCEPT, IMAGE_ACCEPT, imageTypeOf, isCsvFile, isHtmlFile, isImageFile, isMarkdownFile, isPdfFile, isPowerPointFile, isVideoFile, isWordFile, MARKDOWN_ACCEPT, PDF_ACCEPT, PPTX_ACCEPT, titleFromFileName, VIDEO_ACCEPT } from '../importFile.ts';
import { csvTitle } from '../../../shared/csv.ts';
import { cleanFolderPath, folderTrail } from '../../../shared/folders.ts';
import { markdownTitle } from '../../../shared/markdown.ts';

const pathOf = (s: LibraryItem) => (s.kind === 'deck' ? `/d/${s.id}` : s.kind === 'doc' ? `/doc/${s.id}` : s.kind === 'markdown' ? `/md/${s.id}` : s.kind === 'file' ? `/f/${s.id}` : `/s/${s.id}`);

/** The last "Find files" search and its results, kept while the list is unchanged. */
let lastFind: { text: string; result: Promise<{ folders: FolderInfo[]; items: LibraryItem[]; truncated: boolean }> } | null = null;

/** A stored file as a row of the list. */
const fileItem = (x: StoredFile): LibraryItem => ({ id: x.id, title: x.filename, kind: 'file', folder: x.folder, createdAt: x.createdAt, updatedAt: x.createdAt });

/** The last part of a directory's path, to name the desktop app's mounted folder. */
const dirName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

export function HomePage() {
  const { local } = useAuth();
  const navigate = useNavigate();
  useFavicon('home');
  // The folder being shown is part of the address (/?folder=reports/2026), so Back and links work.
  // So is the search (&q=plan, and &find=1 for "Find files"): coming back from a file shows the same results.
  const [params, setParams] = useSearchParams();
  const folder = cleanFolderPath(params.get('folder') ?? '') ?? '';
  const search = { text: params.get('q') ?? '', find: params.get('find') === '1' };
  const query = params.toString();
  useEffect(() => rememberListing(query ? `?${query}` : ''), [query]);
  const setSearch = (text: string, find: boolean) =>
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        if (text) next.set('q', text);
        else next.delete('q');
        if (text && find) next.set('find', '1');
        else next.delete('find');
        return next;
      },
      { replace: true },
    );
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [moving, setMoving] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [branching, setBranching] = useState<LibraryItem | null>(null);

  // The guide is a presentation of the user's own: the first click makes their copy of it (on the server).
  const openingGuide = useRef(false);
  const openGuide = async () => {
    if (openingGuide.current) return;
    openingGuide.current = true;
    try {
      navigate(`/d/${(await api.gettingStarted()).deck.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      openingGuide.current = false;
    }
  };
  // Deleted files kept in the off-box copy for 30 days; null while closed.
  const [trash, setTrash] = useState<{ files: DeletedFile[]; available: boolean } | 'loading' | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  const importFile = async (file: File) => {
    const problem = checkImportFile(file);
    if (problem) return setError(problem);
    setError(null);
    setImporting(file.name);
    try {
      if (isPowerPointFile(file)) {
        const { deck, warnings } = await api.importPptx(file, titleFromFileName(file.name), folder);
        navigate(`/d/${deck.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isVideoFile(file)) {
        // Stored as the file it is and played in its own page.
        const stored = await api.uploadFile(file.name, file, folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isImageFile(file)) {
        // Stored as the picture it is and shown in its own page.
        const stored = await api.uploadFile(file.name, new Blob([file], { type: imageTypeOf(file.name)! }), folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isHtmlFile(file)) {
        // Stored as the page it is and shown in a sandboxed frame. Sent as plain bytes: the server names its type.
        const stored = await api.uploadFile(file.name, new Blob([file], { type: 'application/octet-stream' }), folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isPdfFile(file)) {
        const { file: stored } = await api.importPdf(file, folder);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isWordFile(file)) {
        const { doc, warnings } = await api.importDocx(file, titleFromFileName(file.name), folder);
        navigate(`/doc/${doc.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isMarkdownFile(file)) {
        const text = await file.text();
        const { doc } = await api.createMarkdown(markdownTitle(text, file.name), text, folder);
        navigate(`/md/${doc.id}`);
        return;
      }
      if (isCsvFile(file)) {
        // Stored as the CSV file it is, and opened in the spreadsheet editor.
        const { sheet } = await api.importCsv(csvTitle(file.name), await file.text(), folder);
        navigate(`/s/${sheet.id}`);
        return;
      }
      const { sheet, warnings } = await api.importXlsx(file, titleFromFileName(file.name), folder);
      navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  // The folder's folders, and its spreadsheets, presentations, documents, Markdown documents and stored files in one list.
  const arrived = useRef(false);
  const shown = useRef(folder);
  shown.current = folder;
  const load = (changed = true) => {
    if (changed) lastFind = null;
    return api
      .library(folder)
      .then((r) => {
        if (shown.current !== folder) return; // Another folder was opened meanwhile.
        setFolders(r.folders);
        setItems([...r.docs, ...r.files.map(fileItem)]);
        setError(null);
      })
      .catch((e: Error) => {
        if (shown.current !== folder) return;
        // Nothing to list, and the reason: not a list that looks empty or one still loading.
        setFolders([]);
        setItems([]);
        setError(e.message);
      });
  };
  const openFolder = (path: string) => navigate(path ? `/?folder=${encodeURIComponent(path)}` : '/');

  const openTrash = () => {
    setTrash('loading');
    api.listTrash().then(setTrash, (e: Error) => (setError(e.message), setTrash(null)));
  };
  const restoreFile = async (f: DeletedFile) => {
    setRestoring(f.id);
    try {
      await api.restoreFromTrash(f.id);
      setTrash((t) => (t && t !== 'loading' ? { ...t, files: t.files.filter((x) => x.id !== f.id) } : t));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(null);
    }
  };

  // Reload after the assistant finishes a request, in case it created a spreadsheet.
  const { running: agentRunning } = useAgent();
  useEffect(() => {
    // Arriving at the list is not a change to it; the assistant finishing may be.
    if (!agentRunning) void load(arrived.current);
    arrived.current = true;
  }, [agentRunning, folder]);
  useEffect(() => setItems(null), [folder]);

  useEffect(() => {
    document.title = 'Universal Docs';
  }, []);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  return (
    <FileLibrary
      brand={
        <>
          <HomeIcon />
          <span>Universal Docs</span>
        </>
      }
      listTitle={local ? <span title={local.dir}>{dirName(local.dir)}</span> : undefined}
      folder={folderTrail(folder)}
      folders={folders}
      onOpenFolder={openFolder}
      thumbnail={(s) => <FileThumb item={s} />}
      onGettingStarted={() => void openGuide()}
      search={search}
      onSearchChange={setSearch}
      onFind={async (q) => {
        // Coming back to results that were just shown does not search again; a change to the list does.
        if (lastFind?.text !== q) lastFind = { text: q, result: api.searchLibrary(q).then((r) => ({ folders: r.folders, items: [...r.docs, ...r.files.map(fileItem)], truncated: r.truncated })) };
        const mine = lastFind;
        return mine.result.catch((e: unknown) => {
          if (lastFind === mine) lastFind = null;
          throw e;
        });
      }}
      onCreateFolder={async (name) => {
        await api.createFolder(folder, name);
        await load();
      }}
      onDeleteFolder={async (path) => {
        await api.deleteFolder(path);
        await load();
      }}
      headerActions={
        <>
          <div className="home-more" ref={moreRef}>
            <button className="btn home-more-btn" aria-label="More" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="home-more-menu" role="menu">
                <a role="menuitem" href="/api/export.zip" onClick={() => setMoreOpen(false)} title="Download every document, presentation and spreadsheet as a zip (Markdown, PowerPoint, Excel and JSON)">
                  Export all
                </a>
                {/* The desktop app has no off-box copy to restore from and no app-change jobs. */}
                {!local && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      openTrash();
                    }}
                    title="Files deleted in the last 30 days"
                  >
                    Trash
                  </button>
                )}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    void openGuide();
                  }}
                  title="A short guide to the app, as a presentation in your files"
                >
                  Getting started
                </button>
                <Link role="menuitem" to="/connectors" title="Connect data sources such as Brex">
                  Connectors
                </Link>
                {!local && (
                  <Link role="menuitem" to="/changes" title="Changes the assistant made to the app">
                    Changes
                  </Link>
                )}
                <Link role="menuitem" to="/settings" title="Choose the model the assistant runs on">
                  Settings
                </Link>
              </div>
            )}
          </div>
          <AgentButton />
          <Account />
        </>
      }
      items={items}
      error={error}
      onCreate={async (kind, title) => {
        if (kind === 'sheet') navigate(`/s/${(await api.createSheet(title, folder)).sheet.id}`);
        else if (kind === 'deck') navigate(`/d/${(await api.createDeck(title, undefined, folder)).deck.id}`);
        else if (kind === 'markdown') navigate(`/md/${(await api.createMarkdown(title, '', folder)).doc.id}`);
        else navigate(`/doc/${(await api.createDoc(title, undefined, folder)).doc.id}`);
      }}
      importAccept={`${EXCEL_ACCEPT},${PPTX_ACCEPT},${DOCX_ACCEPT},${PDF_ACCEPT},${MARKDOWN_ACCEPT},${CSV_ACCEPT},${HTML_ACCEPT},${IMAGE_ACCEPT},${VIDEO_ACCEPT}`}
      importLabel="Import Excel, PowerPoint, Word, PDF, Markdown, CSV, HTML or video"
      importHint="You can also drop an Excel (.xlsx, .xls), PowerPoint (.pptx), Word (.docx), PDF (.pdf), Markdown (.md), CSV (.csv), web page (.html), picture (.png, .jpg, .gif, .webp) or video (.mp4, .mov, .webm) file anywhere on this page, or paste a picture or text to make a file of it."
      importing={importing}
      onImport={(file) => void importFile(file)}
      onOpen={(s) => navigate(pathOf(s))}
      onOpenInNewTab={(s) => void window.open(pathOf(s), '_blank')}
      titleLink={(s, children) => (
        <Link to={pathOf(s)} className="sheet-title" onClick={(e) => e.stopPropagation()}>
          {children}
        </Link>
      )}
      rowActions={(s) => [
        {
          label: s.kind === 'deck' ? 'Download as PowerPoint' : s.kind === 'doc' || s.kind === 'markdown' ? 'Download as Markdown' : s.kind === 'file' ? 'Download' : s.format === 'csv' ? 'Download as CSV' : 'Download as Excel',
          onClick: () => window.location.assign(s.kind === 'file' ? `/api/files/${s.id}/download` : `/api/files/${s.id}/export`),
        },
        ...(s.kind === 'sheet' && s.format !== 'csv' ? [{ label: 'Download as CSV', onClick: () => window.location.assign(`/api/files/${s.id}/export?format=csv`) }] : []),
        ...(s.kind === 'sheet' ? [{ label: 'Create branch', onClick: () => setBranching(s) }] : []),
        { label: 'Move to…', onClick: () => setMoving(s) },
      ]}
      onRename={async (s, title) => {
        await (s.kind === 'deck' ? api.renameDeck(s.id, title) : s.kind === 'doc' ? api.renameDoc(s.id, title) : s.kind === 'markdown' ? api.renameMarkdown(s.id, title) : api.renameSheet(s.id, title));
        await load();
      }}
      onDelete={async (s) => {
        await (s.kind === 'deck' ? api.deleteDeck(s.id) : s.kind === 'doc' ? api.deleteDoc(s.id) : s.kind === 'markdown' ? api.deleteMarkdown(s.id) : s.kind === 'file' ? api.deleteFile(s.id) : api.deleteSheet(s.id));
        await load();
      }}
    >
      {trash && (
        <Modal title="Trash" onClose={() => setTrash(null)}>
          {trash === 'loading' ? (
            <p>Loading…</p>
          ) : !trash.available ? (
            <p>Deleted files cannot be restored on this server: no backup store is configured.</p>
          ) : trash.files.length === 0 ? (
            <p>Nothing has been deleted in the last 30 days.</p>
          ) : (
            <table className="sheet-list trash-list">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Deleted</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {trash.files.map((f) => (
                  <tr key={f.id}>
                    <td>
                      {kindIcon(f)} {f.title}
                    </td>
                    <td>{formatWhen(f.deletedAt)}</td>
                    <td>
                      <button className="btn" disabled={restoring === f.id} onClick={() => void restoreFile(f)}>
                        {restoring === f.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      )}
      {moving && (
        <MoveModal
          title={moving.title}
          from={moving.folder ?? ''}
          rootName={local ? dirName(local.dir) : 'Your files'}
          onMove={async (to) => {
            await api.moveToFolder(moving.kind, moving.id, to);
            await load();
          }}
          onClose={() => setMoving(null)}
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
    </FileLibrary>
  );
}
