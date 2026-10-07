# Sheets

A web spreadsheet app (React + Vite client, Fastify server, SQLite via `node:sqlite`) with a built-in AI
assistant. The server runs TypeScript directly with Node's type stripping; imports use `.ts` extensions.

- `client/src` — React app. Spreadsheet state lives in `client/src/state` (`WorkbookStore` + `Tx` transactions,
  `SheetController` for selection/editing, `ops.ts` for workbook operations such as insert/delete/sort/filter).
- `server` — Fastify API (`app.ts`), auth, sheet storage (`sheets.ts`), and the assistant (`server/agent`).
- `shared` — code used by both: workbook types (`types.ts`), cell references, the formula engine, the slide deck
  format with its layouts and themes (`deck.ts`), and the assistant protocol (`shared/agent`).
- Presentations (slide decks) live in `client/src/deck` (`DeckStore` + `DeckController`, the `SlideView`
  renderer, editor, toolbar, present mode) and `client/src/pages/DeckPage.tsx`. They are stored with
  spreadsheets (`server/sheets.ts`, `kind` column) behind `/api/decks`.
- Text documents live in `client/src/doc` (`DocStore` + `DocController` over a ProseMirror state, the
  `DocEditor` view, toolbar) and `client/src/pages/DocPage.tsx`, behind `/api/docs`. The schema and
  file format are in `shared/doc.ts`; `shared/docMarkdown.ts` converts documents to and from the Markdown
  the assistant reads and writes.
- Markdown documents live in `client/src/markdown` (`MarkdownController` over the plain text with autosave,
  the GitHub-flavored `MarkdownPreview` built on react-markdown + remark-gfm) and
  `client/src/pages/MarkdownPage.tsx` (a textarea editor with a resizable preview panel), behind
  `/api/markdown`. The stored format is `shared/markdown.ts`. The assistant's content tools (`read_doc`,
  `insert_content`, `replace_blocks`, `delete_blocks`, `replace_text`, plus `open_doc`, `list_docs`,
  `create_doc`, `read_other_doc`) work on them too, through `client/src/agent/markdownTools.ts` and
  `shared/agent/markdownBlocks.ts` (blocks are the top-level Markdown constructs, edits are text ranges
  applied through the editor so they are undoable); the formatting and page tools do not.

Checks: `npm run typecheck` and `npm test` (vitest). Both must pass before a change is finished.

## How the assistant works

The server runs the Claude loop (`server/agent/agent.ts`). Tools are defined once as Zod schemas in
`server/agent/tools.ts`; the server validates every tool input and sends the JSON Schema to Claude.

Two kinds of tools:

- **Browser tools** act on the open spreadsheet. The server pauses the turn, the browser runs the tool against
  the live `WorkbookStore` (so edits render, autosave and undo like the user's own), and posts the result back.
- **Server tools** act on the account (list/read/create spreadsheets) and run in `runServerTool`.

## How to add an assistant tool

Follow the existing tools as examples (`set_filter` and `sort_range` are good small ones). A new tool
touches these places:

1. **Schema** — add a Zod object to `schemas` in `server/agent/tools.ts`. Describe every field and the tool
   itself: the descriptions are what Claude reads. Reuse the shared `tab`, `range`, `column` and `row` fields.
2. **Kind** — for a browser tool, add its name to `CLIENT_TOOLS` in `shared/agent/protocol.ts`. A server tool
   instead gets a `case` in `runServerTool` in `server/agent/tools.ts`.
3. **Implementation** (browser tools) — add a `case` to `runClientTool` in `client/src/agent/clientTools.ts`.
   Resolve tabs and ranges with `tabOf` / `rangeOf`, make every change inside `run((tx) => ...)` so it is
   undoable as part of the agent's step, call `show(ctl, tab.id)` so the user sees the tab you changed, and
   return a small JSON string describing what happened. Throw `ToolError` with a helpful message for anything
   Claude should fix (bad range, missing tab, and so on). Tools that act on the open presentation go in
   `client/src/agent/deckTools.ts` instead (add the name to `DECK_TOOLS` there) and use the `DeckController`
   (`ctl.runAgent(group, (tx) => ...)`), with tests in `deckTools.test.ts`. Tools that act on the open
   document go in `client/src/agent/docTools.ts` (add the name to `DOC_TOOLS`) and build one ProseMirror
   transaction with `ctl.runAgent(group, (tr) => ...)`, with tests in `docTools.test.ts`.
   If the action is destructive (deletes data the user cannot easily recover), add a question for it to
   `confirmationFor` in the same file.
4. **Label** — add a `case` to `toolLabel` in `client/src/agent/describe.ts` (the one-line label in the chat,
   e.g. "Sorted A1:D10 by column B").
5. **Test** — add a test to `client/src/agent/clientTools.test.ts` (browser tools) or `server/agent.test.ts`
   (server tools) that calls the tool and checks the workbook.
6. **Prompt** — only if Claude needs guidance on when to use the tool, add a line to `SYSTEM_PROMPT` in
   `server/agent/prompt.ts`. Keep the prompt free of anything that changes between requests.

Workbook model reminders (`shared/types.ts`): tabs hold sparse `cells` keyed by A1 address; `Tab.filter` is
a `FilterState` with the filtered range and per-column criteria keyed by absolute column index (`hidden`
display values and/or a `cond`); rows hidden by a filter are computed in `ops.ts`.

## Rules for automated changes

When a change is made by the assistant's coding job (see `server/agent/worker.ts`):

- Make the smallest change that fully implements the request, following the patterns above.
- Do not modify `CHANGELOG.md` (the job writes it), `data/`, `.env*`, `server/auth.ts`, or anything under
  `server/agent/` other than `tools.ts` and `prompt.ts`.
- Do not commit. The job commits, opens a pull request and merges it after the checks pass.
- Run `npm run typecheck` and `npm test` and fix any failures before finishing.
