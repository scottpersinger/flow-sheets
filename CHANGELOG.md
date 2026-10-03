# Changes made by the assistant

Each entry is written by the app itself when a change requested through the assistant goes live.

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

