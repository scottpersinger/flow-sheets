// Short labels for tool calls shown in the chat ("Wrote 12 cells at A1").

type Input = Record<string, unknown>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function where(i: Input): string {
  const r = typeof i.range === 'string' ? i.range : typeof i.start === 'string' ? i.start : '';
  const t = typeof i.tab === 'string' ? i.tab : '';
  if (r && t && !r.includes('!')) return `${t}!${r}`;
  return r || t;
}

function span(a: unknown, b: unknown): string {
  return a === b ? String(a) : `${a}–${b}`;
}

export function toolLabel(name: string, i: Input): string {
  switch (name) {
    case 'get_sheet_overview':
      return 'Looked over the spreadsheet';
    case 'read_range':
      return `Read ${where(i)}`;
    case 'write_range': {
      const rows = Array.isArray(i.rows) ? (i.rows as unknown[][]) : [];
      const cells = rows.reduce((n, r) => n + (Array.isArray(r) ? r.filter((v) => v !== null).length : 0), 0);
      return `Wrote ${plural(cells, 'cell')} at ${where(i)}`;
    }
    case 'clear_range':
      return `Cleared ${i.what === 'formats' ? 'formatting in ' : ''}${where(i)}`;
    case 'format_range':
      return `Formatted ${where(i)}`;
    case 'insert_rows':
      return `Inserted ${plural(Number(i.count), 'row')} at row ${i.at_row}`;
    case 'delete_rows':
      return `Deleted ${i.from_row === i.to_row ? 'row' : 'rows'} ${span(i.from_row, i.to_row)}`;
    case 'insert_columns':
      return `Inserted ${plural(Number(i.count), 'column')} at column ${String(i.at_column).toUpperCase()}`;
    case 'delete_columns':
      return `Deleted ${i.from_column === i.to_column ? 'column' : 'columns'} ${span(String(i.from_column).toUpperCase(), String(i.to_column).toUpperCase())}`;
    case 'sort_range':
      return `Sorted ${where(i)} by column ${String(i.by_column).toUpperCase()}`;
    case 'set_cell_image':
      return `Added an image to ${where(i)}`;
    case 'set_filter':
      return typeof i.range === 'string' ? `Added a filter to ${where(i)}` : 'Removed the filter';
    case 'set_filter_criteria':
      return i.clear
        ? `Cleared the filter on column ${String(i.column).toUpperCase()}`
        : `Filtered column ${String(i.column).toUpperCase()} to ${Array.isArray(i.values) ? i.values.map((v) => `“${v}”`).join(', ') : 'chosen values'}`;
    case 'set_column_width':
      return `Resized column ${String(i.columns).toUpperCase()}`;
    case 'set_row_height':
      return `Resized ${String(i.rows).includes(':') ? 'rows' : 'row'} ${String(i.rows).trim()} to ${i.height}px`;
    case 'freeze':
      return 'Changed frozen rows and columns';
    case 'add_tab':
      return typeof i.name === 'string' ? `Added tab “${i.name}”` : 'Added a tab';
    case 'rename_tab':
      return `Renamed tab “${i.tab}” to “${i.name}”`;
    case 'delete_tab':
      return `Deleted tab “${i.tab}”`;
    case 'select_range':
      return `Selected ${where(i)}`;
    case 'open_sheet':
      return 'Opened a spreadsheet';
    case 'request_app_change':
      return `Requested an app change: ${String(i.title ?? '')}`;
    case 'list_sheets':
      return typeof i.query === 'string' && i.query ? `Searched your spreadsheets for “${i.query}”` : 'Listed your spreadsheets';
    case 'read_other_sheet':
      return typeof i.range === 'string' ? `Read ${where(i)} in another spreadsheet` : 'Looked at another spreadsheet';
    case 'create_sheet':
      return `Created spreadsheet “${i.title}”`;
    case 'web_search':
      return `Searched the web for “${i.query}”`;
    case 'image_search':
      return `Searched for images of “${i.query}”`;
    default:
      return name;
  }
}
