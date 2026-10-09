import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { HTML_TYPE, PREVIEW_FILE_TYPES, type StoredFile } from '../../../shared/types.ts';
import { HtmlEditor } from '../components/HtmlEditor.tsx';
import { HtmlPreview } from '../components/HtmlPreview.tsx';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { FILE_CHANGED_EVENT, useRegisterFile } from '../agent/AgentProvider.tsx';
import { api } from '../api.ts';
import { fileIcon, formatFileSize } from '../components/FileChip.tsx';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { useFavicon } from '../favicon.ts';
import { isPowerPointFile, isWordFile, titleFromFileName } from '../importFile.ts';

/** What an Office file becomes when it is converted, or null for any other file. */
function editableKind(filename: string): string | null {
  if (/\.xlsx?$/i.test(filename)) return 'spreadsheet';
  if (/\.pptx$/i.test(filename)) return 'presentation';
  if (/\.docx$/i.test(filename)) return 'document';
  return null;
}

/** A stored file in its own tab: an in-app preview for PDFs, images and web pages, a player for videos, or just its details, with a Download button. */
export function FilePage() {
  const { id = '' } = useParams();
  useFavicon('home');
  const [file, setFile] = useState<StoredFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const navigate = useNavigate();

  // An Excel, PowerPoint or Word file is not edited in place: converting makes an editable copy next to it.
  const convert = async (stored: StoredFile) => {
    setConverting(true);
    try {
      const res = await fetch(stored.url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
      const upload = new File([await res.blob()], stored.filename, { type: stored.type });
      const title = titleFromFileName(stored.filename);
      // The copy goes in the same folder as the original.
      const folder = stored.folder;
      if (isPowerPointFile(upload)) {
        const { deck, warnings } = await api.importPptx(upload, title, folder);
        navigate(`/d/${deck.id}`, { state: { importWarnings: warnings } });
      } else if (isWordFile(upload)) {
        const { doc, warnings } = await api.importDocx(upload, title, folder);
        navigate(`/doc/${doc.id}`, { state: { importWarnings: warnings } });
      } else {
        const { sheet, warnings } = await api.importXlsx(upload, title, folder);
        navigate(`/s/${sheet.id}`, { state: { importWarnings: warnings } });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConverting(false);
    }
  };

  // Counts the assistant's changes to this file, so the preview shows each new version.
  const [version, setVersion] = useState(0);
  // A web page opens as a working page; Edit makes it editable in place instead (the element selected in it is
  // told to the assistant), with its scripts and links off.
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setFile(null);
    setError(null);
    setEditing(false);
    api.getFile(id).then((r) => setFile(r.file), (e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return;
      setVersion((v) => v + 1);
      api.getFile(id).then((r) => setFile(r.file), () => {});
    };
    window.addEventListener(FILE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(FILE_CHANGED_EVENT, changed);
  }, [id]);

  useEffect(() => {
    if (file) document.title = file.filename;
  }, [file]);
  // The assistant is told which file is showing.
  useRegisterFile(file, editing ? selected : null);

  const previewable = !!file && PREVIEW_FILE_TYPES.includes(file.type);
  return (
    <div className="file-page">
      <header className="home-header">
        <Link to={lastListingHref()} className="home-brand" title="Back to the file list">
          <HomeIcon />
          <span>FreeFlow Docs</span>
        </Link>
        <span className="file-page-title">
          {file && <FolderCrumbs folder={file.folder} />}
          {file?.filename ?? ''}
        </span>
        <div className="home-user">
          {file?.type === HTML_TYPE && (
            <button className={`btn${editing ? ' active' : ''}`} onClick={() => setEditing(!editing)} title={editing ? 'Run the page as a browser would, with its scripts and links working' : "Select, edit, delete and recolor the page's elements"}>
              {editing ? 'Preview' : 'Edit'}
            </button>
          )}
          {file && (
            <a className="btn primary" href={file.downloadUrl} download={file.filename}>
              Download
            </a>
          )}
          <AgentButton />
        </div>
      </header>
      <main className="file-page-body">
        {error ? (
          <div className="form-error">{error}</div>
        ) : !file ? (
          <div className="muted">Loading…</div>
        ) : file.type === 'application/pdf' ? (
          <iframe className="file-preview" src={file.url} title={file.filename} />
        ) : file.type === HTML_TYPE && editing ? (
          <HtmlEditor key={version} file={file} onSelect={setSelected} onSaved={setFile} />
        ) : file.type === HTML_TYPE ? (
          <HtmlPreview key={version} url={file.url} title={file.filename} />
        ) : file.type.startsWith('video/') ? (
          // The browser's own player; it asks the server for the parts of the file it needs.
          <video className="file-preview-video" src={file.url} controls autoPlay playsInline />
        ) : previewable ? (
          <img className="file-preview-image" src={file.url} alt={file.filename} />
        ) : (
          <div className="file-info">
            <div className="file-chip-icon" aria-hidden="true">
              {fileIcon(file.type)}
            </div>
            <h2>{file.filename}</h2>
            <p>
              {file.type || 'Unknown type'} · {formatFileSize(file.size)} · added {new Date(file.createdAt).toLocaleString()}
            </p>
            {editableKind(file.filename) ? (
              <>
                <p className="muted">This file isn’t edited in place. Open an editable copy of it as a {editableKind(file.filename)}; the original stays as it is.</p>
                <button className="btn primary" disabled={converting} onClick={() => void convert(file)}>
                  {converting ? 'Converting…' : `Open as ${editableKind(file.filename)}`}
                </button>
              </>
            ) : (
              <p className="muted">This type of file can’t be previewed here.</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
