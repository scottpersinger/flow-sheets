// Sheet tools the agent calls, run in the browser against the open spreadsheet's live store.
// Edits go through SheetController.runAgent, so they recalculate, render and autosave like the user's
// own edits, and everything from one agent request undoes as a single step.
import { MAX_COLS, colToName, nameToCol, rangeToString, type Range } from '../../../shared/cellref.ts';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { findTab, readRange, resolveRange, sheetOverview, splitTabRange } from '../../../shared/agent/sheetRead.ts';
import type { CellStyle, Tab } from '../../../shared/types.ts';
import { CellError } from '../../../shared/values.ts';
import type { SheetController } from '../state/controller.ts';
import * as ops from '../state/ops.ts';
import type { WorkbookStore } from '../state/store.ts';

export interface ClientToolEnv {
  /** The open spreadsheet, or null on the home page. */
  ctl: SheetController | null;
  /** Undo group for this agent request. */
  group: string;
  /** Navigate to a spreadsheet and resolve once it has loaded. */
  openSheet(id: string): Promise<SheetController>;
}

export class ToolError extends Error {}

const MAX_WRITE_CELLS = 20_000;
const CONFIRM_CLEAR_CELLS = 100;

type Input = Record<string, unknown>;
type CellInput = string | number | boolean | null;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function requireSheet(env: ClientToolEnv): SheetController {
  if (!env.ctl) throw new ToolError('No spreadsheet is open. Use list_sheets to find one and open_sheet to open it.');
  return env.ctl;
}

function tabOf(ctl: SheetController, name: string | undefined): Tab {
  const t = findTab(ctl.store.workbook, name, ctl.tab.id);
  if (typeof t === 'string') throw new ToolError(t);
  return t;
}

function rangeOf(ctl: SheetController, tab: string | undefined, range: string): { tab: Tab; range: Range } {
  const r = resolveRange(ctl.store.workbook, tab, range, ctl.tab.id);
  if (typeof r === 'string') throw new ToolError(r);
  return r;
}

function columnOf(letters: string): number {
  return nameToCol(letters.toUpperCase());
}

function source(ctl: SheetController) {
  return { workbook: ctl.store.workbook, engine: ctl.store.engine };
}

/** Bring the tab the agent is working on into view. */
function show(ctl: SheetController, tabId: string) {
  if (ctl.activeTabId !== tabId) ctl.switchTab(tabId);
}

/** Cells in a range that evaluate to an error, so the agent can fix its formulas. */
function errorsIn(ctl: SheetController, tab: Tab, rg: Range, limit = 20): { cell: string; error: string }[] {
  const out: { cell: string; error: string }[] = [];
  for (const { r, c, key } of ops.existingKeysIn(tab, rg)) {
    const v = ctl.store.value(tab.id, r, c);
    if (v instanceof CellError) out.push({ cell: key, error: v.message ? `${v.code} ${v.message}` : v.code });
    if (out.length >= limit) break;
  }
  return out;
}

function nonEmptyCount(tab: Tab, rg: Range): number {
  return ops.existingKeysIn(tab, rg).filter(({ key }) => tab.cells[key].v !== '').length;
}

/** A question to ask the user before running a destructive call, or null if it can run straight away. */
export function confirmationFor(call: ClientToolCall, ctl: SheetController | null): string | null {
  if (!ctl) return null;
  const i = call.input;
  try {
    switch (call.name) {
      case 'delete_tab':
        return `Delete the tab “${tabOf(ctl, str(i.tab)).name}”?`;
      case 'delete_rows': {
        const [a, b] = [Number(i.from_row), Number(i.to_row)].sort((x, y) => x - y);
        return `Delete ${a === b ? `row ${a}` : `rows ${a}–${b}`} of “${tabOf(ctl, str(i.tab)).name}”?`;
      }
      case 'delete_columns': {
        const [a, b] = [String(i.from_column), String(i.to_column)].map((s) => s.toUpperCase()).sort((x, y) => columnOf(x) - columnOf(y));
        return `Delete ${a === b ? `column ${a}` : `columns ${a}–${b}`} of “${tabOf(ctl, str(i.tab)).name}”?`;
      }
      case 'clear_range': {
        if (i.what === 'formats') return null;
        const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
        const n = nonEmptyCount(tab, range);
        return n > CONFIRM_CLEAR_CELLS ? `Clear ${n} cells in ${tab.name}!${rangeToString(range)}?` : null;
      }
      default:
        return null;
    }
  } catch {
    return null; // The call will fail with a useful error when it runs.
  }
}

/** Run a client tool. Returns the result for Claude; throws ToolError for errors Claude should see. */
export async function runClientTool(call: ClientToolCall, env: ClientToolEnv): Promise<string> {
  const i = call.input;
  if (call.name === 'open_sheet') {
    const ctl = await env.openSheet(String(i.sheet_id));
    return JSON.stringify({ opened: true, ...sheetOverview(source(ctl), { activeTabId: ctl.tab.id, selection: ctl.sel.ranges.map(rangeToString) }) });
  }

  const ctl = requireSheet(env);
  const run = (fn: Parameters<SheetController['runAgent']>[1]) => ctl.runAgent(env.group, fn);

  switch (call.name) {
    case 'get_sheet_overview':
      return JSON.stringify(sheetOverview(source(ctl), { activeTabId: ctl.tab.id, selection: ctl.sel.ranges.map(rangeToString) }));

    case 'read_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      return JSON.stringify(readRange(source(ctl), tab, range, { formulas: !!i.include_formulas, formats: !!i.include_formats }));
    }

    case 'write_range': {
      const { tab: prefix, range: startRef } = splitTabRange(String(i.start));
      const tab = tabOf(ctl, prefix ?? str(i.tab));
      const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(startRef);
      if (!m) throw new ToolError(`"${i.start}" is not a cell address. Use one cell, such as A1.`);
      const r0 = Number(m[2]) - 1;
      const c0 = columnOf(m[1]);
      const rows = i.rows as CellInput[][];
      const nRows = rows.length;
      const nCols = Math.max(...rows.map((r) => r.length));
      if (nRows * nCols > MAX_WRITE_CELLS) throw new ToolError(`That is more than ${MAX_WRITE_CELLS} cells; write it in smaller blocks.`);
      if (c0 + nCols > MAX_COLS) throw new ToolError('That would go past the last column.');
      let written = 0;
      run((tx) => {
        if (r0 + nRows > tab.rows) tx.setTabProp(tab.id, 'rows', r0 + nRows);
        if (c0 + nCols > tab.cols) tx.setTabProp(tab.id, 'cols', c0 + nCols);
        rows.forEach((row, dr) =>
          row.forEach((v, dc) => {
            if (v === null || v === undefined) return;
            ops.setInput(tx, tab.id, r0 + dr, c0 + dc, typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
            written++;
          }),
        );
      });
      show(ctl, tab.id);
      const rg = { r1: r0, c1: c0, r2: r0 + nRows - 1, c2: c0 + nCols - 1 };
      const errors = errorsIn(ctl, tab, rg);
      return JSON.stringify({ wrote: `${tab.name}!${rangeToString(rg)}`, cells: written, ...(errors.length ? { cells_with_errors: errors } : {}) });
    }

    case 'clear_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      const what = (str(i.what) ?? 'contents') as 'contents' | 'formats' | 'all';
      run((tx) => {
        if (what === 'contents') ops.clearContents(tx, tab.id, [range]);
        else if (what === 'formats') ops.clearFormatting(tx, tab.id, [range]);
        else for (const { key } of ops.existingKeysIn(tab, range)) tx.setCell(tab.id, key, undefined);
      });
      show(ctl, tab.id);
      return JSON.stringify({ cleared: `${tab.name}!${rangeToString(range)}`, what });
    }

    case 'format_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      // Only the properties given change; undefined removes one (see ops.applyStyle).
      const patch: Partial<Record<keyof CellStyle, unknown>> = {};
      if ('bold' in i) patch.b = i.bold;
      if ('italic' in i) patch.i = i.italic;
      if ('underline' in i) patch.u = i.underline;
      if ('strikethrough' in i) patch.s = i.strikethrough;
      if ('text_color' in i) patch.color = i.text_color || undefined;
      if ('fill_color' in i) patch.bg = i.fill_color || undefined;
      if ('align' in i) patch.align = i.align === 'default' ? undefined : i.align;
      if ('number_format' in i) patch.fmt = i.number_format === 'general' ? undefined : i.number_format;
      if ('decimals' in i) patch.dp = i.decimals;
      if (!Object.keys(patch).length) throw new ToolError('Pass at least one formatting property.');
      run((tx) => ops.applyStyle(tx, tab.id, [range], patch as Partial<CellStyle>));
      show(ctl, tab.id);
      return JSON.stringify({ formatted: `${tab.name}!${rangeToString(range)}` });
    }

    case 'insert_rows': {
      const tab = tabOf(ctl, str(i.tab));
      const at = Math.min(Number(i.at_row) - 1, tab.rows);
      run((tx) => ops.insertLines(tx, tab.id, 'row', at, Number(i.count)));
      show(ctl, tab.id);
      return JSON.stringify({ inserted_rows: `${at + 1}:${at + Number(i.count)}`, tab: tab.name });
    }

    case 'delete_rows': {
      const tab = tabOf(ctl, str(i.tab));
      const [a, b] = [Number(i.from_row) - 1, Number(i.to_row) - 1].sort((x, y) => x - y);
      if (a >= tab.rows) throw new ToolError(`The tab only has ${tab.rows} rows.`);
      const to = Math.min(b, tab.rows - 1);
      if (a === 0 && to === tab.rows - 1) throw new ToolError('Cannot delete every row of a tab.');
      run((tx) => ops.deleteLines(tx, tab.id, 'row', a, to));
      show(ctl, tab.id);
      return JSON.stringify({ deleted_rows: `${a + 1}:${to + 1}`, tab: tab.name });
    }

    case 'insert_columns': {
      const tab = tabOf(ctl, str(i.tab));
      const at = Math.min(columnOf(String(i.at_column)), tab.cols);
      if (tab.cols + Number(i.count) > MAX_COLS) throw new ToolError('That would make the tab too wide.');
      run((tx) => ops.insertLines(tx, tab.id, 'col', at, Number(i.count)));
      show(ctl, tab.id);
      return JSON.stringify({ inserted_columns: Number(i.count), before_column: String(i.at_column).toUpperCase(), tab: tab.name });
    }

    case 'delete_columns': {
      const tab = tabOf(ctl, str(i.tab));
      const [a, b] = [columnOf(String(i.from_column)), columnOf(String(i.to_column))].sort((x, y) => x - y);
      if (a >= tab.cols) throw new ToolError(`The tab only has ${tab.cols} columns.`);
      const to = Math.min(b, tab.cols - 1);
      if (a === 0 && to === tab.cols - 1) throw new ToolError('Cannot delete every column of a tab.');
      run((tx) => ops.deleteLines(tx, tab.id, 'col', a, to));
      show(ctl, tab.id);
      return JSON.stringify({ deleted_columns: a === to ? colToName(a) : `${colToName(a)}:${colToName(to)}`, tab: tab.name });
    }

    case 'sort_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      const col = columnOf(String(i.by_column));
      if (col < range.c1 || col > range.c2) throw new ToolError(`Column ${String(i.by_column).toUpperCase()} is not inside ${rangeToString(range)}.`);
      const ext = ctl.store.engine.extent(tab.id);
      // Whole-column ranges: sort only the used rows, so empty rows don't move to the top.
      const rg = { ...range, r1: range.r1 + (i.has_header ? 1 : 0), r2: Math.min(range.r2, Math.max(ext.rows - 1, range.r1)) };
      if (rg.r2 > rg.r1) run((tx) => ops.sortRange(tx, ctl.store as WorkbookStore<unknown>, tab.id, rg, col, i.ascending !== false));
      show(ctl, tab.id);
      return JSON.stringify({ sorted: `${tab.name}!${rangeToString(rg)}`, by_column: String(i.by_column).toUpperCase(), ascending: i.ascending !== false });
    }

    case 'set_filter': {
      if (typeof i.range !== 'string') {
        const tab = tabOf(ctl, str(i.tab));
        run((tx) => tx.setTabProp(tab.id, 'filter', undefined));
        return JSON.stringify({ removed_filter: tab.name });
      }
      const { tab, range } = rangeOf(ctl, str(i.tab), i.range);
      const ext = ctl.store.engine.extent(tab.id);
      const r2 = range.r2 === tab.rows - 1 ? Math.max(range.r1 + 1, ext.rows - 1) : Math.max(range.r2, range.r1 + 1);
      const filter = { r1: range.r1, c1: range.c1, r2, c2: range.c2, cols: {} };
      run((tx) => tx.setTabProp(tab.id, 'filter', filter));
      show(ctl, tab.id);
      return JSON.stringify({ filter: `${tab.name}!${rangeToString(filter)}` });
    }

    case 'set_column_width': {
      const tab = tabOf(ctl, str(i.tab));
      const m = /^([A-Za-z]{1,3})(?::([A-Za-z]{1,3}))?$/.exec(String(i.columns).trim());
      if (!m) throw new ToolError(`"${i.columns}" is not a column or column range, such as B or B:D.`);
      const [a, b] = [columnOf(m[1]), columnOf(m[2] ?? m[1])].sort((x, y) => x - y);
      run((tx) => {
        const next = { ...tab.colWidths };
        for (let c = a; c <= b; c++) next[c] = Number(i.width);
        tx.setTabProp(tab.id, 'colWidths', next);
      });
      show(ctl, tab.id);
      return JSON.stringify({ columns: String(i.columns).toUpperCase(), width: i.width });
    }

    case 'freeze': {
      const tab = tabOf(ctl, str(i.tab));
      run((tx) => {
        if (typeof i.rows === 'number') tx.setTabProp(tab.id, 'frozenRows', i.rows || undefined);
        if (typeof i.columns === 'number') tx.setTabProp(tab.id, 'frozenCols', i.columns || undefined);
      });
      show(ctl, tab.id);
      return JSON.stringify({ tab: tab.name, frozen_rows: tab.frozenRows ?? 0, frozen_columns: tab.frozenCols ?? 0 });
    }

    case 'add_tab': {
      const name = str(i.name)?.trim();
      if (name) {
        const problem = ops.validateTabName(ctl.store.workbook.tabs, '', name);
        if (problem) throw new ToolError(problem);
      }
      let id = '';
      run((tx) => {
        id = ops.addTab(tx, ctl.store.workbook.tabs.indexOf(ctl.tab));
        if (name) ops.renameTab(tx, id, name);
      });
      ctl.switchTab(id);
      return JSON.stringify({ added_tab: ctl.tab.name });
    }

    case 'rename_tab': {
      const tab = tabOf(ctl, str(i.tab));
      const name = String(i.name).trim();
      const problem = ops.validateTabName(ctl.store.workbook.tabs, tab.id, name);
      if (problem) throw new ToolError(problem);
      const old = tab.name;
      run((tx) => ops.renameTab(tx, tab.id, name));
      return JSON.stringify({ renamed: old, to: name });
    }

    case 'delete_tab': {
      const tab = tabOf(ctl, str(i.tab));
      if (ctl.store.workbook.tabs.length <= 1) throw new ToolError('Cannot delete the only tab.');
      run((tx) => ops.deleteTab(tx, tab.id));
      return JSON.stringify({ deleted_tab: tab.name });
    }

    case 'select_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      show(ctl, tab.id);
      ctl.selectRange(range);
      return JSON.stringify({ selected: `${tab.name}!${rangeToString(range)}` });
    }

    default:
      throw new ToolError(`Unknown tool ${call.name}.`);
  }
}

/** The cell or range a tool call is about, for jumping to it from the chat. */
export function targetOf(call: { name: string; input: Input }, ctl: SheetController): { tabId: string; range: Range } | null {
  const i = call.input;
  try {
    if (typeof i.range === 'string') {
      const { tab, range } = rangeOf(ctl, str(i.tab), i.range);
      return { tabId: tab.id, range };
    }
    if (call.name === 'write_range' && typeof i.start === 'string' && Array.isArray(i.rows)) {
      const { tab: prefix, range: ref } = splitTabRange(i.start);
      const tab = tabOf(ctl, prefix ?? str(i.tab));
      const p = resolveRange(ctl.store.workbook, tab.name, ref);
      if (typeof p === 'string') return null;
      const rows = i.rows as unknown[][];
      const width = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 1)));
      return { tabId: tab.id, range: { r1: p.range.r1, c1: p.range.c1, r2: p.range.r1 + rows.length - 1, c2: p.range.c1 + width - 1 } };
    }
  } catch {
    // Tab or range no longer exists.
  }
  return null;
}
