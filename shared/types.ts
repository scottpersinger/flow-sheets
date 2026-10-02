// Workbook file format (stored as one JSON file per sheet on the server).

export type HAlign = 'left' | 'center' | 'right';

export type NumberFormat =
  | 'general'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'time'
  | 'datetime'
  | 'text';

export interface CellStyle {
  b?: boolean; // bold
  i?: boolean; // italic
  u?: boolean; // underline
  s?: boolean; // strikethrough
  color?: string; // text color
  bg?: string; // fill color
  align?: HAlign;
  fmt?: NumberFormat;
  dp?: number; // decimal places for number/currency/percent
}

export interface CellData {
  /** Raw user input: a literal ("12", "hello", "3/4/2025") or a formula ("=SUM(A1:A3)"). */
  v: string;
  st?: CellStyle;
}

export type FilterConditionType =
  | 'none'
  | 'empty'
  | 'notEmpty'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface FilterCondition {
  type: FilterConditionType;
  value?: string;
}

export interface ColumnFilter {
  /** Display values that are hidden (unchecked in the "filter by values" list). */
  hidden?: string[];
  cond?: FilterCondition;
}

export interface FilterState {
  /** Range covered by the filter; row r1 is the header row. */
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** Criteria keyed by absolute column index. */
  cols: Record<string, ColumnFilter>;
}

export interface Tab {
  id: string;
  name: string;
  rows: number;
  cols: number;
  /** Sparse cells keyed by A1-style address ("B7"). */
  cells: Record<string, CellData>;
  colWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  frozenRows?: number;
  frozenCols?: number;
  filter?: FilterState;
}

export interface Workbook {
  version: 1;
  tabs: Tab[];
}

export interface SheetMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Set when this sheet is a branch of another sheet. */
  branch?: {
    parentId: string;
    /** Current title of the original, or its title when branched if it has been deleted. */
    parentTitle: string;
    branchedAt: string;
    /** The original has been deleted; only the base snapshot remains for comparison. */
    detached: boolean;
  };
}

export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLS = 26;

export function newTab(id: string, name: string): Tab {
  return {
    id,
    name,
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
    cells: {},
    colWidths: {},
    rowHeights: {},
  };
}

export function newWorkbook(firstTabId: string): Workbook {
  return { version: 1, tabs: [newTab(firstTabId, 'Sheet1')] };
}
