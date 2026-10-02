# Sheets

A web spreadsheet app, similar to Google Sheets. Users register and sign in with email and password, and can create, open, rename and delete spreadsheets. Each spreadsheet has multiple tabs and supports formulas, formatting, sorting and filtering.

## Running

```sh
npm install
npm run dev        # API on :3001 and Vite on :5173; open http://localhost:5173
npm test           # formula engine, spreadsheet operations and API tests
npm run typecheck
npm run build && npm start   # production: serves dist/client and the API on :3001
```

Requires Node 22.18+. The server runs TypeScript directly through Node's built-in type stripping and uses the built-in `node:sqlite`.

Environment variables: `PORT` (default 3001), `HOST` (default 127.0.0.1), `DATA_DIR` (default `./data`), and `SECURE_COOKIES=1` for HTTPS deployments. The assistant needs `ANTHROPIC_API_KEY`. For local development, copy `.env.example` to `.env` (git-ignored) and fill it in; the server loads it on start (`server/env.ts`), so restart it after editing. You can also set `AGENT_EFFORT` (`low`, `medium` (default) or `high`) and `AGENT_DAILY_REQUEST_LIMIT` (model calls per user per day, default 500).

## Layout

| Path | Contents |
| --- | --- |
| `shared/` | Workbook types, A1 helpers, value parsing and formatting, and the formula engine (tokenizer, parser, dependency-tracking evaluator, ~120 functions). Used by both client and server. |
| `server/` | Fastify API: auth (scrypt password hashes, hashed session tokens in httpOnly cookies) and sheet CRUD. |
| `client/src/state/` | `WorkbookStore` (patch-based undo/redo, incremental recalculation), `AutoSaver`, spreadsheet operations (`ops.ts`) and `SheetController` (selection, editing, clipboard and commands). |
| `client/src/grid/` | Canvas grid: virtualized rendering, frozen panes, hit testing, and the mouse and keyboard interaction. |

## Assistant

**Assistant** in the header (or **⌘K** / **Ctrl+K**) opens a chat panel on the right. You can ask it in plain language to read, edit, format, sort or restructure the open spreadsheet, or to find, read, create and open other spreadsheets. It knows which spreadsheet, tab and selection you're looking at. It uses Claude Sonnet 5.5 through one API key on the server.

- **Edits appear immediately** and save like your own. Everything the assistant changes for one message undoes as a single step with ⌘Z. Deleting tabs, rows or columns, and clearing more than 100 cells, asks you first.
- **One ongoing conversation per user**, kept across page loads and navigation. **New chat** starts over (old conversations stay in the database).
- Click an action in the chat (such as "Wrote 8 cells at A1") to select that range.

How it works:

- The **server** (`server/agent/`) runs the agent loop and holds the API key, system prompt and tools. Conversations are stored in SQLite exactly as sent to the API and are only ever appended to. That keeps prompt caching effective and lets the model's thinking blocks be passed back unchanged.
- **Account tools** (`list_sheets`, `read_other_sheet`, `create_sheet`) run on the server.
- **Sheet tools** (`read_range`, `write_range`, `format_range`, `sort_range`, `open_sheet` and the others) run in the **browser**, on the live spreadsheet (`client/src/agent/clientTools.ts`). That way edits recalculate, render, autosave and undo like any other edit. When Claude calls one, the server streams the call to the browser and pauses. The browser runs it and posts the result back, and the loop continues.
- Every request carries the current context: the page, the spreadsheet, its tabs, the active tab and the selection. It's added in front of the user's message, so the system prompt stays cacheable.
- Tool inputs are checked against Zod schemas (`server/agent/tools.ts`) before anything runs. The same schemas generate the JSON Schema sent to Claude.

## Branches

**File → Create branch…** (or **Create branch** in a spreadsheet's menu on the home page) makes a branch: a copy you can edit freely that stays connected to its original. Branches are listed under their original on the home page.

In a branch, **Compare with original** opens a three-way comparison. When the branch is created, a snapshot of the original is saved as the *base* (`data/sheets/<id>.base.json`). Each difference is then labeled by who made it:

- **Yours** (green): changed in your branch since it was created.
- **Original** (purple): changed in the original since then.
- **Conflict** (red): changed differently on both sides. Identical changes on both sides don't show.

Changed cells are tinted on the grid, and hovering one shows the base, your and the original's values. Rows that exist only on the other side are drawn as a line where they would be. The side panel lists every change; click one to jump to it. The comparison updates as you edit, and **↻** fetches the original's latest state.

How the comparison works (`shared/diff.ts`):

- **Rows** are aligned with a Myers diff (the algorithm behind `git diff`), so an inserted or deleted row is one change rather than every row below it. Columns are compared by position.
- **Formulas** are rewritten into the base's row numbers and sheet IDs before comparing. Formulas that the app adjusted because of row inserts, deletes or sheet renames don't show as edits.
- **Detached branches:** if the original is deleted, the branch keeps working and compares against the base.

## Find

Press **⌘F** (Ctrl+F on Windows and Linux), or use **Edit → Find…**, to open the find bar. Inside a spreadsheet it replaces the browser's page search.

- Search runs as you type, highlights every match, and jumps to the nearest one.
- **Enter** and **Shift+Enter** step through matches, and **Esc** closes the bar.
- Options: match case, match the entire cell, also search formula text, and search all sheets.
- It matches values as displayed (for example `$1,500`) and skips rows hidden by a filter.

## Excel import

There are two ways to import an Excel workbook:

- **Home page** (the **Import Excel** tile, or drop a file on the page): creates a new spreadsheet from the file.
- **File → Import Excel file** inside a spreadsheet: adds the file's sheets as new tabs after the existing ones, as one undoable change. Sheets whose names are already taken get a number added (`Summary` → `Summary 2`), and references between the imported sheets are updated to match.

The conversion runs on the server (`server/xlsxImport.ts`). `.xlsx` files are read with ExcelJS. Older `.xls` files are first converted to `.xlsx` with SheetJS (pinned to 0.20.3 from the vendor's CDN, because the npm copy is outdated), so only their values, formulas, number formats and column widths carry over, not fonts, colors or alignment. The format is detected from the file contents, not the extension. For `.xlsx` files it keeps:

- values, formulas (including shared formulas), dates, and text that looks like a number (such as `001`)
- bold, italic, underline, strikethrough, text and fill colors, alignment and number formats
- column widths, row heights, frozen panes, the filter range, and multiple sheets with the references between them

Features the app doesn't support are reported in a banner after import: unsupported functions (shown as `#NAME?`), table references or links to other files (shown as `#ERROR!`), merged cells (unmerged, with the value kept in the top-left cell) and hidden sheets. Charts, images, comments, conditional formatting, data validation and filter criteria are dropped. Uploads are limited to 20 MB, 300 MB uncompressed and 1 million cells.

## Storage

- `data/app.db`: SQLite database holding users, sessions, sheet metadata (owner, title, timestamps), assistant conversations and per-user assistant usage.
- `data/sheets/<id>.json`: one file per spreadsheet in the native JSON workbook format (`shared/types.ts`). Cells are stored sparsely by A1 address as the raw input plus optional style. Files are written atomically (temp file, then rename). The client autosaves the full workbook 800 ms after the last change.
