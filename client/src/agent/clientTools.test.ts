import { describe, expect, it } from 'vitest';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import type { FetchResult } from '../../../shared/connectors.ts';
import { newWorkbook, type Workbook } from '../../../shared/types.ts';
import { csvToWorkbook } from '../../../shared/csv.ts';
import { SheetController } from '../state/controller.ts';
import { csvGuard } from '../state/store.ts';
import { confirmationFor, runClientTool, ToolError, type ClientToolEnv } from './clientTools.ts';

function setup(wb: Workbook = newWorkbook('t1')) {
  const ctl = new SheetController(wb, async () => {});
  const uploads: Blob[] = [];
  const env: ClientToolEnv = {
    ctl,
    deck: null,
    doc: null,
    group: 'agent-1',
    openSheet: async () => ctl,
    openDeck: async () => Promise.reject(new Error('No deck in this test.')),
    openDoc: async () => Promise.reject(new Error('No doc in this test.')),
    requestAppChange: async () => ({ id: 'job-1' }), requestResearch: async (_t, _task, includeSheet) => ({ id: 'job-2', sheetIncluded: includeSheet }),
    uploadImage: async (file) => {
      uploads.push(file);
      return `/api/images/00000000-0000-0000-0000-00000000000${uploads.length}`;
    },
    fetchConnectorData: async () => {
      throw new Error('No connector data in this test.');
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

  it('turns word wrap on and off and reports it in read_range formats', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['a long description', 'x']] });
    await call('format_range', { range: 'A1:B1', wrap: true });
    expect(ctl.tab.cells.A1.st).toEqual({ wrap: true });
    const read = await call('read_range', { range: 'A1:B1', include_formats: true });
    expect(read.formats).toEqual({ A1: { wrap: true }, B1: { wrap: true } });

    await call('format_range', { range: 'B1', wrap: false });
    expect(ctl.tab.cells.B1.st).toBeUndefined();
    expect(ctl.tab.cells.A1.st).toEqual({ wrap: true });
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

  it('moves columns with move_columns, updating formulas on other tabs, and undoes in one step', async () => {
    const { ctl, call } = setup();
    const header = ['id', 'name', 'status', 'primary', 'current_balance', 'available_balance', 'currency'];
    await call('write_range', { start: 'A1', rows: [header, [1, 'Ops', 'open', true, 100, 80, 'USD']] });
    await call('add_tab', { name: 'Summary' });
    await call('write_range', { tab: 'Summary', start: 'A1', rows: [['=Sheet1!F2', '=SUM(Sheet1!E2:F2)']] });
    const res = await call('move_columns', { tab: 'Sheet1', from_column: 'F', before_column: 'E' });
    expect(res).toMatchObject({ new_range: 'E:E', tab: 'Sheet1' });
    const read = await call('read_range', { tab: 'Sheet1', range: 'A1:G1' });
    expect(read.values[0]).toEqual(['id', 'name', 'status', 'primary', 'available_balance', 'current_balance', 'currency']);
    const summary = ctl.store.workbook.tabs[1];
    expect(summary.cells.A1.v).toBe('=Sheet1!E2');
    expect(summary.cells.B1.v).toBe('=SUM(Sheet1!E2:F2)');
    expect(ctl.store.display(summary.id, 0, 0)).toBe('80');

    await expect(call('move_columns', { tab: 'Sheet1', from_column: 'B', to_column: 'C', before_column: 'D' })).rejects.toThrow(ToolError);
    ctl.undo();
    expect(ctl.store.workbook.tabs.length).toBe(1);
    expect(ctl.store.workbook.tabs[0].cells.F1).toBeUndefined();
  });

  it('drags selected columns: selection follows the moved columns and undo restores in one step', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['a', 'b', 'c', 'd']] });
    ctl.selectCols(0, 1);
    expect(ctl.canDragCols(1)).toBe(true);
    expect(ctl.canDragCols(2)).toBe(false);
    ctl.moveCols(4); // A:B to just before E
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => ctl.tab.cells[k].v)).toEqual(['c', 'd', 'a', 'b']);
    expect(ctl.primary).toMatchObject({ c1: 2, c2: 3, r1: 0, r2: ctl.tab.rows - 1 });
    ctl.undo();
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => ctl.tab.cells[k].v)).toEqual(['a', 'b', 'c', 'd']);
    expect(ctl.primary).toMatchObject({ c1: 0, c2: 1 });
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
    const env: ClientToolEnv = { ctl: null, deck: null, doc: null, group: 'g', openSheet: async () => Promise.reject(new Error('x')), openDeck: async () => Promise.reject(new Error('x')), openDoc: async () => Promise.reject(new Error('x')), requestAppChange: async () => ({ id: 'job-1' }), requestResearch: async (_t, _task, includeSheet) => ({ id: 'job-2', sheetIncluded: includeSheet }), uploadImage: async () => '', fetchConnectorData: async () => Promise.reject(new Error('x')) };
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

describe('stored files', () => {
  it('lists files and opens one', async () => {
    const { env, call } = setup();
    const f = (id: string, filename: string) => ({ id, filename, type: 'application/pdf', size: 10, createdAt: '2026-01-01', url: `/api/files/${id}`, downloadUrl: `/api/files/${id}/download` });
    const opened: string[] = [];
    env.listFiles = async () => [f('a', 'Report.pdf'), f('b', 'Other.pdf')];
    env.openFile = async (id) => (opened.push(id), f(id, 'Report.pdf'));
    const listed = await call('list_files', { query: 'report' });
    expect(listed).toMatchObject({ total: 1, files: [{ id: 'a', filename: 'Report.pdf', download_url: '/api/files/a/download' }] });
    expect(await call('open_file', { file_id: 'a' })).toMatchObject({ opened: true, file_id: 'a', filename: 'Report.pdf' });
    expect(opened).toEqual(['a']);
  });
});

describe('ingest_connector_data', () => {
  const result = (rows: FetchResult['rows'], truncated = false): FetchResult => ({
    handle: 'h1',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'posted_at', type: 'date' },
      { name: 'amount', type: 'number' },
      { name: 'merchant', type: 'string' },
    ],
    rows,
    truncated,
    totalRows: rows.length,
  });

  function withData(data: FetchResult) {
    const s = setup();
    const requests: unknown[] = [];
    s.env.fetchConnectorData = async (id, body) => {
      requests.push({ id, ...body });
      return data;
    };
    return { ...s, requests };
  }

  it('creates the tab and writes a header and rows as real numbers, dates and text', async () => {
    const { ctl, call, requests } = withData(result([['0012', '2025-01-03', 12.5, 'TRUE Coffee'], ['tx2', '2025-01-04', -3, '=evil()']]));
    const res = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'card_transactions', params: { posted_at_start: '2025-01-01' }, tab: 'Brex Transactions' });
    expect(requests).toEqual([{ id: 'c1', dataset: 'card_transactions', params: { posted_at_start: '2025-01-01' }, handle: undefined }]);
    expect(res).toMatchObject({ tab: 'Brex Transactions', created_tab: true, range_written: 'Brex Transactions!A1:D3', rows_written: 2, truncated: false });
    const tab = ctl.store.workbook.tabs.find((t) => t.name === 'Brex Transactions')!;
    expect(ctl.tab.id).toBe(tab.id);
    expect(ctl.store.value(tab.id, 1, 2)).toBe(12.5);
    expect(typeof ctl.store.value(tab.id, 1, 1)).toBe('number'); // a date serial
    expect(ctl.store.display(tab.id, 1, 1)).toBe('1/3/2025');
    expect(ctl.store.value(tab.id, 1, 0)).toBe('0012');
    expect(ctl.store.value(tab.id, 2, 3)).toBe('=evil()');
    expect(ctl.store.display(tab.id, 0, 3)).toBe('merchant');
  });

  it('replaces earlier data but keeps formatting, and appends below existing rows', async () => {
    const { ctl, call, env } = withData(result([['a', '2025-01-01', 1, 'x'], ['b', '2025-01-02', 2, 'y'], ['c', '2025-01-03', 3, 'z']]));
    await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd' });
    await call('format_range', { range: 'C:C', number_format: 'currency' });
    env.fetchConnectorData = async () => result([['n', '2025-02-01', 9, 'w']]);
    const res = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd' });
    expect(res.range_written).toBe('Sheet1!A1:D2');
    expect(ctl.store.cell(ctl.tab.id, 2, 0)).toBeUndefined();
    expect(ctl.store.display(ctl.tab.id, 1, 2)).toBe('$9.00');

    const app = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd', mode: 'append' });
    expect(app).toMatchObject({ range_written: 'Sheet1!A3:D3', header_written: false, rows_written: 1 });
  });

  it('writes thousands of rows in one undoable step and reports truncation', async () => {
    const rows = Array.from({ length: 5000 }, (_, k) => [`t${k}`, '2025-01-01', k / 100, 'm']);
    const { ctl, call } = withData(result(rows, true));
    const res = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd', start_cell: 'B2' });
    expect(res).toMatchObject({ range_written: 'Sheet1!B2:E5002', rows_written: 5000, truncated: true });
    ctl.undo();
    expect(Object.keys(ctl.tab.cells)).toHaveLength(0);
  });

  it('sets frozen rows and columns from the grid separators and undoes them', () => {
    const { ctl } = setup();
    ctl.setFrozen(5, undefined);
    ctl.setFrozen(undefined, 1);
    expect(ctl.tab.frozenRows).toBe(5);
    expect(ctl.tab.frozenCols).toBe(1);
    ctl.setFrozen(0, undefined);
    expect(ctl.tab.frozenRows).toBeUndefined();
    expect(ctl.tab.frozenCols).toBe(1);
    ctl.undo();
    expect(ctl.tab.frozenRows).toBe(5);
  });

  it('passes connector errors to Claude', async () => {
    const { call, env } = setup();
    env.fetchConnectorData = async () => {
      throw new Error('Brex rejected the user token (401).');
    };
    await expect(call('ingest_connector_data', { connection_id: 'c1', dataset: 'd' })).rejects.toThrow(/401/);
  });
});

describe('CSV files', () => {
  function csvSetup() {
    const s = setup(csvToWorkbook('Name,Qty\nPens,3\nPaper,1\n'));
    s.ctl.store.guard = csvGuard;
    return s;
  }

  it('takes values, formulas, sorting and row changes from the assistant', async () => {
    const { ctl, call } = csvSetup();
    await call('write_range', { start: 'A4', rows: [['Total', '=SUM(B2:B3)']] });
    expect(ctl.store.display(ctl.tab.id, 3, 1)).toBe('4');
    await call('sort_range', { range: 'A2:B3', by_column: 'B' });
    expect(ctl.tab.cells.A2).toEqual({ v: 'Paper' });
    expect(csvGuard([])).toBeNull();
  });

  it('refuses what CSV cannot store, changes nothing and says to convert', async () => {
    const { ctl, call } = csvSetup();
    const before = JSON.stringify(ctl.store.workbook);
    await expect(call('format_range', { range: 'A1:B1', bold: true })).rejects.toThrow(/CSV file.*cell formatting.*Convert to spreadsheet/s);
    await expect(call('freeze', { rows: 1 })).rejects.toThrow(ToolError);
    await expect(call('add_tab', { name: 'More' })).rejects.toThrow(/more than one sheet/);
    expect(JSON.stringify(ctl.store.workbook)).toBe(before);
    expect(ctl.store.canUndo()).toBe(false);
  });

  it('offers the user a retry, which goes through once the file is converted', () => {
    const { ctl } = csvSetup();
    let asked: { reason: string; retry: () => void } | null = null;
    ctl.onRefused = (reason, retry) => (asked = { reason, retry });
    ctl.setStyle({ b: true });
    expect(asked!.reason).toBe('Cell formatting');
    expect(ctl.tab.cells.A1).toEqual({ v: 'Name' });
    ctl.store.guard = null;
    asked!.retry();
    expect(ctl.tab.cells.A1).toEqual({ v: 'Name', st: { b: true } });
    ctl.undo();
    expect(ctl.tab.cells.A1).toEqual({ v: 'Name' });
  });
});
