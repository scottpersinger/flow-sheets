// The WYSIWYG editing surface: a ProseMirror view bound to the DocController's state. Every edit the user
// makes becomes a transaction the controller records (so it undoes), and the view is updated from the store.
// In Pages mode the editor is one continuous column drawn over page frames; the pagination plugin inserts
// spacers so content lands on the pages, and this component draws the frames, numbers, headers and footers.
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ICONS } from './DocToolbar.tsx';
import { docStyleCss, docStyleOf, PAGE_GAP, pageMetrics, pageText, type PageSetup } from '../../../shared/doc.ts';
import { CELL_IMAGE_TYPES } from '../../../shared/types.ts';
import type { DocController } from './controller.ts';

/** Image block with a drag handle to resize it; the new width is stored when the drag ends. */
class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private handle: HTMLElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private dragging = false;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('figure');
    this.dom.className = 'doc-image';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.handle = document.createElement('span');
    this.handle.className = 'doc-image-handle';
    this.handle.title = 'Drag to resize';
    this.handle.addEventListener('mousedown', this.startResize);
    this.dom.append(this.img, this.handle);
    this.render(node);
  }

  private render(node: PMNode): void {
    const { src, alt, width, align } = node.attrs as { src: string; alt: string; width: number | null; align: string | null };
    if (this.img.getAttribute('src') !== src) this.img.src = src;
    this.img.alt = alt || '';
    this.img.style.width = width ? `${width}px` : '';
    if (align) this.dom.dataset.align = align;
    else delete this.dom.dataset.align;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render(node);
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('selected');
  }

  stopEvent(e: Event): boolean {
    return this.dragging || e.target === this.handle;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.handle.removeEventListener('mousedown', this.startResize);
  }

  private startResize = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const pos = this.getPos();
    if (pos === undefined) return;
    this.dragging = true;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    const startX = e.clientX;
    const startW = this.img.getBoundingClientRect().width;
    const scale = this.view.dom.offsetWidth ? this.view.dom.getBoundingClientRect().width / this.view.dom.offsetWidth : 1;
    const max = this.view.dom.clientWidth - 2 * Number.parseFloat(getComputedStyle(this.view.dom).paddingLeft || '0');
    let w = Math.round(startW / scale);
    const move = (ev: MouseEvent) => {
      w = Math.max(40, Math.min(max, Math.round((startW + ev.clientX - startX) / scale)));
      this.img.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.dragging = false;
      const at = this.getPos();
      if (at === undefined) return;
      const tr = this.view.state.tr.setNodeMarkup(at, undefined, { ...this.node.attrs, width: w });
      tr.setSelection(NodeSelection.create(tr.doc, at));
      this.view.dispatch(tr);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
}

function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => CELL_IMAGE_TYPES.includes(f.type));
}

/** Page number, header and footer drawn in the margins of one page. */
export function PageChrome({ setup, page, pages }: { setup: PageSetup; page: number; pages: number }) {
  const m = pageMetrics(setup);
  const number = setup.pageNumbers === 'none' ? null : String(page);
  const header = pageText(setup.header, page, pages);
  const footer = pageText(setup.footer, page, pages);
  return (
    <>
      {(header || setup.pageNumbers === 'top-right') && (
        <div className="doc-page-margin doc-page-header" style={{ top: Math.max(4, m.mt / 2 - 9), left: m.ml, right: m.mr }}>
          <span>{header}</span>
          {setup.pageNumbers === 'top-right' && <span className="doc-page-number">{number}</span>}
        </div>
      )}
      {(footer || setup.pageNumbers === 'bottom-center' || setup.pageNumbers === 'bottom-right') && (
        <div className="doc-page-margin doc-page-footer" style={{ bottom: Math.max(4, m.mb / 2 - 9), left: m.ml, right: m.mr }}>
          <span>{footer}</span>
          {setup.pageNumbers === 'bottom-center' && <span className="doc-page-number centered">{number}</span>}
          {setup.pageNumbers === 'bottom-right' && <span className="doc-page-number">{number}</span>}
        </div>
      )}
    </>
  );
}

/** A small card under the link at the cursor: open it in a new tab, edit it, or remove it. */
function LinkBubble({ ctl }: { ctl: DocController }) {
  const [, setTick] = useState(0);
  // Follow the link when the page scrolls or the window resizes.
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    return () => {
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
    };
  }, []);
  const link = ctl.linkAtCursor();
  if (!link) return null;
  const at = ctl.coordsAt(link.from);
  if (!at) return null;
  const width = 360;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - width - 8));
  const label = link.href.replace(/^mailto:/, '').replace(/^https?:\/\//, '');
  return (
    <div className="doc-link-bubble" style={{ left, top: at.bottom + 6, maxWidth: width }} onMouseDown={(e) => e.preventDefault()} role="dialog" aria-label="Link">
      <a href={link.href} target="_blank" rel="noopener noreferrer" title={`Open ${link.href} in a new tab`}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d={ICONS.link} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{label}</span>
      </a>
      <button className="link" title="Change the link" onClick={() => ctl.onLinkPrompt?.()}>
        Edit
      </button>
      <button className="link" title="Remove the link, keeping the text" onClick={() => ctl.setLink(null)}>
        Remove
      </button>
    </div>
  );
}

export function DocEditor({ ctl, onImageFiles }: { ctl: DocController; onImageFiles(files: File[]): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef(onImageFiles);
  filesRef.current = onImageFiles;
  const [available, setAvailable] = useState(0);

  useEffect(() => {
    const view = new EditorView(ref.current!, {
      state: ctl.state,
      dispatchTransaction: (tr) => ctl.dispatch(tr),
      plugins: [dropCursor({ color: '#1a73e8', width: 2 }), gapCursor()],
      nodeViews: { image: (node, v, getPos) => new ImageView(node, v, getPos) },
      attributes: (state) => ({ class: 'doc-content', spellcheck: 'true', 'aria-label': 'Document text', style: docStyleCss(docStyleOf(state.doc)) }),
      handlePaste: (_v, event) => {
        const files = imageFiles(event.clipboardData);
        if (!files.length) return false;
        filesRef.current(files);
        return true;
      },
      handleDrop: (v, event) => {
        const files = imageFiles(event.dataTransfer);
        if (!files.length) return false;
        const at = v.posAtCoords({ left: event.clientX, top: event.clientY });
        if (at) v.dispatch(v.state.tr.setSelection(TextSelection.near(v.state.doc.resolve(at.pos))));
        filesRef.current(files);
        return true;
      },
      // Cmd/Ctrl+click follows a link; a plain click puts the cursor in it.
      handleClick: (_v, _pos, event) => {
        if (!event.metaKey && !event.ctrlKey) return false;
        const a = (event.target as HTMLElement).closest('a');
        if (!a?.href) return false;
        window.open(a.href, '_blank', 'noopener');
        return true;
      },
      handleDOMEvents: {
        blur: () => {
          ctl.closeHistory();
          return false;
        },
      },
    });
    ctl.attachView(view);
    if (import.meta.env.DEV) (window as unknown as { __docView?: EditorView }).__docView = view; // for poking at pagination in dev tools
    view.focus();
    return () => {
      ctl.attachView(null);
      view.destroy();
    };
  }, [ctl]);

  // The width the page column may use, for fitting the page to the window.
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const update = () => setAvailable(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const doc = ctl.doc;
  const empty = doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
  const setup = ctl.pageSetup();
  const paged = setup.mode === 'pages';
  const m = pageMetrics(setup);
  const { pageCount } = ctl.pagination();
  const scale = paged ? (ctl.zoom === 'fit' ? Math.min(1, Math.max(0.25, (available - 32) / m.pageW)) : ctl.zoom / 100) : 1;
  const columnH = pageCount * m.stride - PAGE_GAP;

  const onMarginClick = (e: React.MouseEvent) => {
    // Clicking the page below the text puts the cursor at the end.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    ctl.run((tr) => tr.setSelection(TextSelection.atEnd(tr.doc)));
    ctl.focus();
  };

  // One tree for both modes: the editor element must stay the same DOM node across View → Pages / Pageless,
  // since the ProseMirror view is mounted in it once.
  return (
    <div className="doc-pages-outer" ref={outerRef} style={paged ? { height: columnH * scale + 24 } : undefined}>
      <div className={paged ? 'doc-pages' : 'doc-sheet'} style={paged ? { width: m.pageW, height: columnH, transform: `scale(${scale})`, transformOrigin: 'top center' } : undefined}>
        {paged
          ? Array.from({ length: pageCount }, (_, k) => (
              <div key={k} className="doc-page-frame" style={{ top: k * m.stride, height: m.pageH }} aria-hidden="true">
                <PageChrome setup={setup} page={k + 1} pages={pageCount} />
              </div>
            ))
          : []}
        <div
          className={`doc-editor${paged ? ' doc-editor-paged' : ''}${empty ? ' doc-empty' : ''}`}
          ref={ref}
          style={paged ? { padding: `${m.mt}px ${m.mr}px ${m.mb}px ${m.ml}px`, minHeight: columnH } : undefined}
          onMouseDown={onMarginClick}
        />
      </div>
      <LinkBubble ctl={ctl} />
    </div>
  );
}

/**
 * Print layout for Pages mode: one box per page, each holding a copy of the editor column shifted up so the
 * page's slice shows, clipped to the page. The copies include the pagination spacers, so what prints is what
 * the screen shows.
 */
export function DocPrint({ ctl }: { ctl: DocController }) {
  const setup = ctl.pageSetup();
  const m = pageMetrics(setup);
  const { pageCount } = ctl.pagination();
  const clips = useRef<(HTMLDivElement | null)[]>([]);

  useLayoutEffect(() => {
    const source = ctl.editorDom();
    if (!source) return;
    clips.current.forEach((clip, k) => {
      if (!clip) return;
      const column = document.createElement('div');
      column.className = 'doc-editor doc-editor-paged';
      column.style.padding = `${m.mt}px ${m.mr}px ${m.mb}px ${m.ml}px`;
      column.style.transform = `translateY(${-k * m.stride}px)`;
      const copy = source.cloneNode(true) as HTMLElement;
      copy.removeAttribute('contenteditable');
      copy.classList.remove('ProseMirror-focused');
      column.append(copy);
      clip.replaceChildren(column);
    });
  }, [ctl, pageCount, m.mt, m.mr, m.mb, m.ml, m.stride]);

  return (
    <div className="doc-print">
      <style>{`@page { size: ${m.widthIn}in ${m.heightIn}in; margin: 0; }`}</style>
      {Array.from({ length: pageCount }, (_, k) => (
        <div key={k} className="doc-print-page" style={{ width: m.pageW, height: m.pageH }}>
          <div
            className="doc-print-clip"
            ref={(el) => {
              clips.current[k] = el;
            }}
          />
          <PageChrome setup={setup} page={k + 1} pages={pageCount} />
        </div>
      ))}
    </div>
  );
}
