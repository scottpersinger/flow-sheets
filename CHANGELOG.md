# Changes made by the assistant

Each entry is written by the app itself when a change requested through the assistant goes live.

## 2026-10-05 — Make the slide thumbnail tray and the Assistant panel resizable

I added drag handles to the slide thumbnail tray and to the Assistant panel, and the Assistant handle works in both the Slides and spreadsheet views. You can drag a handle, double-click it to reset, or focus it and use the Left/Right arrow keys to resize in 16px steps. The tray stays between 120 and 400px (default 200), its thumbnails scale with it at 16:9, and the slide canvas or sheet grid shrinks to fit. The Assistant panel stays between 280px and the smaller of 800px or half the window (default 380), and widths are saved in localStorage under `ui.slideTrayWidth` and `ui.assistantPanelWidth`. Typecheck and tests pass, including new tests for the size limits and saving in `client/src/panelSize.test.ts`, but I haven't tried the dragging in a browser, and there is no new assistant tool. One limit: the middle stays at least 400px wide in most cases, but in a narrow window with both panels wide it can still drop below that.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

What the user asked for: in the presentation (Slides) editor, both side panels should be adjustable in width:
1. The left tray of slide thumbnails.
2. The Assistant chat panel on the right. This panel is shared with the spreadsheet view, so make it resizable there too.

Today both panels have fixed widths.

Desired behavior:
- Each panel gets a vertical drag handle on its inner edge: the right edge of the thumbnail tray, the left edge of the Assistant panel. The handle is a thin hit area of about 6px that shows a col-resize cursor on hover and a subtle highlight line on hover and while dragging.
- Dragging resizes the panel live, and the slide canvas / sheet grid in the middle reflows to fill the remaining space. The slide canvas should rescale to fit, keeping its 16:9 aspect ratio.
- Sensible limits. Thumbnail tray: min about 120px, max about 400px, default the current width. Thumbnails scale with the tray width and keep 16:9. Assistant panel: min about 280px, max about 50% of the viewport or 800px, default the current width. Also make sure the center area never drops below about 400px.
- Double-clicking a handle resets that panel to its default width.
- Persist each width per user in localStorage (e.g. keys "ui.slideTrayWidth" and "ui.assistantPanelWidth") so it survives reloads and switching between documents.
- Avoid text selection and iframe/canvas pointer capture issues while dragging: use pointer events with setPointerCapture, and set user-select: none on the body during the drag.
- Keyboard accessibility: the handle is focusable (role="separator", aria-orientation="vertical", aria-valuenow/min/max), and the Left/Right arrow keys resize in 16px steps.

Example: in deck bc8596c9-dccc-41a7-806a-68d9b2516ddb ("BizTrip AI Q3 2026 Investor Share Deck Sept 11"), the user should be able to drag the thumbnail tray narrower and the Assistant panel wider to read long replies, and the slide canvas in the middle shrinks to fit.

Please add tests for the clamping and persistence logic if the codebase has a pattern for UI unit tests.

Files: client/src/agent/AgentPanel.tsx, client/src/components/ResizeHandle.tsx, client/src/deck/ThumbnailStrip.tsx, client/src/pages/DeckPage.tsx, client/src/panelSize.test.ts, client/src/panelSize.ts, client/src/styles.css

Job: 3328b6da-054a-4d6d-8281-d680756a47b8

## 2026-10-05 — Add a tool to render a slide as an image so the assistant can check its work

Typecheck and all 153 tests now pass. The one failing test was picking up this machine's `AGENT_MODEL` setting, so I set it to empty in the test config (`vite.config.ts`) and the test now checks the default model again.

The new assistant tool, **render_slide**, takes a PNG of a slide using the app's own slide renderer, with the same fonts, theme, images and text wrapping. Its inputs are `slide` (required, 1-based), `scale` (0.5–2, default 1 = 960×540) and `deck_id` (defaults to the open presentation, including unsaved edits). It returns the stored /api/images/... address, the pixel size, and an `overflow` list of text boxes and shape labels whose text is bigger than their box. Two limits: the picture comes in the message right after the tool results rather than inside them, and the image-making step is covered by unit tests but hasn't been tried in a real browser. Shape labels now follow the `size`, `font`, `bold` and `color` set through edit_elements instead of always showing at 18pt, and the assistant is told to render and check a slide after building or changing it.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

What the user asked for: the assistant should be able to take a screenshot of a slide to visually check its own edits. Today the assistant only has read_deck, which returns element geometry and text but not what actually renders. That caused a real failure: on deck bc8596c9-dccc-41a7-806a-68d9b2516ddb, slide 16 (a roadmap slide built from about 80 shapes and text boxes), labels set via the shape "text" property ignored the requested "size" (9pt) and rendered at a much larger default. Text wrapped and overlapped badly, and the assistant had no way to see it until the user sent a screenshot.

Proposed tool: render_slide
- Inputs: slide (integer, 1-based, required); optional scale (number, default 1 = 960x540 px; allow 0.5 to 2); optional deck_id (string, defaults to the open presentation).
- Behavior: render the slide on the server exactly as the editor/presenter shows it: the same fonts (Poppins, Inter, etc.), theme, background, images, shapes with their labels, text wrapping, line height and valign. Produce a PNG. Use the same rendering code path as the client if possible, e.g. headless browser rendering of the slide view route, so the image matches what the user sees. Don't build a separate approximate renderer.
- Returns: the PNG as an image content block the model can view directly, i.e. an image in the tool result rather than just a URL. Also return a stored /api/images/... address, plus the slide number and pixel dimensions.
- Optional but valuable: also return an "overflow" list of text elements whose rendered text is taller or wider than their box, with id, box h and rendered height. Overlaps can then be caught even without looking closely.
- Errors: clear messages if no presentation is open or the slide number is out of range.

Related bug worth fixing in the same change, if it's simple: edit_elements accepts size/font/bold/color for shape elements that have a "text" label, but the shape label rendering seems to ignore "size" (and maybe font), so labels render far too large. Either honor those properties for shape labels, or document that they aren't supported.

Also update the system prompt / tool guidance: after building or significantly changing a slide, call render_slide and check the result before reporting back to the user.

Example: render_slide({slide: 16}) on the deck above should return a 960x540 PNG of the roadmap slide (timeline track, quarter columns, item tags), which the assistant then inspects for overlapping or overflowing text.

Files: client/src/agent/AgentProvider.tsx, client/src/agent/clientTools.ts, client/src/agent/deckTools.test.ts, client/src/agent/deckTools.ts, client/src/agent/describe.ts, client/src/deck/SlideView.tsx, client/src/deck/fonts.ts, client/src/deck/renderSlide.ts, server/agent/prompt.ts, server/agent/tools.ts, shared/agent/protocol.ts, shared/deck.ts, shared/pptxExport.ts, vite.config.ts

Job: 48c50fe9-ce3b-4453-94cd-630981cd4698

## 2026-10-05 — Drag a column to a new position

You can now reorder columns by dragging: select one column or a block of adjacent columns by its header, then drag the header. A drop line shows where they will land, Escape cancels, and one undo reverses the whole move. Everything travels with the columns (values, formatting, width, filter settings, images, links), formulas on any tab are updated to keep pointing at the same data, and the moved columns stay selected; typecheck and all tests pass, though I haven't tried the drag in a browser. I also added a new assistant tool, `move_columns(from_column, to_column?, before_column, tab?)`, which places a column or block (from `from_column` through `to_column`, which defaults to `from_column`) immediately left of `before_column` on the given tab (the active tab by default) and returns the new range. For example, `move_columns(from_column="F", before_column="E")` swaps the two balance columns. A range formula like `SUM(A:B)` drops a column that is moved out of it and widens if one is moved into it, and the frozen-column count does not change.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-05.

### Request

The user wants to reorder columns in a spreadsheet by dragging. Today the only ways to reorder are manual cut/paste or insert/delete columns. 

UI: In the grid, the user clicks a column header letter to select the column (or a contiguous multi-column selection), then presses and drags that header; a drop indicator line shows the target column boundary; on release the selected column(s) move there. Dragging should work on the selected columns only (drag starting on an unselected header just selects it as today). Escape cancels the drag. Undo (Cmd/Ctrl+Z) must reverse the whole move in one step.

Behavior: moving column(s) shifts the columns in between by the width of the moved block. Everything travels with the column: values, formulas, formatting, column width, filter state, and images/links. Formulas elsewhere in the workbook (including on other tabs) that reference moved or shifted cells must be updated so they keep pointing at the same data (same as how insert/delete columns rewrite references). Filter range, frozen columns and the selection should follow sensibly (selection ends up on the moved columns in their new position).

Also add an assistant tool move_columns with inputs: from_column (string, column letter, e.g. "F"), to_column (optional string, last column of a block when moving several, defaults to from_column), before_column (string, the column letter the block should be placed in front of; the block ends up immediately left of it), tab (optional string, defaults to active tab). Returns the new range of the moved columns. Example: on the 'Accounts' tab of 'Brex Card Transactions' (columns id, name, status, primary, current_balance, available_balance, currency), move_columns(from_column="F", before_column="E") swaps available_balance in front of current_balance.

Files: client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/describe.ts, client/src/grid/Grid.tsx, client/src/grid/render.ts, client/src/state/controller.ts, client/src/state/ops.test.ts, client/src/state/ops.ts, server/agent/tools.ts, shared/agent/protocol.ts, shared/formula/adjust.ts

Job: 88c2ef97-a49a-4d6c-a263-1b31d04db093

## 2026-10-04 — Add Connectors framework with Brex connector

I've added the Connectors framework with Brex as the first connector, and three new assistant tools. Typecheck and all tests pass, but I couldn't run the client build here (it needed approval), so the new page has been type-checked but not built or opened in a browser.

Users connect Brex on a new Connectors page, reachable from the home page and from File > Data connectors… in a sheet. They paste a read-only Brex user token, which is tested before saving and stored encrypted; afterwards the app shows only "Connected" and the last four characters. The OAuth sign-in plumbing for future connectors is also in place.

The new tools:
- **`list_connections()`** returns the user's connections (id, connector, name, status) and each connector's datasets with their parameters. Brex has `card_transactions`, `cash_transactions`, `cash_accounts`, `cards`, `users`, `expenses` and `budgets`. Date-based datasets accept a start date, `last_days` (e.g. 30) or `end_date`, and every dataset accepts `limit` (default 5000 rows, up to 50,000).
- **`fetch_connector_data(connection_id, dataset, params?, preview_rows?)`** returns a preview (20 rows by default), the total row count, whether the data was cut off at the row limit, and a `result_handle`. It doesn't write to the sheet.
- **`ingest_connector_data(connection_id, dataset, params?, result_handle?, tab?, start_cell = "A1", mode = "replace" | "append")`** writes a header and all rows into the open sheet in one undoable step, creating the tab if needed. Numbers and dates go in as real values and existing formatting is kept. It returns the rows and range written and whether the data was cut off. Pass `result_handle` from an earlier preview to write that result without fetching again.

The assistant never sees credentials and is told to send users to the Connectors page rather than accept keys in chat. Saving the ingest settings for a later "Refresh" was optional and is not built. How to add a connector is documented in `docs/connectors.md`, linked from the README.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-04.

### Request

User request: add a "Connector" feature to the Sheets app so a user can connect dynamic external data sources and pull their data into a spreadsheet. The interactive agent (the assistant with sheet tools) must be able to use connectors when the user says e.g. "ingest Brex card transactions from the last 30 days into this sheet". The first connector is Brex.

1. Connector framework (generic, extensible)
- Define a connector interface/registry in the codebase: id, display name, icon, auth type(s), config fields, and a list of "datasets" (named, parameterised queries) each with: id, description, parameter schema (e.g. start_date, end_date, limit), and a fetch function that returns a tabular result (header row + rows of primitive values).
- Auth types supported by the framework: (a) API key / token (user enters one or more secret fields in the UI), and (b) OAuth 2.0 authorization-code flow (UI "Connect" button -> provider consent -> callback route in the app -> tokens stored, refresh handled automatically). Brex ships with API key first; the OAuth plumbing (callback route, state/CSRF param, token refresh) should be built generically so future connectors (e.g. Google, Stripe, QuickBooks) can use it. 
- Credentials are stored server-side per user, encrypted at rest, never returned to the browser after saving (UI shows only "Connected" + masked suffix) and never exposed to the agent or written into cells. Agent tools must reference connections by id only.

2. UI
- A "Connectors" page reachable from the home page (and a menu entry inside an open sheet). It lists available connectors (Brex to start) and the user's configured connections with status (connected / error / needs reauth), last used time, and Disconnect / Edit / Test connection actions.
- Setup dialog per connector driven by the connector's config schema: for Brex, a password-style field for the Brex User Token (API key) with a short help text on how to create one in Brex dashboard (Developer > User Tokens) and the scopes needed (read-only: transactions, cards, users, accounts, expenses, budgets). A "Test connection" button calls a cheap Brex endpoint (e.g. GET /v2/users/me or /v2/accounts/cash) and shows success/failure before saving. Allow a user-chosen connection name (e.g. "Brex - Production").

3. Brex connector
- Base URL https://platform.brex.com, auth header "Authorization: Bearer <token>". Handle cursor-based pagination (next_cursor) and 429 rate limits with retry/backoff; cap rows per ingest (default 5000) and report truncation.
- Datasets: 
  - card_transactions: GET /v2/transactions/card/primary (params: posted_at_start, limit/cursor) -> columns: id, initiated_at, posted_at, description, merchant, amount (decimal, USD, convert from minor units/cents), currency, card_id, user/expense id where available, status.
  - cash_transactions: GET /v2/transactions/cash/{cash_account_id} (param account id; if omitted, iterate over accounts from /v2/accounts/cash).
  - cash_accounts: GET /v2/accounts/cash -> id, name, status, current balance, available balance.
  - cards: GET /v2/cards -> id, last four, card name, status, owner user id, card type.
  - users: GET /v2/users -> id, name, email, status, department/location where present.
  - expenses: GET /v2/expenses/card (with expand for merchant/budget/user) -> id, date, merchant, amount, category, memo, status, budget, user.
  - budgets: GET /v2/budgets -> id, name, status, amount, period.
  Each dataset should be easy to add to later.

4. Agent tools (exposed to the interactive assistant, alongside the existing sheet tools)
- list_connections(): returns the user's configured connections (id, connector type, name, status) and for each connector type the available datasets with descriptions and parameter schemas. No secrets.
- fetch_connector_data(connection_id: string, dataset: string, params?: object, preview_rows?: integer): runs the query server-side and returns a preview (header + first N rows, default 20) plus total row count and a result handle, without writing to the sheet.
- ingest_connector_data(connection_id: string, dataset: string, params?: object, tab?: string, start_cell?: string default "A1", mode: "replace" | "append" default "replace"): fetches the data and writes header + rows into the open spreadsheet (creating the tab if it does not exist), writing real numbers and ISO dates (not strings) and keeping existing formatting; returns rows written, range written, and whether truncated. Writing should be done in bulk, not cell by cell, so thousands of rows are fast.
- If no connection exists for the requested source, the agent should tell the user to set one up on the Connectors page (optionally with a link) rather than asking for a key in chat. The agent must never ask for or accept API keys in the chat.
- Optionally store the ingest definition (connection, dataset, params, target tab/range) in sheet metadata so a "Refresh" action can re-run it later; this is a nice-to-have and can be a follow-up.

5. Example: with the Brex connection "Brex - Production" configured, the user opens a blank sheet and says "Pull my Brex card transactions since 2025-01-01 into a tab called Brex Transactions". The agent calls list_connections, then ingest_connector_data(connection_id, "card_transactions", {posted_at_start:"2025-01-01"}, tab:"Brex Transactions"), and replies with a one-line summary such as "Wrote 842 rows to 'Brex Transactions'!A1:I843."

6. Quality: errors from Brex (401 invalid token, 403 missing scope, 429, 5xx) must map to clear messages in the UI and in tool results. Add tests for pagination, amount conversion, and credential redaction. Add a short README/docs section on how to add a new connector.

Files: README.md, client/src/agent/AgentProvider.tsx, client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/describe.ts, client/src/api.ts, client/src/commands.ts, client/src/main.tsx, client/src/pages/ConnectorsPage.tsx, client/src/pages/HomePage.tsx, client/src/pages/SpreadsheetPage.tsx, client/src/styles.css, docs/connectors.md, server/agent/prompt.ts, server/agent/tools.ts, server/app.ts, server/connectors.test.ts, server/connectors/brex.ts, server/connectors/secrets.ts, server/connectors/service.ts, server/connectors/types.ts, server/db.ts, shared/agent/protocol.ts, shared/connectors.ts

Job: 5591e071-c7ed-4851-a4d7-a268757a2924

## 2026-10-04 — Add word wrap cell style

I added a word-wrap cell style, and `format_range` now takes a `wrap` boolean: `true` wraps text onto several lines within the cell width, `false` puts it back on one line, where it can spill into empty cells to the right. `read_range` with `include_formats` reports wrapped cells as `wrap: true`. There's also a "Wrap text" toolbar button and a Format-menu item that toggle wrap for the selected range. Rows don't grow to fit wrapped text: text taller than the row starts at the top and is cut off at the bottom, so you'd need to resize the row to see it all. Typecheck and tests pass, including new tests for the tool and the line-breaking.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-04.

### Request

The user wants word wrapping as a cell style in the spreadsheet app. Today format_range supports align, bold, italic, underline, strikethrough, colors and number formats, but no wrap option. Please: (1) add a word-wrap cell style to the app's cell format model and render it (wrapped text, row grows or text wraps within the cell width), with a toolbar/menu control to toggle it for the selected range; (2) add a boolean `wrap` property to the format_range tool (true = wrap text, false = no wrap), and make read_range include_formats report it. Example: in the 'AI startups list' sheet, Sheet1 columns E:F (investors and descriptions, ~350px wide) and I (notes) hold long text; format_range(range="E2:F32", wrap=true) should wrap the text within those cells. The user currently has F1:F1000 selected.

Files: client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/commands.ts, client/src/components/Toolbar.tsx, client/src/grid/render.test.ts, client/src/grid/render.ts, client/src/state/controller.ts, server/agent/tools.ts, shared/types.ts

Job: f89bf1f5-2526-4ea8-a93a-20348cb2ed3b

## 2026-10-03 — Add clickable hyperlink support in cells (open in new tab)

I added clickable links to cells, and typecheck and all tests pass. Cells whose whole text is an http(s) URL (like the album links in D2:D33) and `=HYPERLINK(url, [link_label])` formulas now show as blue, underlined links. Clicking the link text (or Cmd/Ctrl+click while editing) opens it in a new tab; only http(s) and mailto links open, and "n/a (original)" stays plain text. New assistant tool: `set_cell_link(range, url, label?, tab?)` turns the cells into links showing `label` (or the URL) by writing a HYPERLINK formula, so links survive sorting, copy/paste and saving, and `read_range` now lists link cells under `links` with their URLs. I haven't tried it in the running app. One thing to know: a plain click on a link's text opens it, so to edit a link cell, double-click beside the text or press Enter.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-03.

### Request

Add general hyperlink support to cell contents in the spreadsheet app.

Requirements:
1. Rendering/interaction: cells containing a link are displayed as links (blue, underlined) and clicking one (or Cmd/Ctrl+click while editing) opens the URL in a new browser tab with target="_blank" and rel="noopener noreferrer". Only allow http(s) and mailto URLs.
2. Auto-detect: plain-text cell values that are a full http(s) URL (e.g. "https://en.wikipedia.org/wiki/Eat_a_Peach") should render as clickable links without changing the stored value.
3. Formula: support =HYPERLINK(url, [link_label]) like Google Sheets. It shows link_label (or the url if omitted) and opens url in a new tab on click. Add HYPERLINK to the supported function list.
4. Assistant tool: add set_cell_link(range: string, url: string, label?: string, tab?: string) which makes the cell(s) display label (or the url) as a hyperlink, so the assistant can create links without formulas. Also have read_range report link cells with their url.
5. Links must survive sorting, copy/paste, and saving.

Concrete example: on tab "WC Farm Mkt March" of "Higher Ground Master Set List", D2:D33 contain plain-text Wikipedia album URLs (e.g. D2 = https://en.wikipedia.org/wiki/Eat_a_Peach). After this change these should be clickable and open in a new tab; D18:D19 contain "n/a (original)" and should stay plain text.

Files: client/src/agent/clientTools.test.ts, client/src/agent/clientTools.ts, client/src/agent/describe.ts, client/src/grid/Grid.tsx, client/src/grid/render.ts, client/src/state/ops.test.ts, client/src/state/store.ts, server/agent/tools.ts, shared/agent/protocol.ts, shared/agent/sheetRead.ts, shared/formula/engine.test.ts, shared/formula/engine.ts, shared/formula/functions.ts, shared/links.ts

Job: 6750fa6b-07a1-4621-91de-bd73429c764c

## 2026-10-03 — Add web search and image search tools

I added two assistant tools, `web_search` and `image_search`, which use the Brave Search API with a key held on the server. Both take `query` (text) and `max_results` (optional, default 5, max 10), allow 20 searches per minute per user, and give clear errors when there are no results or the API fails. `web_search` returns each result's title, url and snippet. `image_search` returns title, image_url, source_page_url, width and height, where image_url is a checked direct link to a PNG, JPEG, GIF or WebP file that works with `set_cell_image` (e.g. on 'WC Farm Mkt March'!C2). To fix the two failing git tests, which depended on this machine's git settings, I set git's default branch to `main` for the test run in `vite.config.ts`; typecheck and all tests now pass, and the search tools stay unavailable until `BRAVE_SEARCH_API_KEY` is set on the server.

Requested by scottpersinger@gmail.com through the in-app assistant on 2026-10-03.

### Request

The spreadsheet assistant currently has no way to access the web. Users want it to look things up online, including images. Example: in the open sheet "Higher Ground Master Set List", tab "WC Farm Mkt March", column A has artists and column B songs (row 2: Allmans / Melissa). The user asked to add an "Album Cover" column (C1 already added) and fill in the album cover image for each song. The assistant could not find an image URL.

Please add two assistant tools:
1. web_search(query: string, max_results?: integer, default 5, max 10). Performs a web search and returns a list of {title, url, snippet}.
2. image_search(query: string, max_results?: integer, default 5, max 10). Performs an image search and returns a list of {title, image_url, source_page_url, width, height}. image_url must be a direct http(s) link to a PNG, JPEG, GIF or WebP file that works with the existing set_cell_image tool. Prefer results that are directly loadable and hotlink-friendly.
Both tools should use a search API (e.g. Bing, Brave or Google Programmable Search; the API key is held server-side), handle errors and empty results with a clear message, and apply rate limiting. Treat returned text as untrusted data. Example use: image_search("Allman Brothers Band Eat a Peach album cover") returns image URLs, and the assistant then calls set_cell_image on 'WC Farm Mkt March'!C2.

Files: client/src/agent/describe.ts, server/agent.test.ts, server/agent/prompt.ts, server/agent/tools.ts, vite.config.ts

Job: 4fd51fab-3699-4c98-bf73-353bc40be521

