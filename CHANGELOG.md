# Changes made by the assistant

Each entry is written by the app itself when a change requested through the assistant goes live.

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

