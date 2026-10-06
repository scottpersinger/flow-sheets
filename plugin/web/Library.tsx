import { useEffect, useState } from 'react';
import { DeckIcon, DocIcon } from '../../client/src/components/Logo.tsx';
import type { FileKind, Host } from './host.ts';

interface FileSummary {
  kind: FileKind;
  id: string;
  title: string;
  updated_at: string;
}

function when(iso: string): string {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1) return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString();
}

export function Library({ host, onOpen }: { host: Host; onOpen(file: { kind: FileKind; id: string }): void }) {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    host
      .call<{ files: FileSummary[] }>('list_files')
      .then((r) => setFiles(r.files))
      .catch((e: Error) => setError(e.message));
  }, [host]);

  const create = async (kind: FileKind) => {
    setBusy(true);
    try {
      const r = await host.call<{ file: FileSummary }>(kind === 'doc' ? 'create_doc' : 'create_deck', { title: kind === 'doc' ? 'Untitled document' : 'Untitled presentation' });
      onOpen({ kind, id: r.file.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const section = (kind: FileKind, label: string) => {
    const items = (files ?? []).filter((f) => f.kind === kind);
    return (
      <section className="docs-section">
        <h2>{label}</h2>
        {items.length === 0 ? (
          <div className="docs-empty">No {label.toLowerCase()} yet.</div>
        ) : (
          <div className="docs-library-grid">
            {items.map((f) => (
              <button key={f.id} className="docs-card" onClick={() => onOpen({ kind: f.kind, id: f.id })}>
                <div className="title">
                  {f.kind === 'deck' ? <DeckIcon size={16} /> : <DocIcon size={16} />} {f.title}
                </div>
                <div className="when">{when(f.updated_at)}</div>
              </button>
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="docs-library">
      <div className="docs-library-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DocIcon size={28} /> Docs
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => void host.ask('What documents and presentations do I have? List them with a one-line summary each.')}>
            Ask about my files
          </button>
          <button className="btn" disabled={busy} onClick={() => void create('deck')}>
            New presentation
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void create('doc')}>
            New document
          </button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
      {!files && !error && <div className="page-loading">Loading…</div>}
      {files && (
        <>
          {section('doc', 'Documents')}
          {section('deck', 'Presentations')}
        </>
      )}
    </div>
  );
}
