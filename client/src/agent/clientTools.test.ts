import { describe, expect, it } from 'vitest';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { newWorkbook, type Workbook } from '../../../shared/types.ts';
import { SheetController } from '../state/controller.ts';
import { confirmationFor, runClientTool, ToolError, type ClientToolEnv } from './clientTools.ts';

function setup(wb: Workbook = newWorkbook('t1')) {
  const ctl = new SheetController(wb, async () => {});
  const env: ClientToolEnv = { ctl, group: 'agent-1', openSheet: async () => ctl };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  return { ctl, env, call };
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
    const env: ClientToolEnv = { ctl: null, group: 'g', openSheet: async () => Promise.reject(new Error('x')) };
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
});
