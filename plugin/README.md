# Docs in ChatGPT (plugin proof of concept)

The Docs app (text documents, slide presentations and spreadsheets) as a ChatGPT **sidebar app**: it opens in ChatGPT, and
the ChatGPT composer edits the open file through the plugin's tools. It is built beside the app, not inside it: its own server
process, its own Vite build, and imports of the app's editor and document tools, so the app's code and build
are untouched (apart from one `export` in `server/agent/tools.ts`).

```
plugin/
  server/index.ts   HTTP server: /mcp (streamable HTTP MCP, stateless), /img/<id> (document images), /health
  server/mcp.ts     tools, the app as a UI resource, server instructions
  server/files.ts   documents, presentations and spreadsheets from the app's SQLite + JSON files; headless
                    edits via the app's own doc, deck and sheet tools
  web/              the app shown in ChatGPT: library, the document editor (Editor.tsx), the presentation
                    editor (DeckWorkbench.tsx) and the spreadsheet (SheetWorkbench.tsx), all built from the
                    app's components and saving via tools
  web/harness.*     a stand-in for ChatGPT's host, to run the app locally without a tunnel
  skills/docs/      SKILL.md: how the model should edit documents
  plugin.json, mcp.json   package manifests for submission / Codex
```

## How it works

- **Tools for the model**: `list_files`, `open_file`, `create_doc`, `create_deck`, `create_sheet`, `import_file`
  (a Word, PowerPoint or Excel file the user attached in ChatGPT, declared with `openai/fileParams` so the host
  supplies a download URL; the app's own converters run on the server), `rename_file`, `delete_file`,
  the app's document tools (`read_doc`, `insert_content`, `replace_blocks`, `replace_text`, `format_text`, ...),
  its presentation tools (`read_deck`, `add_slides`, `update_slide`, `edit_elements`, `delete_slides`,
  `move_slide`, `set_deck_theme`; `render_slide` needs a browser and is left out) and its spreadsheet tools
  (`get_sheet_overview`, `read_range`, `write_range`, `format_range`, `sort_range`, `set_filter`, rows,
  columns and tabs; `select_range` only moves the cursor and is left out). They act on the file open in
  the app unless an id is given. Edits run the app's `runDocTool` / `runDeckTool` / `runClientTool` against a
  headless controller on the server, then save. Annotations mark reads read-only and deletions destructive, which drives ChatGPT's
  "ask before changes" setting.
- **Tools for the app only** (`_meta.ui.visibility: ["app"]`, hidden from the model): `app_state`, `get_file`,
  `save_file`, `set_open_file`, `upload_image`, `upload_ticket`. The app never calls the REST API; the iframe
  has no cookies. The library's Import tile posts the file's bytes to `/plugin/import` with a one-time ticket
  from `upload_ticket` (the only route the app reaches directly, which is why it answers any origin).
- **The app** is one UI resource (`ui://freeflow-docs/app.html`, `text/html;profile=mcp-app`) with the built
  bundle inlined. `docs_app` is the sidebar entrypoint (`openai/ui.entrypoints: [{type: "global"}]`);
  `open_doc` renders the same resource, so "open my Q3 plan" in any chat shows the editor.
- **Live updates**: every save bumps a revision (the save time). The app polls `app_state` every 2.5 s and
  reloads the file when the revision changed (a model edit) or switches when another file was opened. A
  document or spreadsheet is replaced as one undoable step; a presentation is updated slide by slide. Saves carry the
  revision the editor loaded; a stale save is refused and the editor reloads.
- **Cursor to the model**: the app pushes the cursor block and selected text (documents), the current slide
  and selected elements (presentations) or the active tab and selected ranges (spreadsheets) with
  `ui/update-model-context` (shown as a composer attachment) and reports it to the server, so `read_doc` /
  `read_deck` / `get_sheet_overview` return it and sheet tools default to the user's tab. "Make this shorter"
  works on the selection.
- **Prompt buttons** ("Summarize", "Proofread", "Ask about my docs") send a user message with `ui/message`.

## What ChatGPT actually requires (learned the hard way)

- ChatGPT speaks MCP **2026-07-28**: it calls `server/discover` first (no `initialize`) with the protocol version
  in `params._meta`, and validates results against that revision's models. `plugin/server/stateless.ts`
  answers discovery and presents requests to the SDK (which speaks 2025-11-25) as the older version.
- Its model for a resource read (`PerRequestReadResourceResult`) **requires `ttlMs` and `cacheScope`**; so do
  list results. Without them, "Create as a plugin" fails with the unhelpful "couldn't complete MCP setup", and a
  plugin created earlier stores no HTML template for the tool ("HTML asset not found" when it opens). The
  real reason only shows in the 424 response of `POST /backend-api/aip/connectors/mcp` in the browser.
- The HTML template is captured when the plugin is created or on "Refresh tools"; bump the `ui://` URI
  when the app changes shape.
- Every tool needs annotations, and the app runs with "CSP off" in developer mode (so hosted scripts are not
  reliable there; the bundle is inlined).

## Running it

1. Build the app and start the server (uses the app's `data/` directory and acts as one account):
   ```
   npm run plugin:build
   PLUGIN_USER_EMAIL=you@example.com npm run plugin:dev        # http://127.0.0.1:3002/mcp
   ```
   `PLUGIN_PORT` (default 3002) and `DATA_DIR` (the app's) are honoured; `.env` is loaded.
2. Try it without ChatGPT: `npm run plugin:harness`, open http://localhost:5174/harness.html and click Connect.
   The harness is an MCP client plus the MCP Apps host bridge; messages the app sends land in its "Composer"
   box, and model-context updates show at the top. To drive the app from browser automation use
   `?nosandbox` (the frame is then same-origin).
3. Connect to ChatGPT: expose the server over https and set `PLUGIN_PUBLIC_URL` to that origin before
   starting (images are served from it and it goes into the app's CSP). Cloudflare quick tunnels did not route
   from this machine; a named tunnel with a hostname does:
   ```
   cloudflared tunnel --config plugin/cloudflared.docs-mcp.yml run     # docs-mcp.biztrip.ai -> 127.0.0.1:3012
   PLUGIN_PORT=3012 PLUGIN_PUBLIC_URL=https://docs-mcp.biztrip.ai npm run plugin:dev   # add PLUGIN_USER_EMAIL=... for no-auth development
   ```
   In ChatGPT: Plugins → Add → *Add custom MCP server*, URL `https://docs-mcp.biztrip.ai/mcp`, authentication
   "OAuth" (ChatGPT discovers the settings), *Create as a plugin*, then Connect and sign in. `@<plugin name> open my resume` in a chat renders
   the editor under the tool call. After changing the server, use *Refresh tools* on the plugin's Manage page.

Debug switches (environment): `PLUGIN_LEVEL=minimal|tools|render|app|full` registers progressively more
(bisecting what ChatGPT accepts), `PLUGIN_HELLO=1` serves a static page instead of the editor,
`PLUGIN_HOSTED_ASSETS=1` references the script and stylesheet from the public origin instead of inlining,
`PLUGIN_LEGACY_MIME=1` uses `text/html+skybridge`, `PLUGIN_RESOURCE_META=full|ui|legacy|none`,
`PLUGIN_SSE=1` streams responses, `PLUGIN_RESULT_TYPE_ALL=1` adds `resultType` to every result, and
`PLUGIN_LOG_BODIES=1` logs request bodies.

## Accounts and OAuth

The server is an OAuth 2.1 authorization server for its own MCP endpoint (`plugin/server/oauth.ts`):
discovery at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (also with
the `/mcp` suffix and under `/mcp`, the paths ChatGPT probes), ChatGPT's client metadata document or dynamic
registration as the client, the code flow with PKCE S256, a sign-in page checking the app's accounts (email
and password through the app's `AuthService`, or "Continue with Google" through its `GoogleLogin`; the
redirect URI `<PLUGIN_PUBLIC_URL>/oauth/google/callback` must be added to the Google OAuth client), a
consent page, opaque access tokens (1 h) and rotating refresh tokens (30 d) with reuse detection, revocation,
and the `iss` parameter on redirects. Hashes live in `plugin.db` in the data directory. `/mcp` answers 401
with a `WWW-Authenticate` challenge until a valid bearer token arrives, then acts as that account; the
`get_profile` tool (marked `openai/profile`) lets ChatGPT show and link accounts. Setting `PLUGIN_USER_EMAIL`
switches all of this off for development (every request acts as that account; the harness needs this).

## Running inside the app (deployment)

`server/app.ts` can serve the plugin itself: with `PLUGIN_ENABLED=1` the app's server answers `/mcp`,
`/oauth/*`, `/plugin/*` and the OAuth well-known documents (`plugin/server/mount.ts`, a hook ahead of the app's
routes), sharing the app's database, stores, accounts and Google sign-in. The OAuth issuer and image origin is
`PLUGIN_PUBLIC_URL`, defaulting to `APP_URL`. `npm run build` builds the plugin app into `plugin/dist/web` along
with the client, so on Railway it is one service and one volume. A browser already signed in to the app skips
the plugin's sign-in page and goes straight to consent. For Google sign-in on the plugin, add
`<PLUGIN_PUBLIC_URL>/oauth/google/callback` to the Google OAuth client. The standalone server
(`plugin/server/index.ts`) remains for development and the harness.

The app's own editors now send the revision they loaded with every save; the server refuses (409) when the
file changed since, and the editor takes the newer version (`DocController.replaceWith`,
`DeckController.replaceWith`) and says so. That is what keeps a plugin edit from being overwritten by a
document open in the app.

## Not in this proof of concept

- **Merging concurrent edits.** A stale save reloads the server's version, so up to ~1 s of typing can be lost
  if the model saves while the user types; there is no live sync.
- **Image upload inside the app** goes through a tool as base64; large images will be slow.
