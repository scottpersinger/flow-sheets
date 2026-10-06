import { DOMSerializer } from 'prosemirror-model';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { docNode, docSchema, type BlockType } from '../../../shared/doc.ts';
import { docToMarkdown } from '../../../shared/docMarkdown.ts';
import { safeLinkUrl } from '../../../shared/links.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterDoc } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { pickImageFile, uploadImageFile } from '../cellImage.ts';
import { MOD } from '../commands.ts';
import { DocIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { DocController, useDocController } from '../doc/controller.ts';
import { DocEditor } from '../doc/DocEditor.tsx';
import { DocToolbar } from '../doc/DocToolbar.tsx';
import { checkDocxFile, pickDocxFile } from '../importFile.ts';
import { useDocFonts } from '../doc/fonts.ts';

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A standalone HTML page of the document, for downloading. */
function docToHtml(ctl: DocController, title: string): string {
  const body = document.createElement('div');
  body.append(DOMSerializer.fromSchema(docSchema).serializeFragment(ctl.doc.content));
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n<style>body{max-width:760px;margin:40px auto;padding:0 24px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;line-height:1.65;color:#1f1f1f}h1.doc-title{font-size:40px;font-weight:400;margin:0 0 6px}p.doc-subtitle{font-size:20px;color:#5f6368;margin:0 0 20px}img{max-width:100%}figure{margin:16px 0}figure[data-align=center]{text-align:center}figure[data-align=right]{text-align:right}blockquote{margin:0;padding-left:16px;border-left:3px solid #dadce0;color:#5f6368}pre{background:#f1f3f4;padding:12px;border-radius:6px;overflow:auto}code{font-family:Menlo,Consolas,monospace;font-size:14px}</style></head>\n<body>\n${body.innerHTML}\n</body></html>\n`;
}

export function DocPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; ctl: DocController } | { error: string } | null>(null);
  const { docFailed } = useAgent();

  useEffect(() => {
    let ctl: DocController | null = null;
    let cancelled = false;
    setState(null);
    api
      .getDoc(id!)
      .then(({ meta, doc }) => {
        if (cancelled) return;
        ctl = new DocController(doc, async (d) => {
          await api.saveDoc(meta.id, d);
        });
        setState({ meta, ctl });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError && e.status === 404 ? 'This document does not exist or was deleted.' : String((e as Error).message ?? e);
        setState({ error });
        docFailed(id!, error);
      });
    return () => {
      cancelled = true;
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id, docFailed]);

  if (!state) return <div className="page-loading">Loading document…</div>;
  if ('error' in state) {
    return (
      <div className="page-error">
        <p>{state.error}</p>
        <Link to="/" className="btn primary">
          Back to home
        </Link>
      </div>
    );
  }
  return <DocWorkbench key={state.meta.id} initialMeta={state.meta} ctl={state.ctl} />;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'link'; initial: string } | null;

function DocWorkbench({ initialMeta, ctl }: { initialMeta: SheetMeta; ctl: DocController }) {
  useDocController(ctl);
  useDocFonts(ctl.doc);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  // Notes from a Word import: arrive via navigation state (home-page import) or from File → Import.
  const [importWarnings, setImportWarnings] = useState<string[]>(() => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? []);
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const [meta, setMeta] = useState(initialMeta);
  useRegisterDoc(ctl, meta);
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

  const addImageFiles = useCallback(
    async (files: File[]) => {
      for (const file of files.slice(0, 10)) {
        try {
          const url = await uploadImageFile(file);
          ctl.insertImage(url, { alt: file.name.replace(/\.[^.]+$/, '') });
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e));
        }
      }
    },
    [ctl, notify],
  );

  const insertImage = async () => {
    const file = await pickImageFile();
    if (file) await addImageFiles([file]);
  };

  /** File → Import: add the blocks of a .docx after the cursor's block, as one undoable change. */
  const importDocxBlocks = async () => {
    const file = await pickDocxFile();
    if (!file) return;
    const problem = checkDocxFile(file);
    if (problem) return notify(problem);
    notify(`Importing “${file.name}”…`);
    try {
      const { doc, warnings } = await api.convertDocx(file);
      const blocks = docNode(doc).content;
      ctl.run((tr) => {
        const $head = tr.selection.$head;
        const pos = $head.depth ? $head.after(1) : $head.pos;
        tr.insert(pos, blocks).scrollIntoView();
      });
      setImportWarnings(warnings);
      const count = blocks.childCount;
      notify(`Added ${count} block${count === 1 ? '' : 's'} from “${file.name}”. Press ${MOD}Z to undo.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // The link dialog, from the toolbar, the Insert menu and Mod-K.
  const openLinkDialog = useCallback(() => setDialog({ kind: 'link', initial: ctl.linkAtCursor()?.href ?? '' }), [ctl]);
  useEffect(() => {
    ctl.onLinkPrompt = openLinkDialog;
    return () => {
      ctl.onLinkPrompt = null;
    };
  }, [ctl, openLinkDialog]);

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameDoc(meta.id, t);
    setMeta(m);
    setTitle(m.title);
  };

  const blockItem = (type: BlockType, label: string, shortcut?: string): MenuItem => ({ label, shortcut, checked: ctl.currentBlock() === type, action: () => ctl.setBlockType(type) });

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        {
          label: 'New document',
          action: async () => {
            const { doc } = await api.createDoc('Untitled document');
            window.open(`/doc/${doc.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        { label: 'Import Word document…', action: () => void importDocxBlocks() },
        'sep',
        { label: 'Download as Markdown (.md)', action: () => downloadFile(`${meta.title}.md`, 'text/markdown', docToMarkdown(ctl.doc)) },
        { label: 'Download as web page (.html)', action: () => downloadFile(`${meta.title}.html`, 'text/html', docToHtml(ctl, meta.title)) },
        { label: 'Print / Save as PDF…', shortcut: `${MOD}P`, action: () => setTimeout(() => window.print(), 50) },
        'sep',
        { label: 'Delete document', danger: true, action: () => setDialog({ kind: 'delete' }) },
        'sep',
        { label: 'Home', action: () => navigate('/') },
      ],
    },
    {
      key: 'edit',
      label: 'Edit',
      items: () => [
        { label: 'Undo', shortcut: `${MOD}Z`, disabled: !ctl.store.canUndo(), action: () => ctl.undo() },
        { label: 'Redo', shortcut: `${MOD}Y`, disabled: !ctl.store.canRedo(), action: () => ctl.redo() },
        'sep',
        { label: 'Clear formatting', action: () => ctl.clearFormatting() },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'Image…', action: () => void insertImage() },
        { label: 'Link…', shortcut: `${MOD}K`, action: openLinkDialog },
        { label: 'Horizontal rule', action: () => ctl.insertHorizontalRule() },
      ],
    },
    {
      key: 'format',
      label: 'Format',
      items: () => [
        {
          label: 'Text',
          submenu: [
            { label: 'Bold', shortcut: `${MOD}B`, checked: ctl.isMarkActive('bold'), action: () => ctl.toggleMark('bold') },
            { label: 'Italic', shortcut: `${MOD}I`, checked: ctl.isMarkActive('italic'), action: () => ctl.toggleMark('italic') },
            { label: 'Underline', shortcut: `${MOD}U`, checked: ctl.isMarkActive('underline'), action: () => ctl.toggleMark('underline') },
            { label: 'Strikethrough', shortcut: `${MOD}⇧X`, checked: ctl.isMarkActive('strike'), action: () => ctl.toggleMark('strike') },
            { label: 'Code', shortcut: `${MOD}E`, checked: ctl.isMarkActive('code'), action: () => ctl.toggleMark('code') },
          ],
        },
        {
          label: 'Paragraph style',
          submenu: [
            blockItem('paragraph', 'Normal text', `${MOD}⌥0`),
            blockItem('title', 'Title'),
            blockItem('subtitle', 'Subtitle'),
            blockItem('heading1', 'Heading 1', `${MOD}⌥1`),
            blockItem('heading2', 'Heading 2', `${MOD}⌥2`),
            blockItem('heading3', 'Heading 3', `${MOD}⌥3`),
            blockItem('blockquote', 'Quote'),
            blockItem('code_block', 'Code block'),
          ],
        },
        {
          label: 'Align',
          submenu: [
            { label: 'Left', shortcut: `${MOD}⇧L`, checked: ctl.currentAlign() === 'left', action: () => ctl.setAlign('left') },
            { label: 'Center', shortcut: `${MOD}⇧E`, checked: ctl.currentAlign() === 'center', action: () => ctl.setAlign('center') },
            { label: 'Right', shortcut: `${MOD}⇧R`, checked: ctl.currentAlign() === 'right', action: () => ctl.setAlign('right') },
            { label: 'Justify', shortcut: `${MOD}⇧J`, checked: ctl.currentAlign() === 'justify', action: () => ctl.setAlign('justify') },
          ],
        },
        {
          label: 'Lists',
          submenu: [
            blockItem('bullet_list', 'Bulleted list', `${MOD}⇧8`),
            blockItem('ordered_list', 'Numbered list', `${MOD}⇧7`),
            'sep',
            { label: 'Increase indent', shortcut: 'Tab', action: () => ctl.indent() },
            { label: 'Decrease indent', shortcut: '⇧Tab', action: () => ctl.outdent() },
          ],
        },
        'sep',
        { label: 'Clear formatting', action: () => ctl.clearFormatting() },
      ],
    },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  return (
    <div className="workbench doc-page">
      <header className="wb-header">
        <Link to="/" className="wb-logo" title="Back to home" onClick={() => void ctl.saver.flush()}>
          <DocIcon size={32} />
        </Link>
        <div className="wb-titles">
          <div className="wb-title-row">
            <input
              className="wb-title"
              value={title}
              aria-label="Document name"
              size={Math.max(8, title.length + 1)}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                const t = title.trim();
                if (t && t !== meta.title) rename(t).catch((e: Error) => notify(e.message));
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
          <AgentButton />
          <span title={user?.email}>{user?.email}</span>
          <button className="btn" onClick={() => void ctl.saver.flush().then(logout)}>
            Sign out
          </button>
        </div>
      </header>
      <DocToolbar ctl={ctl} onLink={openLinkDialog} onInsertImage={() => void insertImage()} />
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
      <div
        className="doc-body"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
      >
        <div className="doc-sheet">
          <DocEditor ctl={ctl} onImageFiles={(files) => void addImageFiles(files)} />
        </div>
      </div>

      {dialog?.kind === 'rename' && <PromptModal title="Rename document" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'link' && (
        <PromptModal
          title={dialog.initial ? 'Edit link' : 'Add link'}
          label="Web address"
          initial={dialog.initial || 'https://'}
          confirmText={dialog.initial ? 'Update' : 'Add link'}
          validate={(v) => (v.trim() === '' || v.trim() === 'https://' || safeLinkUrl(v) ? null : 'Enter a full web address such as https://example.com, or leave it empty to remove the link.')}
          onConfirm={(v) => {
            const href = v.trim() === '' || v.trim() === 'https://' ? null : v.trim();
            if (!ctl.setLink(href)) notify('Select the text to link first.');
          }}
          onClose={() => {
            setDialog(null);
            ctl.focus();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete document?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteDoc(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
