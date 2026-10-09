import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FolderCrumbs, lastListingHref } from '../components/FolderCrumbs.tsx';
import { markdownTitle } from '../../../shared/markdown.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterMarkdown } from '../agent/AgentProvider.tsx';
import type { TextEdit } from '../../../shared/agent/markdownBlocks.ts';
import { api, ApiError } from '../api.ts';
import { Account } from '../components/Account.tsx';
import { MOD } from '../commands.ts';
import { MarkdownIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { ResizeHandle, usePanelWidth } from '../components/ResizeHandle.tsx';
import { useFavicon } from '../favicon.ts';
import { MARKDOWN_ACCEPT, MAX_IMPORT_MB } from '../importFile.ts';
import { MarkdownController, useMarkdownController } from '../markdown/controller.ts';
import { MarkdownPreview } from '../markdown/MarkdownPreview.tsx';
import { MARKDOWN_PREVIEW } from '../panelSize.ts';

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickMarkdownFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MARKDOWN_ACCEPT;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** A Markdown document: the text in a plain editor on the left, rendered GitHub-style on the right. */
export function MarkdownPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; ctl: MarkdownController } | { error: string } | null>(null);
  const { docFailed } = useAgent();

  useEffect(() => {
    let ctl: MarkdownController | null = null;
    let cancelled = false;
    setState(null);
    api
      .getMarkdown(id!)
      .then(({ meta, doc }) => {
        if (cancelled) return;
        // Saves name the revision loaded; when another tab saved first, the server refuses and the editor
        // takes that version instead of overwriting it.
        let rev = meta.updatedAt;
        ctl = new MarkdownController(doc, async (d) => {
          try {
            rev = (await api.saveMarkdown(meta.id, d, rev)).meta.updatedAt;
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 409)) throw e;
            const latest = await api.getMarkdown(meta.id);
            rev = latest.meta.updatedAt;
            ctl?.replaceWith(latest.doc);
          }
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
  return <MarkdownWorkbench key={state.meta.id} initialMeta={state.meta} ctl={state.ctl} />;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'replace'; file: File; text: string } | null;

const PREVIEW_KEY = 'ui.markdownPreview';

function loadShowPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Replace text[from, to) in the textarea as the user would type it, so the change joins the browser's undo
 * history (setRangeText does not). Falls back to setRangeText where execCommand is unavailable.
 */
function replaceRange(ta: HTMLTextAreaElement, from: number, to: number, text: string) {
  ta.focus();
  ta.setSelectionRange(from, to);
  let done = false;
  try {
    done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
  } catch {
    done = false;
  }
  if (!done || ta.value.slice(from, from + text.length) !== text) {
    ta.setRangeText(text, from, to, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Wrap the textarea's selection (or insert placeholder text) keeping the browser's undo history. */
function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string, placeholder: string) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const selected = value.slice(s, e);
  const inner = selected || placeholder;
  replaceRange(ta, s, e, before + inner + after);
  ta.setSelectionRange(s + before.length, s + before.length + inner.length);
}

/**
 * The text editor. It is memoized with stable props so React never updates the textarea after mounting it:
 * a controlled (or re-rendered) textarea has its defaultValue rewritten by React on every render, which
 * clears the browser's undo history. The textarea owns the text; the controller mirrors it, and only a
 * version saved elsewhere is written back into the element.
 */
const MarkdownEditor = memo(function MarkdownEditor({ ctl, editorRef, previewRef }: { ctl: MarkdownController; editorRef: RefObject<HTMLTextAreaElement | null>; previewRef: RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const ta = editorRef.current;
    if (!ta) return;
    ta.value = ctl.text;
    // The assistant's edits go through the textarea so they join the browser's undo history.
    ctl.onApplyEdit = (edit: TextEdit) => {
      replaceRange(ta, edit.from, edit.to, edit.insert);
      const lines = ta.value.split('\n').length;
      const line = ta.value.slice(0, edit.from).split('\n').length - 1;
      // Scroll the change into view (the textarea's lines are roughly even in height).
      ta.scrollTop = Math.max(0, (line / Math.max(1, lines)) * ta.scrollHeight - ta.clientHeight / 3);
    };
    // A version saved elsewhere replaces the text (that one change is not undoable).
    const unsub = ctl.subscribe(() => {
      if (ta.value !== ctl.text) ta.value = ctl.text;
    });
    return () => {
      ctl.onApplyEdit = null;
      unsub();
    };
  }, [ctl, editorRef]);

  // Keep the preview roughly in step with the editor while scrolling it.
  const syncScroll = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const pv = previewRef.current;
    if (!pv) return;
    const max = ta.scrollHeight - ta.clientHeight;
    if (max <= 0) return;
    pv.scrollTop = (ta.scrollTop / max) * (pv.scrollHeight - pv.clientHeight);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      replaceRange(ta, ta.selectionStart, ta.selectionEnd, '  ');
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      wrapSelection(ta, '**', '**', 'bold text');
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      wrapSelection(ta, '_', '_', 'italic text');
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      wrapSelection(ta, '[', '](https://)', 'link text');
    }
  };

  return (
    <textarea
      ref={editorRef}
      className="md-editor"
      spellCheck
      aria-label="Markdown text"
      placeholder="# Start writing Markdown…"
      onInput={(e) => {
        ctl.cursor = e.currentTarget.selectionStart;
        ctl.setText(e.currentTarget.value);
      }}
      onSelect={(e) => {
        ctl.cursor = e.currentTarget.selectionStart;
      }}
      onKeyDown={onKeyDown}
      onScroll={syncScroll}
    />
  );
});

function MarkdownWorkbench({ initialMeta, ctl }: { initialMeta: SheetMeta; ctl: MarkdownController }) {
  useMarkdownController(ctl);
  useFavicon('markdown');
  const navigate = useNavigate();
  const { open: agentOpen } = useAgent();
  const [meta, setMeta] = useState(initialMeta);
  useRegisterMarkdown(ctl, meta);
  const [title, setTitle] = useState(initialMeta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [showPreview, setShowPreviewState] = useState(loadShowPreview);
  const setShowPreview = (v: boolean) => {
    setShowPreviewState(v);
    try {
      localStorage.setItem(PREVIEW_KEY, v ? '1' : '0');
    } catch {
      // Not remembered, that's all.
    }
  };
  const rowRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // The preview shares the body with the editor (less the 8px gap between them); the editor keeps a minimum.
  const preview = usePanelWidth(MARKDOWN_PREVIEW, () => (rowRef.current ? { available: rowRef.current.clientWidth - 8 } : {}), rowRef);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => ctl.saver.subscribe(() => setSaveTick((t) => t + 1)), [ctl]);

  useEffect(() => {
    document.title = `${meta.title} - FreeFlow Docs`;
    return () => {
      document.title = 'FreeFlow Docs';
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

  // The assistant panel opening or closing changes the room for the preview.
  useEffect(() => {
    preview.set(preview.width, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentOpen]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  const externalChanges = ctl.externalChanges;
  useEffect(() => {
    if (externalChanges) notify('Updated with changes saved elsewhere.');
  }, [externalChanges, notify]);

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu) return;
    const close = () => setOpenMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameMarkdown(meta.id, t);
    setMeta(m);
    setTitle(m.title);
  };

  /** File → Import: replace the text with a .md file's (after confirming when there is text to lose). */
  const importMarkdownFile = async () => {
    const file = await pickMarkdownFile();
    if (!file) return;
    if (!/\.(md|markdown)$/i.test(file.name)) return notify('Please choose a Markdown file (.md).');
    if (file.size > MAX_IMPORT_MB * 1024 * 1024) return notify(`This file is too large to import (${MAX_IMPORT_MB} MB maximum).`);
    const text = await file.text();
    if (ctl.text.trim()) setDialog({ kind: 'replace', file, text });
    else {
      ctl.setText(text);
      notify(`Imported “${file.name}”.`);
    }
  };

  const insert = (before: string, after: string, placeholder: string) => () => {
    const ta = editorRef.current;
    if (ta) wrapSelection(ta, before, after, placeholder);
  };

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        {
          label: 'New Markdown document',
          action: async () => {
            const { doc } = await api.createMarkdown('Untitled Markdown');
            window.open(`/md/${doc.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        { label: 'Import Markdown file…', action: () => void importMarkdownFile() },
        'sep',
        { label: 'Download (.md)', action: () => downloadFile(`${meta.title}.md`, 'text/markdown', ctl.text) },
        'sep',
        { label: 'Delete document', danger: true, action: () => setDialog({ kind: 'delete' }) },
        'sep',
        { label: 'Home', action: () => navigate('/') },
      ],
    },
    {
      key: 'view',
      label: 'View',
      items: () => [
        { label: 'Preview', checked: showPreview, action: () => setShowPreview(!showPreview) },
        { label: 'Reset preview width', disabled: !showPreview, action: () => preview.set(preview.spec.def, true) },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'Bold', shortcut: `${MOD}B`, action: insert('**', '**', 'bold text') },
        { label: 'Italic', shortcut: `${MOD}I`, action: insert('_', '_', 'italic text') },
        { label: 'Strikethrough', action: insert('~~', '~~', 'text') },
        { label: 'Inline code', action: insert('`', '`', 'code') },
        'sep',
        { label: 'Heading', action: insert('## ', '', 'Heading') },
        { label: 'Link', shortcut: `${MOD}K`, action: insert('[', '](https://)', 'link text') },
        { label: 'Image', action: insert('![', '](https://)', 'alt text') },
        { label: 'Code block', action: insert('```\n', '\n```', 'code') },
        { label: 'Quote', action: insert('> ', '', 'quote') },
        { label: 'Bulleted list', action: insert('- ', '', 'item') },
        { label: 'Numbered list', action: insert('1. ', '', 'item') },
        { label: 'Task list', action: insert('- [ ] ', '', 'task') },
        { label: 'Table', action: insert('| Column | Column |\n| --- | --- |\n| ', ' | |', 'cell') },
        { label: 'Horizontal rule', action: insert('\n---\n', '', '') },
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
    <div className="workbench md-page">
      <header className="wb-header">
        <Link to={lastListingHref()} className="wb-logo" title="Back to the file list" onClick={() => void ctl.saver.flush()}>
          <MarkdownIcon size={32} />
        </Link>
        <div className="wb-titles">
          <div className="wb-title-row">
            <FolderCrumbs folder={meta.folder} onLeave={() => void ctl.saver.flush()} />
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
          <button className={`btn${showPreview ? ' active' : ''}`} aria-pressed={showPreview} onClick={() => setShowPreview(!showPreview)} title="Show or hide the rendered preview">
            Preview
          </button>
          <AgentButton />
          <Account before={() => ctl.saver.flush()} />
        </div>
      </header>
      <div className="md-body-row" ref={rowRef}>
        <div className="md-editor-col">
          <MarkdownEditor ctl={ctl} editorRef={editorRef} previewRef={previewRef} />
        </div>
        {showPreview && (
          <>
            <ResizeHandle panel={preview} side="right" label="Resize preview" className="md-preview-resize" />
            <div className="md-preview" style={{ width: preview.width }} ref={previewRef}>
              <MarkdownPreview text={ctl.text} />
            </div>
          </>
        )}
      </div>

      {dialog?.kind === 'rename' && <PromptModal title="Rename document" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'replace' && (
        <ConfirmModal
          title="Replace the text?"
          message={<>The current text will be replaced with the contents of “{dialog.file.name}”. You can undo this with {MOD}Z.</>}
          confirmText="Replace"
          onConfirm={() => {
            const ta = editorRef.current;
            if (ta) {
              // Through the textarea so the replacement stays in the browser's undo history.
              replaceRange(ta, 0, ta.value.length, dialog.text);
            } else ctl.setText(dialog.text);
            if (meta.title === 'Untitled Markdown') void rename(markdownTitle(dialog.text, dialog.file.name)).catch(() => {});
            notify(`Imported “${dialog.file.name}”.`);
          }}
          onClose={() => setDialog(null)}
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
            await api.deleteMarkdown(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
