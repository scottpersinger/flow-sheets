// What the assistant sees of a document: its top-level blocks, numbered from 1, each as Markdown.
import type { Node as PMNode } from 'prosemirror-model';
import { blockType } from '../doc.ts';
import { blockToMarkdown } from '../docMarkdown.ts';

/** Blocks listed by one read_doc call without a range. */
export const MAX_OUTLINE_BLOCKS = 300;
const MAX_SELECTED_TEXT = 500;

export interface DocOutlineOptions {
  /** 1-based range of blocks to list (defaults to the first MAX_OUTLINE_BLOCKS). */
  from?: number;
  to?: number;
  /** 1-based number of the block holding the user's cursor. */
  cursorBlock?: number;
  selectedText?: string;
  /** 1-based page each block starts on (Pages mode in the browser only). */
  pages?: (number | null)[];
}

export function docOutline(doc: PMNode, opts: DocOutlineOptions = {}) {
  const total = doc.childCount;
  const from = Math.min(Math.max(1, opts.from ?? 1), Math.max(1, total));
  const to = Math.min(total, opts.to ?? from + MAX_OUTLINE_BLOCKS - 1);
  const blocks = [];
  for (let k = from - 1; k < to; k++) {
    const node = doc.child(k);
    const page = opts.pages?.[k];
    blocks.push({
      n: k + 1,
      type: blockType(node),
      ...(node.attrs.align ? { align: node.attrs.align as string } : {}),
      ...(page ? { page } : {}),
      markdown: blockToMarkdown(node),
    });
  }
  const selected = opts.selectedText?.trim();
  return {
    block_count: total,
    ...(opts.cursorBlock ? { cursor_block: opts.cursorBlock } : {}),
    ...(selected ? { selected_text: selected.length > MAX_SELECTED_TEXT ? `${selected.slice(0, MAX_SELECTED_TEXT)}…` : selected } : {}),
    ...(from > 1 || to < total ? { showing_blocks: `${from}-${to}`, note: 'Call read_doc with from and to for other blocks.' } : {}),
    blocks,
  };
}
