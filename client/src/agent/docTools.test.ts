import { describe, expect, it } from 'vitest';
import { docNode, docText } from '../../../shared/doc.ts';
import { docToMarkdown, markdownToDoc } from '../../../shared/docMarkdown.ts';
import { DocController } from '../doc/controller.ts';
import { confirmationFor, runClientTool, type ClientToolEnv } from './clientTools.ts';

function setup(markdown = '') {
  const doc = new DocController(markdownToDoc(markdown), async () => {});
  const env: ClientToolEnv = {
    ctl: null,
    deck: null,
    doc,
    group: 'agent-1',
    openSheet: async () => Promise.reject(new Error('No sheet in this test.')),
    openDeck: async () => Promise.reject(new Error('No deck in this test.')),
    openDoc: async () => doc,
    requestAppChange: async () => ({ id: 'job-1' }),
    requestResearch: async () => ({ id: 'job-2', sheetIncluded: false }),
    uploadImage: async () => '/api/images/00000000-0000-0000-0000-000000000001',
    fetchConnectorData: async () => Promise.reject(new Error('x')),
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  const md = () => docToMarkdown(doc.doc);
  return { doc, env, call, md };
}

describe('agent document tools', () => {
  it('reads the document as numbered markdown blocks', async () => {
    const { call } = setup('# Title\n\nHello **world**.\n\n- a\n- b');
    const res = await call('read_doc');
    expect(res.block_count).toBe(3);
    expect(res.cursor_block).toBe(1);
    expect(res.blocks).toEqual([
      { n: 1, type: 'heading1', markdown: '# Title' },
      { n: 2, type: 'paragraph', markdown: 'Hello **world**.' },
      { n: 3, type: 'bullet_list', markdown: '- a\n- b' },
    ]);
    const part = await call('read_doc', { from: 2, to: 2 });
    expect(part.blocks.map((b: { n: number }) => b.n)).toEqual([2]);
    expect(part.showing_blocks).toBe('2-2');
  });

  it('inserts, replaces and deletes blocks, and undoes one request as a single step', async () => {
    const { doc, call, md } = setup('# Title\n\nFirst.');
    let res = await call('insert_content', { markdown: 'Second.\n\nThird.' });
    expect(res).toEqual({ inserted_blocks: [3, 4], block_count: 4 });
    res = await call('insert_content', { markdown: 'Intro.', after: 1 });
    expect(res).toEqual({ inserted_blocks: [2], block_count: 5 });
    res = await call('insert_content', { markdown: 'Top.', after: 0 });
    expect(res.inserted_blocks).toEqual([1]);
    expect(md()).toBe('Top.\n\n# Title\n\nIntro.\n\nFirst.\n\nSecond.\n\nThird.');

    res = await call('replace_blocks', { from: 3, to: 4, markdown: '## Section\n\n1. one\n2. two' });
    expect(res).toEqual({ replaced_blocks: [3, 4], new_blocks: [3, 4], block_count: 6 });
    expect(md()).toBe('Top.\n\n# Title\n\n## Section\n\n1. one\n2. two\n\nSecond.\n\nThird.');

    res = await call('delete_blocks', { from: 5, to: 6 });
    expect(res).toEqual({ deleted_blocks: 2, block_count: 4 });
    expect(md()).toBe('Top.\n\n# Title\n\n## Section\n\n1. one\n2. two');

    doc.undo();
    expect(md()).toBe('# Title\n\nFirst.');
    expect(doc.store.canUndo()).toBe(false);
    doc.redo();
    expect(md()).toBe('Top.\n\n# Title\n\n## Section\n\n1. one\n2. two');

    // Deleting everything leaves an empty paragraph.
    await call('delete_blocks', { from: 1, to: 4 });
    expect(doc.doc.childCount).toBe(1);
    expect(docText(doc.doc)).toBe('');
    await expect(call('delete_blocks', { from: 2 })).rejects.toThrow(/no block 2/);
  });

  it('replaces text in place, keeping formatting', async () => {
    const { call, md } = setup('The **quick** fox.\n\n- quick one\n- slow one');
    let res = await call('replace_text', { find: 'quick', replace: 'fast' });
    expect(res).toEqual({ replaced: 2, blocks: [1, 2] });
    expect(md()).toBe('The **fast** fox.\n\n- fast one\n- slow one');
    res = await call('replace_text', { find: 'one', replace: 'two', block: 2 });
    expect(res.replaced).toBe(2);
    await expect(call('replace_text', { find: 'missing', replace: 'x' })).rejects.toThrow(/not found/);
  });

  it('formats text and blocks without retyping', async () => {
    const { doc, call, md } = setup('Alpha beta gamma.\n\nBeta again.\n\nThird.');
    let res = await call('format_text', { find: 'beta', bold: true, color: '#c00000' });
    expect(res).toEqual({ formatted: '1 occurrence of "beta"', changed: ['bold', 'color'] });
    expect(md()).toBe('Alpha **<span style="color: #c00000">beta</span>** gamma.\n\nBeta again.\n\nThird.');
    await call('format_text', { find: 'beta', bold: false, color: '', link: 'https://example.com' });
    expect(md()).toBe('Alpha [beta](https://example.com) gamma.\n\nBeta again.\n\nThird.');
    res = await call('format_text', { from: 2, italic: true });
    expect(md()).toBe('Alpha [beta](https://example.com) gamma.\n\n*Beta again.*\n\nThird.');
    await expect(call('format_text', { find: 'x', link: 'javascript:1' })).rejects.toThrow(/http/);
    await expect(call('format_text', { bold: true })).rejects.toThrow(/find/);

    res = await call('format_blocks', { from: 1, to: 2, type: 'bullet_list' });
    expect(res).toEqual({ blocks: [1], type: 'bullet_list', block_count: 2 });
    expect(md()).toBe('- Alpha [beta](https://example.com) gamma.\n- *Beta again.*\n\nThird.');
    res = await call('format_blocks', { from: 1, type: 'heading2', align: 'center' });
    expect(res).toEqual({ blocks: [1, 2], type: 'heading2', align: 'center', block_count: 3 });
    expect(md()).toBe('## Alpha [beta](https://example.com) gamma.\n\n## *Beta again.*\n\nThird.');
    expect(doc.doc.child(0).attrs).toMatchObject({ level: 2, align: 'center' });
    await call('format_blocks', { from: 1, to: 3, type: 'blockquote' });
    expect(md()).toBe('> ## Alpha [beta](https://example.com) gamma.\n>\n> ## *Beta again.*\n>\n> Third.');
    await call('format_blocks', { from: 1, type: 'code_block' });
    expect(doc.doc.child(0).type.name).toBe('code_block');
    expect(doc.doc.child(0).textContent).toBe('Alpha beta gamma.\nBeta again.\nThird.');
    await call('format_blocks', { from: 1, type: 'paragraph' });
    expect(docText(doc.doc)).toBe('Alpha beta gamma.\nBeta again.\nThird.');
  });

  it('sets the title and subtitle, fonts and sizes', async () => {
    const { doc, call, md } = setup('Report\n\nAbout last year\n\nBody text.');
    await call('format_blocks', { from: 1, type: 'title' });
    await call('format_blocks', { from: 2, type: 'subtitle' });
    expect(md()).toBe('# Report {.title}\n\n## About last year {.subtitle}\n\nBody text.');
    const outline = await call('read_doc');
    expect(outline.blocks.map((b: { type: string }) => b.type)).toEqual(['title', 'subtitle', 'paragraph']);
    let res = await call('format_text', { find: 'Body', font: 'Georgia', size: 14 });
    expect(res.changed).toEqual(['font', 'size']);
    expect(md()).toBe('# Report {.title}\n\n## About last year {.subtitle}\n\n<span style="font-family: Georgia, serif"><span style="font-size: 14pt">Body</span></span> text.');
    res = await call('format_text', { find: 'Body', font: '', size: 0 });
    expect(md()).toBe('# Report {.title}\n\n## About last year {.subtitle}\n\nBody text.');
    await expect(call('format_text', { find: 'Body', size: 500 })).rejects.toThrow(/between/);
    await expect(call('format_text', { find: 'Body', font: 'x;y' })).rejects.toThrow(/font name/);
    await call('format_blocks', { from: 1, to: 2, type: 'paragraph' });
    expect(doc.doc.child(0).type.name).toBe('paragraph');
  });

  it('inserts images and checks their addresses', async () => {
    const { doc, call, md } = setup('Text.');
    const res = await call('insert_image', { src: '/api/images/00000000-0000-0000-0000-000000000001', alt: 'Chart', width: 300, align: 'center', after: 0 });
    expect(res).toEqual({ inserted_block: 1, block_count: 2 });
    expect(doc.doc.child(0).attrs).toEqual({ src: '/api/images/00000000-0000-0000-0000-000000000001', alt: 'Chart', width: 300, align: 'center' });
    expect(md()).toBe('![Chart](/api/images/00000000-0000-0000-0000-000000000001)\n\nText.');
    await expect(call('insert_image', { src: 'javascript:alert(1)' })).rejects.toThrow();
    await expect(call('insert_content', { markdown: '![x](javascript:alert(1))' })).resolves.toBeTruthy(); // not an image: literal text
    expect(doc.doc.lastChild!.type.name).toBe('paragraph');
  });

  it('asks before deleting content or replacing many blocks, and needs an open document', async () => {
    const { doc } = setup('One.\n\nTwo.\n\n\n\nThree.');
    expect(confirmationFor({ id: 'x', name: 'delete_blocks', input: { from: 1, to: 2 } }, null, null, doc)).toBe('Delete blocks 1–2 of the document?');
    expect(confirmationFor({ id: 'x', name: 'delete_blocks', input: { from: 9 } }, null, null, doc)).toBeNull();
    expect(confirmationFor({ id: 'x', name: 'replace_blocks', input: { from: 1, markdown: 'x' } }, null, null, doc)).toBeNull();
    const big = setup(Array.from({ length: 12 }, (_, k) => `P${k}.`).join('\n\n'));
    expect(confirmationFor({ id: 'x', name: 'replace_blocks', input: { from: 1, to: 10, markdown: 'x' } }, null, null, big.doc)).toBe('Replace blocks 1–10 (10 blocks) of the document?');

    const { env } = setup();
    env.doc = null;
    await expect(runClientTool({ id: 'x', name: 'read_doc', input: {} }, env)).rejects.toThrow(/No document is open/);
    const opened = JSON.parse(await runClientTool({ id: 'x', name: 'open_doc', input: { doc_id: 'any' } }, { ...env, doc: null }));
    expect(opened.opened).toBe(true);
    expect(opened.block_count).toBe(1);
  });

  it('round-trips a stored document through the controller', () => {
    const stored = markdownToDoc('# T\n\nBody *x*');
    const doc = new DocController(stored, async () => {});
    expect(doc.store.document).toEqual(stored);
    expect(docToMarkdown(docNode(doc.store.document))).toBe('# T\n\nBody *x*');
  });
});
