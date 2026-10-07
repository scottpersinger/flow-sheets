import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DeletedFile } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent } from '../agent/AgentProvider.tsx';
import { api } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { FileLibrary, formatWhen, kindIcon, type LibraryItem } from '../components/FileLibrary.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { Modal, PromptModal } from '../components/Modal.tsx';
import { useFavicon } from '../favicon.ts';
import { checkImportFile, DOCX_ACCEPT, EXCEL_ACCEPT, isMarkdownFile, isPdfFile, isPowerPointFile, isWordFile, MARKDOWN_ACCEPT, PDF_ACCEPT, PPTX_ACCEPT, titleFromFileName } from '../importFile.ts';
import { markdownTitle } from '../../../shared/markdown.ts';

const pathOf = (s: LibraryItem) => (s.kind === 'deck' ? `/d/${s.id}` : s.kind === 'doc' ? `/doc/${s.id}` : s.kind === 'markdown' ? `/md/${s.id}` : s.kind === 'file' ? `/f/${s.id}` : `/s/${s.id}`);

export function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  useFavicon('home');
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [branching, setBranching] = useState<LibraryItem | null>(null);
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
        const { deck, warnings } = await api.importPptx(file, titleFromFileName(file.name));
        navigate(`/d/${deck.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isPdfFile(file)) {
        const { file: stored } = await api.importPdf(file);
        navigate(`/f/${stored.id}`);
        return;
      }
      if (isWordFile(file)) {
        const { doc, warnings } = await api.importDocx(file, titleFromFileName(file.name));
        navigate(`/doc/${doc.id}`, { state: { importWarnings: warnings } });
        return;
      }
      if (isMarkdownFile(file)) {
        const text = await file.text();
        const { doc } = await api.createMarkdown(markdownTitle(text, file.name), text);
        navigate(`/md/${doc.id}`);
        return;
      }
      const { sheet, warnings } = await api.importXlsx(file, titleFromFileName(file.name));
      navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setImporting(null);
    }
  };

  // Spreadsheets, presentations, documents, Markdown documents and stored files in one list, most recently edited first.
  const load = () =>
    Promise.all([api.listSheets(), api.listDecks(), api.listDocs(), api.listMarkdown(), api.listFiles()])
      .then(([s, d, t, m, f]) =>
        setItems(
          [...s.sheets, ...d.decks, ...t.docs, ...m.docs, ...f.files.map((x): LibraryItem => ({ id: x.id, title: x.filename, kind: 'file', createdAt: x.createdAt, updatedAt: x.createdAt }))].sort((a, b) =>
            a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
          ),
        ),
      )
      .catch((e: Error) => setError(e.message));

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
    if (!agentRunning) void load();
  }, [agentRunning]);

  useEffect(() => {
    document.title = 'FreeFlow Docs';
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
          <span>FreeFlow Docs</span>
        </>
      }
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
                <Link role="menuitem" to="/connectors" title="Connect data sources such as Brex">
                  Connectors
                </Link>
                <Link role="menuitem" to="/changes" title="Changes the assistant made to the app">
                  Changes
                </Link>
              </div>
            )}
          </div>
          <AgentButton />
          <span>{user?.email}</span>
          <button className="btn" onClick={() => void logout()}>
            Sign out
          </button>
        </>
      }
      items={items}
      error={error}
      onCreate={async (kind, title) => {
        if (kind === 'sheet') navigate(`/s/${(await api.createSheet(title)).sheet.id}`);
        else if (kind === 'deck') navigate(`/d/${(await api.createDeck(title)).deck.id}`);
        else if (kind === 'markdown') navigate(`/md/${(await api.createMarkdown(title)).doc.id}`);
        else navigate(`/doc/${(await api.createDoc(title)).doc.id}`);
      }}
      importAccept={`${EXCEL_ACCEPT},${PPTX_ACCEPT},${DOCX_ACCEPT},${PDF_ACCEPT},${MARKDOWN_ACCEPT}`}
      importLabel="Import Excel, PowerPoint, Word, PDF or Markdown"
      importHint="You can also drop an Excel (.xlsx, .xls), PowerPoint (.pptx), Word (.docx), PDF (.pdf) or Markdown (.md) file anywhere on this page."
      importing={importing}
      onImport={(file) => void importFile(file)}
      onOpen={(s) => navigate(pathOf(s))}
      titleLink={(s, children) => (
        <Link to={pathOf(s)} className="sheet-title" onClick={(e) => e.stopPropagation()}>
          {children}
        </Link>
      )}
      rowActions={(s) => [
        { label: 'Open in new tab', onClick: () => void window.open(pathOf(s), '_blank') },
        {
          label: s.kind === 'deck' ? 'Download as PowerPoint' : s.kind === 'doc' || s.kind === 'markdown' ? 'Download as Markdown' : s.kind === 'file' ? 'Download' : 'Download as Excel',
          onClick: () => window.location.assign(s.kind === 'file' ? `/api/files/${s.id}/download` : `/api/files/${s.id}/export`),
        },
        ...(s.kind === 'sheet' ? [{ label: 'Create branch', onClick: () => setBranching(s) }] : []),
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
