import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PREVIEW_FILE_TYPES, type StoredFile } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { api } from '../api.ts';
import { fileIcon, formatFileSize } from '../components/FileChip.tsx';
import { HomeIcon } from '../components/Logo.tsx';
import { useFavicon } from '../favicon.ts';

/** A stored file in its own tab: an in-app preview for PDFs and images, or just its details, with a Download button. */
export function FilePage() {
  const { id = '' } = useParams();
  useFavicon('home');
  const [file, setFile] = useState<StoredFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFile(null);
    setError(null);
    api.getFile(id).then((r) => setFile(r.file), (e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (file) document.title = file.filename;
  }, [file]);

  const previewable = !!file && PREVIEW_FILE_TYPES.includes(file.type);
  return (
    <div className="file-page">
      <header className="home-header">
        <Link to="/" className="home-brand" title="Back to your files">
          <HomeIcon />
          <span>FreeFlow Docs</span>
        </Link>
        <span className="file-page-title">{file?.filename ?? ''}</span>
        <div className="home-user">
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
            <p className="muted">This type of file can’t be previewed here.</p>
          </div>
        )}
      </main>
    </div>
  );
}
