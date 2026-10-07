// The library inside ChatGPT: the app's home page component (client/src/components/FileLibrary.tsx) fed by
// the plugin's tools instead of the REST API. The iframe has no cookies, so files come from `list_files`,
// imports go through a one-time ticket, and opening a file tells the server so the model acts on it.
import { useEffect, useState } from 'react';
import { FileLibrary, type LibraryItem } from '../../client/src/components/FileLibrary.tsx';
import { Logo } from '../../client/src/components/Logo.tsx';
import { Modal } from '../../client/src/components/Modal.tsx';
import { DOCX_ACCEPT, EXCEL_ACCEPT, PPTX_ACCEPT } from '../../client/src/importFile.ts';
import type { FileKind, Host } from './host.ts';

interface FileSummary {
  kind: FileKind;
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
}

const CREATE_TOOLS = { doc: 'create_doc', deck: 'create_deck', sheet: 'create_sheet' } as const;
const titleFromFileName = (name: string) => name.replace(/\.[^.]+$/, '').trim() || 'Imported file';
const toItem = (f: FileSummary): LibraryItem => ({ id: f.id, kind: f.kind, title: f.title, updatedAt: f.updated_at, createdAt: f.created_at });
const asFile = (item: LibraryItem) => ({ kind: item.kind as FileKind, id: item.id });

export function Library({ host, onOpen }: { host: Host; onOpen(file: { kind: FileKind; id: string }): void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [imported, setImported] = useState<{ file: FileSummary; warnings: string[] } | null>(null);

  const load = () =>
    host
      .call<{ files: FileSummary[] }>('list_files')
      .then((r) => setItems(r.files.map(toItem)))
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), [host]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Import: a one-time ticket from the server, then the bytes go straight to its import route. */
  const importFile = async (file: File) => {
    if (!/\.(xlsx?|docx|pptx)$/i.test(file.name)) return setError('Choose an Excel workbook (.xlsx, .xls), Word document (.docx) or PowerPoint presentation (.pptx).');
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

  const openImported = () => {
    if (!imported) return;
    const f = imported.file;
    setImported(null);
    onOpen({ kind: f.kind, id: f.id });
  };

  return (
    <div className="docs-library">
      <FileLibrary
        brand={
          <>
            <Logo />
            <span>FreeFlow Docs</span>
          </>
        }
        headerActions={
          <>
            <button className="btn" onClick={() => void host.ask('What spreadsheets, presentations and documents do I have? List them with a one-line summary each.')}>
              Ask about my files
            </button>
            {host.appLink() && (
              <button className="btn" title="Open the full Freeflow app in a new tab" onClick={() => void host.openLink(host.appLink()!)}>
                Open Freeflow ↗
              </button>
            )}
          </>
        }
        items={items}
        error={error}
        onCreate={async (kind, title) => {
          const r = await host.call<{ file: FileSummary }>(CREATE_TOOLS[kind], { title });
          onOpen({ kind, id: r.file.id });
        }}
        importAccept={`${EXCEL_ACCEPT},${PPTX_ACCEPT},${DOCX_ACCEPT}`}
        importLabel="Import Excel, PowerPoint or Word"
        importHint="You can also attach an Excel, PowerPoint or Word file in the chat and ask ChatGPT to import it, or ask it to make something new."
        importing={importing}
        onImport={(file) => void importFile(file)}
        onOpen={(item) => onOpen(asFile(item))}
        rowActions={(item) => {
          const link = host.appLink(asFile(item));
          return link ? [{ label: 'Open in Freeflow ↗', onClick: () => void host.openLink(link) }] : [];
        }}
        onRename={async (item, title) => {
          await host.call('rename_file', { kind: item.kind, id: item.id, title });
          await load();
        }}
        onDelete={async (item) => {
          await host.call('delete_file', { kind: item.kind, id: item.id });
          await load();
        }}
      >
        {imported && (
          <Modal title="Imported with some changes" onClose={openImported}>
            <ul>
              {imported.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <button className="btn primary" onClick={openImported}>
                Open
              </button>
            </div>
          </Modal>
        )}
      </FileLibrary>
    </div>
  );
}
