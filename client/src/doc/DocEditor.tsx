// The WYSIWYG editing surface: a ProseMirror view bound to the DocController's state. Every edit the user
// makes becomes a transaction the controller records (so it undoes), and the view is updated from the store.
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView, type NodeView } from 'prosemirror-view';
import { useEffect, useRef } from 'react';
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
    const max = this.view.dom.clientWidth;
    let w = Math.round(startW);
    const move = (ev: MouseEvent) => {
      w = Math.max(40, Math.min(max, Math.round(startW + ev.clientX - startX)));
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

export function DocEditor({ ctl, onImageFiles }: { ctl: DocController; onImageFiles(files: File[]): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const filesRef = useRef(onImageFiles);
  filesRef.current = onImageFiles;

  useEffect(() => {
    const view = new EditorView(ref.current!, {
      state: ctl.state,
      dispatchTransaction: (tr) => ctl.dispatch(tr),
      plugins: [dropCursor({ color: '#1a73e8', width: 2 }), gapCursor()],
      nodeViews: { image: (node, v, getPos) => new ImageView(node, v, getPos) },
      attributes: { class: 'doc-content', spellcheck: 'true', 'aria-label': 'Document text' },
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
    view.focus();
    return () => {
      ctl.attachView(null);
      view.destroy();
    };
  }, [ctl]);

  const doc = ctl.doc;
  const empty = doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0;
  return (
    <div
      className={`doc-editor${empty ? ' doc-empty' : ''}`}
      ref={ref}
      onMouseDown={(e) => {
        // Clicking the page below the text puts the cursor at the end.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        ctl.run((tr) => tr.setSelection(TextSelection.atEnd(tr.doc)));
        ctl.focus();
      }}
    />
  );
}
