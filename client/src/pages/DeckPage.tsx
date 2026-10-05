import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { LAYOUT_IDS, THEME_IDS, THEMES } from '../../../shared/deck.ts';
import type { SheetMeta } from '../../../shared/types.ts';
import { AgentButton } from '../agent/AgentPanel.tsx';
import { useAgent, useRegisterDeck } from '../agent/AgentProvider.tsx';
import { api, ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { uploadImageFile, pickImageFile } from '../cellImage.ts';
import { isMac, MOD } from '../commands.ts';
import { DeckIcon } from '../components/Logo.tsx';
import { MenuList, type MenuItem } from '../components/Menu.tsx';
import { ConfirmModal, PromptModal } from '../components/Modal.tsx';
import { ResizeHandle, usePanelWidth } from '../components/ResizeHandle.tsx';
import { DeckController, useDeckController } from '../deck/controller.ts';
import { DeckEditor } from '../deck/DeckEditor.tsx';
import { useDeckFonts } from '../deck/fonts.ts';
import { DeckToolbar, LAYOUT_NAMES, shapeMenuItems } from '../deck/DeckToolbar.tsx';
import { downloadPptx } from '../deck/pptx.ts';
import { PresentMode } from '../deck/PresentMode.tsx';
import { checkPptxFile, pickPptxFile } from '../importFile.ts';
import { SlideView } from '../deck/SlideView.tsx';
import { ThumbnailStrip } from '../deck/ThumbnailStrip.tsx';
import { SLIDE_TRAY } from '../panelSize.ts';

/** Natural size of an image, for sizing a new image element. */
function imageSize(src: string): Promise<{ w: number; h: number } | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

export function DeckPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ meta: SheetMeta; ctl: DeckController } | { error: string } | null>(null);
  const { deckFailed } = useAgent();

  useEffect(() => {
    let ctl: DeckController | null = null;
    let cancelled = false;
    setState(null);
    api
      .getDeck(id!)
      .then(({ meta, deck }) => {
        if (cancelled) return;
        ctl = new DeckController(deck, async (d) => {
          await api.saveDeck(meta.id, d);
        });
        setState({ meta, ctl });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = e instanceof ApiError && e.status === 404 ? 'This presentation does not exist or was deleted.' : String((e as Error).message ?? e);
        setState({ error });
        deckFailed(id!, error);
      });
    return () => {
      cancelled = true;
      if (ctl) {
        void ctl.saver.flush();
        ctl.dispose();
      }
    };
  }, [id, deckFailed]);

  if (!state) return <div className="page-loading">Loading presentation…</div>;
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
  return <DeckWorkbench key={state.meta.id} initialMeta={state.meta} ctl={state.ctl} />;
}

type Dialog = { kind: 'rename' } | { kind: 'delete' } | { kind: 'deleteSlide'; index: number } | null;

function DeckWorkbench({ initialMeta, ctl }: { initialMeta: SheetMeta; ctl: DeckController }) {
  useDeckController(ctl);
  useDeckFonts(ctl.deck);
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  // Notes from a PowerPoint import: arrive via navigation state (home-page import) or from File → Import.
  const [importWarnings, setImportWarnings] = useState<string[]>(() => (location.state as { importWarnings?: string[] } | null)?.importWarnings ?? []);
  const dismissImportWarnings = () => {
    setImportWarnings([]);
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  };
  const [meta, setMeta] = useState(initialMeta);
  useRegisterDeck(ctl, meta);
  const [title, setTitle] = useState(initialMeta.title);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [, setSaveTick] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The thumbnail tray shares the body with the canvas (less the 8px gap between them).
  const bodyRef = useRef<HTMLDivElement>(null);
  const tray = usePanelWidth(SLIDE_TRAY, () => (bodyRef.current ? { available: bodyRef.current.clientWidth - 8 } : {}), bodyRef);

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
          ctl.addImage(url, await imageSize(url));
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

  const exportPptx = async () => {
    notify('Preparing the PowerPoint file…');
    try {
      const warnings = await downloadPptx(ctl.deck, meta.title);
      notify(warnings.length ? warnings.join(' ') : 'Downloaded.');
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** File → Import: add the slides of a .pptx after the current slide, as one undoable change. */
  const importPptxSlides = async () => {
    const file = await pickPptxFile();
    if (!file) return;
    const problem = checkPptxFile(file);
    if (problem) return notify(problem);
    notify(`Importing “${file.name}”…`);
    try {
      const { deck, warnings } = await api.convertPptx(file);
      const at = ctl.current + 1;
      ctl.run((tx) => deck.slides.forEach((s, k) => tx.insertSlide(at + k, s)));
      ctl.goTo(at);
      setImportWarnings(warnings);
      const n = deck.slides.length;
      notify(`Added ${n} slide${n === 1 ? '' : 's'} from “${file.name}”. Press ${MOD}Z to undo.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
  };

  // Global shortcuts (not while typing in an input, the notes or an inline text editor).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ctl.presenting || isTyping(e.target)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        e.shiftKey ? ctl.redo() : ctl.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        ctl.redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        ctl.selection.length ? ctl.duplicateSelected() : ctl.duplicateSlide();
      } else if (mod && k === 'c') {
        if (ctl.selection.length) ctl.copySelected();
      } else if (mod && k === 'a') {
        e.preventDefault();
        ctl.select(ctl.slide.elements.map((el) => el.id));
      } else if (mod && k === 'b') {
        e.preventDefault();
        const t = ctl.selected.find((el) => el.type === 'text');
        if (t?.type === 'text') ctl.styleSelected({ bold: !(t.style?.bold ?? t.role === 'title') });
      } else if (mod && k === 'i') {
        e.preventDefault();
        const t = ctl.selected.find((el) => el.type === 'text');
        if (t?.type === 'text') ctl.styleSelected({ italic: t.style?.italic ? undefined : true });
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (ctl.selection.length) {
          e.preventDefault();
          ctl.deleteSelected();
        }
      } else if (!mod && e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 10 : 1;
        if (ctl.selection.length) {
          e.preventDefault();
          ctl.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          ctl.goTo(ctl.current + 1);
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          ctl.goTo(ctl.current - 1);
        }
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        ctl.goTo(ctl.current + 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        ctl.goTo(ctl.current - 1);
      } else if (e.key === 'Escape') {
        ctl.select([]);
      } else if (e.key === 'F5') {
        e.preventDefault();
        ctl.setPresenting(true);
      } else if (e.key === 'Enter' && ctl.selection.length === 1) {
        e.preventDefault();
        ctl.startEditing(ctl.selection[0]);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (ctl.presenting || isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void addImageFiles(files);
      } else ctl.paste();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [ctl, addImageFiles]);

  // Close menus on outside click.
  useEffect(() => {
    if (!openMenu && !ctxMenu) return;
    const close = () => {
      setOpenMenu(null);
      setCtxMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenu, ctxMenu]);

  // Print: lay every slide out on its own page, print, then go back to the editor.
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const t = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  const rename = async (t: string) => {
    const { meta: m } = await api.renameDeck(meta.id, t);
    setMeta(m);
    setTitle(m.title);
  };

  const slideMenu = (index: number): MenuItem[] => [
    { label: 'New slide', shortcut: '', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], action: () => ctl.addSlide(l, {}, index + 1) })) },
    { label: 'Duplicate slide', shortcut: `${MOD}D`, action: () => ctl.duplicateSlide(index) },
    { label: 'Delete slide', danger: true, disabled: ctl.deck.slides.length <= 1, action: () => setDialog({ kind: 'deleteSlide', index }) },
    'sep',
    { label: 'Layout', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], checked: ctl.deck.slides[index]?.layout === l, action: () => ctl.setLayout(l, index) })) },
  ];

  const menus: { key: string; label: string; items: () => MenuItem[] }[] = [
    {
      key: 'file',
      label: 'File',
      items: () => [
        {
          label: 'New presentation',
          action: async () => {
            const { deck } = await api.createDeck('Untitled presentation');
            window.open(`/d/${deck.id}`, '_blank');
          },
        },
        { label: 'Rename…', action: () => setDialog({ kind: 'rename' }) },
        { label: 'Import PowerPoint slides…', action: () => void importPptxSlides() },
        'sep',
        { label: 'Download as PowerPoint (.pptx)', action: () => void exportPptx() },
        { label: 'Print / Save as PDF…', shortcut: `${MOD}P`, action: () => setPrinting(true) },
        { label: 'Download as JSON', action: () => downloadFile(`${meta.title}.json`, 'application/json', JSON.stringify(ctl.deck, null, 2)) },
        'sep',
        { label: 'Delete presentation', danger: true, action: () => setDialog({ kind: 'delete' }) },
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
        { label: 'Copy', shortcut: `${MOD}C`, disabled: !ctl.selection.length, action: () => ctl.copySelected() },
        { label: 'Paste', shortcut: `${MOD}V`, action: () => ctl.paste() },
        { label: 'Duplicate', shortcut: `${MOD}D`, action: () => (ctl.selection.length ? ctl.duplicateSelected() : ctl.duplicateSlide()) },
        { label: 'Delete', shortcut: 'Delete', disabled: !ctl.selection.length, action: () => ctl.deleteSelected() },
        { label: 'Select all', shortcut: `${MOD}A`, action: () => ctl.select(ctl.slide.elements.map((e) => e.id)) },
      ],
    },
    {
      key: 'view',
      label: 'View',
      items: () => [
        { label: 'Present', shortcut: 'F5', action: () => ctl.setPresenting(true) },
        'sep',
        { label: 'Speaker notes', checked: showNotes, action: () => setShowNotes(!showNotes) },
      ],
    },
    {
      key: 'insert',
      label: 'Insert',
      items: () => [
        { label: 'New slide', submenu: LAYOUT_IDS.map((l) => ({ label: LAYOUT_NAMES[l], action: () => ctl.addSlide(l) })) },
        'sep',
        { label: 'Text box', action: () => ctl.addText('body') },
        { label: 'Title', action: () => ctl.addText('title') },
        { label: 'Image…', action: () => void insertImage() },
        { label: 'Shape', submenu: shapeMenuItems(ctl) },
      ],
    },
    {
      key: 'slide',
      label: 'Slide',
      items: () => [
        ...slideMenu(ctl.current),
        { label: 'Theme', submenu: THEME_IDS.map((t) => ({ label: THEMES[t].name, checked: ctl.deck.theme === t, action: () => ctl.setTheme(t) })) },
        { label: 'Remove background color', disabled: !ctl.slide.bg, action: () => ctl.setBackground(undefined) },
      ],
    },
    {
      key: 'arrange',
      label: 'Arrange',
      items: () => [
        { label: 'Bring to front', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'front') },
        { label: 'Bring forward', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'forward') },
        { label: 'Send backward', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'backward') },
        { label: 'Send to back', disabled: !ctl.selection.length, action: () => ctl.reorder(ctl.selection, 'back') },
      ],
    },
  ];

  const saveLabel = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    error: `Save failed — retrying${ctl.saver.error ? ` (${ctl.saver.error})` : ''}`,
  }[ctl.saver.status];

  const onThumbContextMenu = (e: MouseEvent, index: number) => setCtxMenu({ x: e.clientX, y: e.clientY, index });

  return (
    <div className="workbench deck-page">
      {!printing && (
        <>
          <header className="wb-header">
            <Link to="/" className="wb-logo" title="Back to home" onClick={() => void ctl.saver.flush()}>
              <DeckIcon size={32} />
            </Link>
            <div className="wb-titles">
              <div className="wb-title-row">
                <input
                  className="wb-title"
                  value={title}
                  aria-label="Presentation name"
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
          <DeckToolbar ctl={ctl} onPresent={() => ctl.setPresenting(true)} onInsertImage={() => void insertImage()} />
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
          <div className="deck-body" ref={bodyRef}>
            <ThumbnailStrip ctl={ctl} width={tray.width} onContextMenu={onThumbContextMenu} />
            <ResizeHandle panel={tray} side="left" label="Resize slide thumbnails" className="deck-thumbs-resize" />
            <div className="deck-main">
              <DeckEditor ctl={ctl} onImageFiles={(files) => void addImageFiles(files)} />
              {showNotes && <NotesPane ctl={ctl} />}
            </div>
          </div>
        </>
      )}

      {printing && (
        <div className="deck-print">
          {ctl.deck.slides.map((s) => (
            <div key={s.id} className="deck-print-page">
              <SlideView slide={s} theme={ctl.deck.theme} scale={1} />
            </div>
          ))}
        </div>
      )}

      {ctxMenu && (
        <div onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={slideMenu(ctxMenu.index)} onDone={() => setCtxMenu(null)} style={{ position: 'fixed', left: ctxMenu.x, top: ctxMenu.y }} />
        </div>
      )}

      {ctl.presenting && <PresentMode ctl={ctl} onExit={() => ctl.setPresenting(false)} />}

      {dialog?.kind === 'rename' && <PromptModal title="Rename presentation" label="Name" initial={meta.title} confirmText="Rename" onConfirm={rename} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          title="Delete presentation?"
          message={<>“{meta.title}” will be permanently deleted. This cannot be undone.</>}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            ctl.saver.dispose();
            await api.deleteDeck(meta.id);
            navigate('/');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'deleteSlide' && (
        <ConfirmModal
          title="Delete slide?"
          message={<>Delete slide {dialog.index + 1}? You can undo this with {MOD}Z.</>}
          confirmText="Delete"
          danger
          onConfirm={() => void ctl.deleteSlides([dialog.index])}
          onClose={() => setDialog(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/** Speaker notes for the current slide; saved when the field loses focus. */
function NotesPane({ ctl }: { ctl: DeckController }) {
  const slide = ctl.slide;
  const [draft, setDraft] = useState(slide.notes ?? '');
  const [forId, setForId] = useState(slide.id);
  if (forId !== slide.id) {
    setForId(slide.id);
    setDraft(slide.notes ?? '');
  }
  return (
    <div className="deck-notes">
      <textarea
        value={draft}
        placeholder="Speaker notes"
        aria-label="Speaker notes"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== (slide.notes ?? '')) ctl.setNotes(draft);
        }}
      />
    </div>
  );
}
