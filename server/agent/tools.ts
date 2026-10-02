// Tool definitions for the agent. Input schemas are Zod objects: the server validates every tool input
// against them before running a tool or forwarding it to the browser, and sends their JSON Schema to Claude.
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { readRange, resolveRange, sheetOverview } from '../../shared/agent/sheetRead.ts';
import type { AgentContext } from '../../shared/agent/protocol.ts';
import { Engine } from '../../shared/formula/engine.ts';
import type { SheetStore } from '../sheets.ts';

const tab = z.string().optional().describe('Tab name. Defaults to the active tab.');
const range = z.string().describe('Range in A1 notation, e.g. "B2", "A1:D10", "C:E" (whole columns) or "3:5" (whole rows). May be prefixed with a tab name: \'Q3 Sales\'!A1:D10.');
const column = z.string().regex(/^[A-Za-z]{1,3}$/).describe('Column letter, e.g. "C".');
const row = z.number().int().min(1).describe('1-based row number.');
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const schemas = {
  // --- Open spreadsheet (run in the browser) ---
  get_sheet_overview: z.object({}).describe(
    'Describe the open spreadsheet: every tab with its size, used range, frozen panes, filter and first few rows, plus the current selection. Call this first when you need to know how the data is laid out.',
  ),
  read_range: z
    .object({
      tab,
      range,
      include_formulas: z.boolean().optional().describe('Also return the formula of each formula cell.'),
      include_formats: z.boolean().optional().describe('Also return the formatting of each formatted cell.'),
    })
    .describe('Read the displayed values of a range in the open spreadsheet (clipped to the used area, at most 2500 cells per call).'),
  write_range: z
    .object({
      tab,
      start: z.string().describe('Top-left cell to write to, e.g. "A1".'),
      rows: z
        .array(z.array(cellValue))
        .min(1)
        .describe('Rows of cell inputs, written as if the user typed them: numbers, text, dates like "2025-03-14", or formulas starting with "=". null leaves a cell unchanged; "" clears it.'),
    })
    .describe('Write values or formulas into the open spreadsheet, starting at a cell. Keeps existing formatting. The tab grows if needed.'),
  clear_range: z
    .object({
      tab,
      range,
      what: z.enum(['contents', 'formats', 'all']).optional().describe('What to clear. Defaults to contents.'),
    })
    .describe('Clear the contents and/or formatting of a range.'),
  format_range: z
    .object({
      tab,
      range,
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      text_color: z.string().optional().describe('CSS color such as "#1a73e8"; "" removes it.'),
      fill_color: z.string().optional().describe('Background CSS color; "" removes it.'),
      align: z.enum(['left', 'center', 'right', 'default']).optional(),
      number_format: z.enum(['general', 'number', 'currency', 'percent', 'date', 'time', 'datetime', 'text']).optional(),
      decimals: z.number().int().min(0).max(10).optional().describe('Decimal places for number, currency and percent formats.'),
    })
    .describe('Format a range. Only the properties you pass change.'),
  insert_rows: z.object({ tab, at_row: row.describe('New rows are inserted before this row.'), count: z.number().int().min(1).max(10000) }).describe('Insert empty rows.'),
  delete_rows: z.object({ tab, from_row: row, to_row: row }).describe('Delete rows from_row to to_row (inclusive). The user is asked to confirm.'),
  insert_columns: z
    .object({ tab, at_column: column.describe('New columns are inserted before this column.'), count: z.number().int().min(1).max(1000) })
    .describe('Insert empty columns.'),
  delete_columns: z.object({ tab, from_column: column, to_column: column }).describe('Delete columns (inclusive). The user is asked to confirm.'),
  sort_range: z
    .object({
      tab,
      range,
      by_column: column.describe('Column to sort by; must be inside the range.'),
      ascending: z.boolean().optional().describe('Defaults to true.'),
      has_header: z.boolean().optional().describe('Keep the first row of the range in place. Defaults to false.'),
    })
    .describe('Sort the rows of a range by one column.'),
  set_filter: z
    .object({ tab, range: range.optional().describe('Range to put a filter on, header row first. Omit to remove the filter.') })
    .describe('Turn on a filter (with header dropdowns) for a range, or remove the tab\'s filter.'),
  set_column_width: z
    .object({ tab, columns: z.string().describe('Column or columns, e.g. "B" or "B:D".'), width: z.number().int().min(20).max(2000).describe('Width in pixels; the default is 100.') })
    .describe('Set column widths.'),
  freeze: z
    .object({ tab, rows: z.number().int().min(0).max(100).optional(), columns: z.number().int().min(0).max(50).optional() })
    .describe('Freeze the top rows and/or left columns. 0 unfreezes.'),
  add_tab: z.object({ name: z.string().optional() }).describe('Add a new empty tab after the active tab and switch to it.'),
  rename_tab: z.object({ tab: z.string(), name: z.string() }).describe('Rename a tab. Formulas that refer to it are updated.'),
  delete_tab: z.object({ tab: z.string() }).describe('Delete a tab. The user is asked to confirm.'),
  select_range: z.object({ tab, range }).describe('Select a range and scroll to it, to show the user something.'),
  open_sheet: z
    .object({ sheet_id: z.string() })
    .describe('Open another spreadsheet in the app (the user navigates to it). Returns its overview. Sheet tools then act on it.'),

  // --- Account (run on the server) ---
  list_sheets: z
    .object({ query: z.string().optional().describe('Only spreadsheets whose title contains this text (case-insensitive).') })
    .describe("List the user's spreadsheets, most recently edited first (at most 50)."),
  read_other_sheet: z
    .object({
      sheet_id: z.string(),
      tab,
      range: range.optional().describe('Range to read. Omit for an overview of every tab.'),
    })
    .describe('Read another spreadsheet in the account without opening it: an overview, or the values of a range. Not for the open spreadsheet; use read_range for that.'),
  create_sheet: z.object({ title: z.string().min(1).max(200) }).describe('Create a new, empty spreadsheet. Open it with open_sheet to fill it in.'),
} satisfies Record<string, z.ZodObject>;

export type ToolName = keyof typeof schemas;

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name);
}

/** Validate a tool input. Returns the parsed input or an error message for Claude. */
export function validateToolInput(name: string, input: unknown): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  if (!isToolName(name)) return { ok: false, error: `Unknown tool "${name}".` };
  const parsed = schemas[name].safeParse(input);
  if (!parsed.success) return { ok: false, error: `Invalid input for ${name}: ${z.prettifyError(parsed.error)}` };
  return { ok: true, input: parsed.data as Record<string, unknown> };
}

/** Tool definitions sent to Claude, in a fixed order so the prompt prefix stays cacheable. */
export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = Object.entries(schemas).map(([name, schema]) => {
  const { $schema: _ignored, description, ...input_schema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    name,
    description: String(description ?? ''),
    input_schema: input_schema as Anthropic.Beta.BetaTool.InputSchema,
    // Stream large inputs (write_range rows) as they are generated; validateToolInput checks them afterwards.
    eager_input_streaming: true,
  };
});

// ---------------------------------------------------------------------------
// Server-side tools

export interface ServerToolEnv {
  userId: string;
  sheets: SheetStore;
  context: AgentContext;
}

/** Run an account tool. Returns the result text for Claude; throws ToolFailure for errors Claude should see. */
export async function runServerTool(name: string, input: Record<string, unknown>, env: ServerToolEnv): Promise<string> {
  switch (name) {
    case 'list_sheets': {
      const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const all = env.sheets.list(env.userId).filter((s) => !q || s.title.toLowerCase().includes(q));
      return JSON.stringify({
        total: all.length,
        sheets: all.slice(0, 50).map((s) => ({
          id: s.id,
          title: s.title,
          updated_at: s.updatedAt,
          ...(s.branch ? { branch_of: s.branch.parentTitle } : {}),
          ...(env.context.page === 'sheet' && env.context.sheetId === s.id ? { open_now: true } : {}),
        })),
      });
    }
    case 'read_other_sheet': {
      const id = input.sheet_id as string;
      if (env.context.page === 'sheet' && env.context.sheetId === id) {
        throw new ToolFailure('That spreadsheet is open right now; use get_sheet_overview and read_range so you see unsaved edits.');
      }
      const res = await env.sheets.load(env.userId, id);
      if (!res) throw new ToolFailure(`No spreadsheet with id "${id}". Use list_sheets to find ids.`);
      const src = { workbook: res.workbook, engine: new Engine(res.workbook) };
      if (typeof input.range !== 'string') return JSON.stringify({ title: res.meta.title, ...sheetOverview(src) });
      const rr = resolveRange(res.workbook, input.tab as string | undefined, input.range);
      if (typeof rr === 'string') throw new ToolFailure(rr);
      return JSON.stringify({ title: res.meta.title, ...readRange(src, rr.tab, rr.range) });
    }
    case 'create_sheet': {
      const sheet = await env.sheets.create(env.userId, String(input.title).trim());
      return JSON.stringify({ id: sheet.id, title: sheet.title });
    }
    default:
      throw new ToolFailure(`${name} is not a server tool.`);
  }
}

export class ToolFailure extends Error {}
