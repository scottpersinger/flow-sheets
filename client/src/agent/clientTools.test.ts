import { describe, expect, it } from 'vitest';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { newWorkbook, type Workbook } from '../../../shared/types.ts';
import { SheetController } from '../state/controller.ts';
import { confirmationFor, runClientTool, ToolError, type ClientToolEnv } from './clientTools.ts';

function setup(wb: Workbook = newWorkbook('t1')) {
  const ctl = new SheetController(wb, async () => {});
  const uploads: Blob[] = [];
  const env: ClientToolEnv = {
    ctl,
    group: 'agent-1',
    openSheet: async () => ctl,
    requestAppChange: async () => ({ id: 'job-1' }), requestResearch: async (_t, _task, includeSheet) => ({ id: 'job-2', sheetIncluded: includeSheet }),
    uploadImage: async (file) => {
      uploads.push(file);
      return `/api/images/00000000-0000-0000-0000-00000000000${uploads.length}`;
    },
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  return { ctl, env, call, uploads };
}

describe('agent sheet tools', () => {
  it('writes values and formulas, then reads computed values back', async () => {
    const { ctl, call } = setup();
    const res = await call('write_range', { start: 'A1', rows: [['Item', 'Cost'], ['Pens', 3], ['Paper', 4.5], ['Total', '=SUM(B2:B3)']] });
    expect(res).toMatchObject({ wrote: 'Sheet1!A1:B4', cells: 8 });
    expect(ctl.store.display(ctl.tab.id, 3, 1)).toBe('7.5');

    const read = await call('read_range', { range: 'A1:B4', include_formulas: true });
    expect(read.values).toEqual([['Item', 'Cost'], ['Pens', '3'], ['Paper', '4.5'], ['Total', '7.5']]);
    expect(read.formulas).toEqual({ B4: '=SUM(B2:B3)' });
  });

  it('reports formula errors in what it wrote', async () => {
    const { call } = setup();
    const res = await call('write_range', { start: 'A1', rows: [['=NOPE(1)']] });
    expect(res.cells_with_errors[0]).toMatchObject({ cell: 'A1' });
  });

  it('undoes all edits from one request as a single step', async () => {
    const { ctl, call } = setup();
    ctl.run((tx) => tx.setCell(ctl.tab.id, 'D1', { v: 'mine' }));
    await call('write_range', { start: 'A1', rows: [['a', 'b']] });
    await call('format_range', { range: 'A1:B1', bold: true, fill_color: '#ffff00' });
    await call('insert_rows', { at_row: 1, count: 1 });
    expect(ctl.store.cell(ctl.tab.id, 1, 0)).toEqual({ v: 'a', st: { b: true, bg: '#ffff00' } });

    ctl.undo();
    expect(ctl.store.cell(ctl.tab.id, 0, 0)).toBeUndefined();
    expect(ctl.store.cell(ctl.tab.id, 0, 3)).toEqual({ v: 'mine' });
  });

  it('grows the tab to fit what it writes', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'AB1001', rows: [['far']] });
    expect(ctl.tab.rows).toBe(1001);
    expect(ctl.tab.cols).toBe(28);
  });

  it('sorts by a column below a header row', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['Name', 'Score'], ['b', 2], ['a', 3], ['c', 1]] });
    await call('sort_range', { range: 'A:B', by_column: 'B', has_header: true, ascending: false });
    const read = await call('read_range', { range: 'A1:B4' });
    expect(read.values.map((r: string[]) => r[0])).toEqual(['Name', 'a', 'b', 'c']);
    expect(ctl.tab.cells.A1.v).toBe('Name');
  });

  it('puts an image from a URL in a cell, reads it as [image], and undoes it', async () => {
    const { ctl, call } = setup();
    const url = 'https://example.com/logo.png';
    expect(await call('set_cell_image', { range: 'I9', url })).toEqual({ image_in: 'Sheet1!I9' });
    expect(ctl.tab.cells.I9).toEqual({ v: '', img: url });
    expect((await call('read_range', { range: 'I9' })).values).toEqual([['[image]']]);
    await expect(call('set_cell_image', { range: 'A1', url: 'javascript:alert(1)' })).rejects.toThrow(ToolError);
    await expect(call('set_cell_image', { range: 'A1:Z100', url })).rejects.toThrow(/at most 100/);
    ctl.undo();
    expect(ctl.tab.cells.I9).toBeUndefined();
  });

  it('makes cells links with set_cell_link and reports links in read_range', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'D2', rows: [['https://en.wikipedia.org/wiki/Eat_a_Peach'], ['n/a (original)']] });
    const res = await call('set_cell_link', { range: 'A1', url: 'https://example.com/?q="x"', label: 'Say "hi"' });
    expect(res).toEqual({ linked: 'Sheet1!A1', url: 'https://example.com/?q="x"', label: 'Say "hi"' });
    await call('set_cell_link', { range: 'B1:B2', url: 'mailto:me@example.com' });
    expect(ctl.store.display(ctl.tab.id, 1, 1)).toBe('mailto:me@example.com');
    const read = await call('read_range', { range: 'A1:D3' });
    expect(read.values[0][0]).toBe('Say "hi"');
    expect(read.links).toEqual({
      A1: 'https://example.com/?q="x"',
      B1: 'mailto:me@example.com',
      B2: 'mailto:me@example.com',
      D2: 'https://en.wikipedia.org/wiki/Eat_a_Peach',
    });
    await expect(call('set_cell_link', { range: 'A1', url: 'javascript:alert(1)' })).rejects.toThrow(ToolError);
    ctl.undo();
    expect(ctl.tab.cells.A1).toBeUndefined();
  });

  it('stores data: URL images on the server and puts the reference in the cell', async () => {
    const { ctl, call, uploads } = setup();
    await call('set_cell_image', { range: 'A15', url: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].type).toBe('image/png');
    expect(uploads[0].size).toBe(8);
    expect(ctl.tab.cells.A15).toEqual({ v: '', img: '/api/images/00000000-0000-0000-0000-000000000001' });
  });

  it('sets filter criteria on filter columns, combined with AND', async () => {
    const { ctl, call } = setup();
    await expect(call('set_filter_criteria', { column: 'B', values: ['France'] })).rejects.toThrow(/set_filter/);
    await call('write_range', {
      start: 'A1',
      rows: [['Name', 'Country', 'Tier'], ['Alice', 'France', 'Gold'], ['Bob', 'Spain', 'Gold'], ['Chloé', 'france', 'Silver'], ['Dan', 'Italy', 'Silver']],
    });
    await call('set_filter', { range: 'A1:C5' });
    await expect(call('set_filter_criteria', { column: 'D', values: ['x'] })).rejects.toThrow(/not inside/);

    expect(await call('set_filter_criteria', { column: 'b', values: ['FRANCE'] })).toMatchObject({ column: 'B', visible_rows: 2 });
    expect([...ctl.hiddenRows()].sort()).toEqual([2, 4]);
    expect(await call('set_filter_criteria', { column: 'C', values: ['Gold'] })).toMatchObject({ visible_rows: 1 });
    expect(await call('set_filter_criteria', { column: 'B', clear: true })).toMatchObject({ visible_rows: 2 });
    expect(ctl.tab.filter!.cols[1]).toBeUndefined();
    expect([...ctl.hiddenRows()].sort()).toEqual([3, 4]);
  });

  it('sets row heights for a row or span, undoably', async () => {
    const { ctl, call } = setup();
    expect(await call('set_row_height', { rows: '1', height: 40 })).toEqual({ tab: 'Sheet1', rows: '1', height: 40 });
    expect(ctl.tab.rowHeights).toEqual({ 0: 40 });
    expect(await call('set_row_height', { rows: '5:3', height: 30 })).toMatchObject({ rows: '3:5', height: 30 });
    expect(ctl.tab.rowHeights).toEqual({ 0: 40, 2: 30, 3: 30, 4: 30 });
    await expect(call('set_row_height', { rows: 'A', height: 30 })).rejects.toThrow(ToolError);
    await expect(call('set_row_height', { rows: '0', height: 30 })).rejects.toThrow(/from 1/);
    ctl.undo();
    expect(ctl.tab.rowHeights).toEqual({});
  });

  it('works with tabs by name and switches to the tab it edits', async () => {
    const { ctl, call } = setup();
    await call('add_tab', { name: 'Summary' });
    expect(ctl.tab.name).toBe('Summary');
    ctl.switchTab(ctl.store.workbook.tabs[0].id);
    await call('write_range', { tab: 'Summary', start: 'A1', rows: [['=Sheet1!A1']] });
    expect(ctl.tab.name).toBe('Summary');
    await call('rename_tab', { tab: 'Sheet1', name: 'Data' });
    expect(ctl.store.workbook.tabs[1].cells.A1.v).toBe('=Data!A1');
    await expect(call('read_range', { range: 'Nope!A1' })).rejects.toThrow(ToolError);
  });

  it('describes the spreadsheet and the selection', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['h1', 'h2'], [1, 2]] });
    ctl.selectRange({ r1: 1, c1: 0, r2: 1, c2: 1 });
    const res = await call('get_sheet_overview');
    expect(res.tabs[0]).toMatchObject({ name: 'Sheet1', active: true, used_range: 'A1:B2', first_rows: [['h1', 'h2'], ['1', '2']] });
    expect(res.selection).toEqual(['A2:B2']);
  });

  it('fails clearly when no spreadsheet is open', async () => {
    const env: ClientToolEnv = { ctl: null, group: 'g', openSheet: async () => Promise.reject(new Error('x')), requestAppChange: async () => ({ id: 'job-1' }), requestResearch: async (_t, _task, includeSheet) => ({ id: 'job-2', sheetIncluded: includeSheet }), uploadImage: async () => '' };
    await expect(runClientTool({ id: 'x', name: 'read_range', input: { range: 'A1' } }, env)).rejects.toThrow(/No spreadsheet is open/);
  });

  it('asks before destructive actions', async () => {
    const { ctl, call } = setup();
    const c = (name: string, input: Record<string, unknown>): ClientToolCall => ({ id: 'x', name, input });
    expect(confirmationFor(c('delete_tab', { tab: 'Sheet1' }), ctl)).toMatch(/Delete the tab/);
    expect(confirmationFor(c('delete_rows', { from_row: 5, to_row: 2 }), ctl)).toBe('Delete rows 2–5 of “Sheet1”?');
    expect(confirmationFor(c('clear_range', { range: 'A1:A5' }), ctl)).toBeNull();
    await call('write_range', { start: 'A1', rows: Array.from({ length: 150 }, (_, i) => [i]) });
    expect(confirmationFor(c('clear_range', { range: 'A:A' }), ctl)).toMatch(/Clear 150 cells/);
    expect(confirmationFor(c('write_range', { start: 'A1', rows: [[1]] }), ctl)).toBeNull();
  });

  it('asks before changing the app, then queues the change', async () => {
    const { ctl, call } = setup();
    const input = { title: 'Add set_filter_values', spec: 'Let the assistant choose which values a filter shows.' };
    expect(confirmationFor({ id: 'x', name: 'request_app_change', input }, ctl)).toMatch(/Change the app: Add set_filter_values\?/);
    expect(confirmationFor({ id: 'x', name: 'request_app_change', input }, null)).toMatch(/Change the app/);
    expect(await call('request_app_change', input)).toMatchObject({ job_id: 'job-1', status: 'queued' });
  });

  it('queues a research task, including the open spreadsheet by default', async () => {
    const { call } = setup();
    const input = { title: 'Find each company\u2019s revenue', task: 'For every company in column A, find its 2025 revenue and the source.' };
    expect(await call('request_research', input)).toMatchObject({ job_id: 'job-2', status: 'queued', sheet_included: true });
    expect(await call('request_research', { ...input, include_open_sheet: false })).toMatchObject({ sheet_included: false });
  });
});
