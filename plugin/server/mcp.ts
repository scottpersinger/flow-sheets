// The MCP server ChatGPT talks to: the model's document and presentation tools, the tools the app (the MCP
// App shown in ChatGPT) uses to load and save files, and the app itself as a UI resource.
//
// One McpServer is built per HTTP request (stateless streamable HTTP), so this must stay cheap.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { schemas } from '../../server/agent/tools.ts';
import { MAX_OUTLINE_BLOCKS } from '../../shared/agent/docRead.ts';
import type { ThemeId } from '../../shared/deck.ts';
import { ConflictError, DECK_EDIT_TOOLS, DOC_EDIT_TOOLS, FILE_KINDS, FileService, importLimit, LIBRARY_KINDS, MAX_IMPORT_BYTES, sniffImageType, SHEET_EDIT_TOOLS, ToolError, type LibraryKind, type DeckEditTool, type DocEditTool, type FileData, type FileKind, type SheetEditTool, type SlideSpec } from './files.ts';

/**
 * The app's resource URI. Hosts capture the HTML by URI when the plugin is created or its tools refreshed, so
 * the URI carries the bundle's content hash: a rebuilt app is a new URI, never a stale copy under the old one.
 */
export const appUri = (hash: string): string => `ui://freeflow-docs/app-${hash}.html`;
export const SERVER_INFO = { name: 'freeflow-docs', version: '0.2.0' };
/** What the server advertises: tools, resources, and MCP Apps UI resources. */
export const SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  resources: { listChanged: true },
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

export interface Bundle {
  js: string;
  css: string;
  /** Short content hash, for cache busting when the bundle is served as files. */
  hash: string;
}

export interface McpOptions {
  /** The built app. */
  bundle: () => Bundle;
  /** Public origin: where images are served from, and the app's script and stylesheet with hostedAssets. */
  publicUrl: string | null;
  /** Reference the script and stylesheet at publicUrl instead of inlining them. ChatGPT runs a custom
   *  server's app with its CSP off and did not load an external script; inline is the safe default. */
  hostedAssets?: boolean;
  /** Serve a static test page instead of the app, to tell host problems from app problems. */
  helloPage?: boolean;
  /** Serve the resource as the legacy Apps SDK type (text/html+skybridge) instead of the MCP Apps type. */
  legacyMime?: boolean;
  /** Which _meta to put on the resource content: everything, only the MCP Apps keys, only the legacy keys, or none. */
  resourceMeta?: 'full' | 'ui' | 'legacy' | 'none';
  /** For bisecting what ChatGPT's setup rejects: 'minimal' is list_files alone, 'tools' is every model tool
   *  but no UI (no resource, no app-only tools, no entrypoint), 'render' adds the resource and open_file
   *  rendering it, 'app' adds the app-only tools and the docs_app tool, 'full' (default) adds the sidebar
   *  entrypoint. */
  level?: 'minimal' | 'tools' | 'render' | 'app' | 'full';
  /** Fetches files ChatGPT hands to import_file (tests pass a fake). */
  fetchFn?: typeof fetch;
}


export const INSTRUCTIONS = `Freeflow Docs: the user's text documents, slide presentations and spreadsheets, with an app that shows one file open for editing.
Document tools (read_doc, insert_content, replace_blocks, ...) act on the open document, presentation tools (read_deck, add_slides, update_slide, ...) on the open presentation and spreadsheet tools (get_sheet_overview, read_range, write_range, ...) on the open spreadsheet unless an id is given. Read first (read_doc, read_deck or get_sheet_overview) to learn block or slide numbers, element ids or the data layout; they change after inserts and deletes. Spreadsheet tools act on the tab the user is looking at unless a tab is given; write formulas (starting with =) rather than computed numbers. Write document content as Markdown. Keep edits targeted: change the blocks, slides, elements or cells that need changing rather than rewriting everything. After editing, the open file updates in the app by itself; do not call open_file again.`;

const DOC_ICON = {
  src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.5h7l3.5 3.5v11.5h-10.5z"/><path d="M12 2.5v3.5h3.5"/><path d="M7.5 10h5M7.5 13h5"/></svg>'),
  mimeType: 'image/svg+xml',
  sizes: ['20x20'],
};

const kind = z.enum(FILE_KINDS as [FileKind, ...FileKind[]]).describe('doc (text document), deck (slide presentation) or sheet (spreadsheet).');
/** For the tools that work on anything in the library, stored files included. */
const anyKind = z.enum(LIBRARY_KINDS as [LibraryKind, ...LibraryKind[]]).describe('doc (text document), deck (slide presentation), sheet (spreadsheet) or file (a PDF, web page, video or image, which is shown but not edited).');
const fileId = z.string().describe('The file id (from list_files or the app).');
const optionalDocId = z.string().optional().describe('The document to act on. Defaults to the document open in the app.');
const optionalDeckId = z.string().optional().describe('The presentation to act on. Defaults to the presentation open in the app.');
const optionalSheetId = z.string().optional().describe('The spreadsheet to act on. Defaults to the spreadsheet open in the app.');
type EditTool = DocEditTool | DeckEditTool | SheetEditTool;

/** Which of the app's tools change the file, for ChatGPT's "ask before changes" setting. */
const ANNOTATIONS: Record<EditTool, { readOnlyHint: boolean; destructiveHint: boolean }> = {
  read_doc: { readOnlyHint: true, destructiveHint: false },
  get_doc_info: { readOnlyHint: true, destructiveHint: false },
  insert_content: { readOnlyHint: false, destructiveHint: false },
  replace_blocks: { readOnlyHint: false, destructiveHint: true },
  delete_blocks: { readOnlyHint: false, destructiveHint: true },
  replace_text: { readOnlyHint: false, destructiveHint: false },
  format_text: { readOnlyHint: false, destructiveHint: false },
  format_blocks: { readOnlyHint: false, destructiveHint: false },
  insert_image: { readOnlyHint: false, destructiveHint: false },
  set_doc_style: { readOnlyHint: false, destructiveHint: false },
  set_page_setup: { readOnlyHint: false, destructiveHint: false },
  read_deck: { readOnlyHint: true, destructiveHint: false },
  add_slides: { readOnlyHint: false, destructiveHint: false },
  update_slide: { readOnlyHint: false, destructiveHint: false },
  edit_elements: { readOnlyHint: false, destructiveHint: false },
  delete_slides: { readOnlyHint: false, destructiveHint: true },
  move_slide: { readOnlyHint: false, destructiveHint: false },
  set_deck_theme: { readOnlyHint: false, destructiveHint: false },
  get_sheet_overview: { readOnlyHint: true, destructiveHint: false },
  read_range: { readOnlyHint: true, destructiveHint: false },
  write_range: { readOnlyHint: false, destructiveHint: false },
  clear_range: { readOnlyHint: false, destructiveHint: true },
  format_range: { readOnlyHint: false, destructiveHint: false },
  insert_rows: { readOnlyHint: false, destructiveHint: false },
  delete_rows: { readOnlyHint: false, destructiveHint: true },
  insert_columns: { readOnlyHint: false, destructiveHint: false },
  delete_columns: { readOnlyHint: false, destructiveHint: true },
  move_columns: { readOnlyHint: false, destructiveHint: false },
  sort_range: { readOnlyHint: false, destructiveHint: false },
  set_cell_image: { readOnlyHint: false, destructiveHint: false },
  set_cell_link: { readOnlyHint: false, destructiveHint: false },
  set_filter: { readOnlyHint: false, destructiveHint: false },
  set_filter_criteria: { readOnlyHint: false, destructiveHint: false },
  set_column_width: { readOnlyHint: false, destructiveHint: false },
  set_row_height: { readOnlyHint: false, destructiveHint: false },
  freeze: { readOnlyHint: false, destructiveHint: false },
  add_tab: { readOnlyHint: false, destructiveHint: false },
  rename_tab: { readOnlyHint: false, destructiveHint: false },
  delete_tab: { readOnlyHint: false, destructiveHint: true },
};

/** Descriptions that differ from the in-app assistant's (which mention things only it has). */
const DESCRIPTIONS: Partial<Record<EditTool, string>> = {
  insert_image: 'Add an image block to the open document from an https URL, or from an image the user attached in the chat (pass it as file). To save a picture as a file of its own, use import_file instead. (Markdown ![alt](src) on its own line in insert_content does the same without a width.)',
  set_cell_image:
    'Show an image inside a cell, scaled to fit the cell: from an https URL, or from an image the user attached in the chat (pass it as file). Replaces the cell\'s value; keeps its formatting. Make the row taller or the column wider (set_row_height, set_column_width) if the image should appear larger.',
  replace_blocks: 'Replace blocks from..to of the document with new content written as Markdown. Use this to rewrite a paragraph or a whole section; prefer replace_text for small wording changes.',
  delete_blocks: 'Delete blocks from..to of the document.',
  delete_slides: 'Delete slides by number.',
  read_deck: 'Outline of the presentation: theme, every slide with its layout, elements (id, type, position, text) and notes, and which slide the user is on. Call this before changing slides.',
  get_sheet_overview:
    'Describe the spreadsheet: every tab with its size, used range, frozen panes, filter and first few rows, plus the range the user has selected. Call this first when you need to know how the data is laid out.',
};

/** Tools that take an image, and the field it goes in: the user's attachment can stand in for the address. */
const IMAGE_TOOLS: Partial<Record<EditTool, string>> = { set_cell_image: 'url', insert_image: 'src' };

const attachedFile = z.object({
  download_url: z.string().describe('Where to download the file (filled in by ChatGPT).'),
  file_id: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

/** Fetch an attached file from the host, within limits. Only https, and never an address on a private network. */
async function download(url: string, fetchFn: typeof fetch, limit: number): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ToolError('The file address is not a valid URL.');
  }
  if (u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[|0\.)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) throw new ToolError('Files can only be fetched from public https addresses.');
  const res = await fetchFn(u, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new ToolError(`Could not download the file (${res.status}).`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limit) throw new ToolError(`The file is too large to import (over ${limit / 1024 / 1024} MB).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > limit) throw new ToolError(`The file is too large to import (over ${limit / 1024 / 1024} MB).`);
  if (!bytes.length) throw new ToolError('The file is empty.');
  return bytes;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run a tool body, turning the errors the model (or the app) should see into error results. */
async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError || e instanceof ConflictError) return fail(e.message);
    if (e instanceof Error && e.name === 'RangeError') return fail(e.message);
    throw e;
  }
}

/** The page shown in ChatGPT. `appUrl` is where the full app lives, for its "Open in Freeflow" links. */
export function appHtml(bundle: Bundle, assetOrigin: string | null, appUrl: string | null = null): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Docs</title>${appUrl ? `<meta name="freeflow-url" content="${escape(appUrl)}">` : ''}`;
  if (assetOrigin) {
    // Served from our own origin, which the resource's CSP (resourceDomains) allows.
    return `<!doctype html>\n<html lang="en"><head>${head}<link rel="stylesheet" href="${assetOrigin}/plugin/app.css?v=${bundle.hash}"></head><body><div id="root"></div><script type="module" src="${assetOrigin}/plugin/app.js?v=${bundle.hash}"></script></body></html>`;
  }
  // Inlined: the host's default CSP allows inline scripts and styles.
  const js = bundle.js.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>\n<html lang="en"><head>${head}<style>${bundle.css}</style></head><body><div id="root"></div><script type="module">${js}</script></body></html>`;
}

const HELLO = '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;padding:16px}</style></head><body><h1>Docs</h1><p>Hello from the Docs plugin. If you can read this, ChatGPT can show our pages.</p></body></html>';

export function createMcpServer(service: FileService, opts: McpOptions): McpServer {
  const server = new McpServer({ ...SERVER_INFO, icons: [DOC_ICON] }, { instructions: INSTRUCTIONS });
  const level = opts.level ?? 'full';
  const ui = level === 'render' || level === 'app' || level === 'full';
  // Only the levels that show the app need the bundle. An unbuilt app still lists its tools (the resource
  // read is where "run npm run plugin:build" surfaces), under a URI no built app will ever have.
  const bundleHash = (): string => {
    try {
      return opts.bundle().hash;
    } catch {
      return 'unbuilt';
    }
  };
  const APP_URI = ui ? appUri(bundleHash()) : '';
  const appTools = level === 'app' || level === 'full';
  const entrypoint = level === 'full';

  const listFiles = { title: 'List files', description: "The user's documents, presentations, spreadsheets and stored files (PDFs, web pages, videos and images), most recently edited first, with their ids. Optionally one kind, or filtered by a word in the title.", inputSchema: { kind: anyKind.optional(), query: z.string().max(200).optional().describe('Only files whose title contains this text.') }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
  server.registerTool('list_files', listFiles, async ({ kind: k, query }) => guard(() => ok({ files: service.list(k, query).slice(0, 50), ...service.state() })));
  if (level === 'minimal') return server;

  if (ui) server.server.registerCapabilities(SERVER_CAPABILITIES);

  // Shaped like OpenAI's reference plugin (bits-and-bolts). The declared domains apply once the app is
  // reviewed; in developer mode ChatGPT runs the app with its CSP off.
  const origins = opts.publicUrl ? [opts.publicUrl] : [];
  const uiMeta = {
    ui: {
      csp: { connectDomains: origins, resourceDomains: [...origins, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
      prefersBorder: true,
    },
    'openai/ui': { preferredDisplayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
    // Legacy Apps SDK aliases of the same things, which ChatGPT's web host still reads.
    'openai/widgetDescription': 'The Freeflow Docs editor: the open document, presentation or spreadsheet, editable in place.',
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': { connect_domains: origins, resource_domains: [...origins, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
  };
  /** Tool metadata linking to the app, in both the MCP Apps form and the legacy Apps SDK form. */
  const rendersApp = (extra: Record<string, unknown> = {}) => ({ ui: { resourceUri: APP_URI, ...extra }, 'openai/outputTemplate': APP_URI });

  // --- The app ---------------------------------------------------------------------------

  const mimeType = opts.legacyMime ? 'text/html+skybridge' : RESOURCE_MIME_TYPE;
  const pick = opts.resourceMeta ?? 'full';
  const contentMeta = pick === 'none' ? undefined : pick === 'ui' ? { ui: uiMeta.ui } : pick === 'legacy' ? Object.fromEntries(Object.entries(uiMeta).filter(([k]) => k.startsWith('openai/widget'))) : uiMeta;
  if (ui)
    server.registerResource('docs-app', APP_URI, { title: 'Docs', mimeType }, async () => ({
      contents: [{ uri: APP_URI, mimeType, text: opts.helloPage ? HELLO : appHtml(opts.bundle(), opts.hostedAssets ? opts.publicUrl : null, opts.publicUrl), ...(contentMeta ? { _meta: contentMeta } : {}) }],
    }));

  // Opens from ChatGPT's sidebar: the whole app, with the composer alongside.
  if (appTools)
    server.registerTool(
      'docs_app',
      {
        title: 'Docs',
        description: 'Open the Docs app.',
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { ...rendersApp({ visibility: ['app'] }), 'openai/widgetAccessible': true, ...(entrypoint ? { 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } : {}) },
      },
      async () => ok({ ...service.state() }),
    );

  // --- Tools for the model (the app may call these too) ----------------------------------------

  // Which account is linked (ChatGPT shows it and can link several).
  server.registerTool(
    'get_profile',
    {
      title: 'Linked account',
      description: 'The account the plugin is signed in as: its id and email.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { 'openai/profile': true },
    },
    async () => {
      const p = service.profile();
      return ok({ id: p.id, email: p.email, name: p.email });
    },
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create document',
      description: 'Create a new text document, optionally with content written as Markdown, and open it in the app.',
      inputSchema: { title: z.string().min(1).max(200), markdown: z.string().max(200_000).optional().describe('Initial content as Markdown. Supports headings, lists, quotes, code blocks, images, links, bold and italics.') },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, markdown }) =>
      guard(async () => {
        const file = await service.createDoc(title, markdown);
        service.setOpen({ kind: 'doc', id: file.id });
        return ok({ file, ...service.state() });
      }),
  );

  server.registerTool(
    'create_deck',
    {
      title: 'Create presentation',
      description: 'Create a new slide presentation, optionally with its slides, and open it in the app.',
      inputSchema: schemas.create_deck.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, theme, slides }) =>
      guard(async () => {
        const file = await service.createDeck(title, theme as ThemeId | undefined, (slides ?? []) as SlideSpec[]);
        service.setOpen({ kind: 'deck', id: file.id });
        return ok({ file, ...service.state() });
      }),
  );

  server.registerTool(
    'create_sheet',
    {
      title: 'Create spreadsheet',
      description: 'Create a new, empty spreadsheet and open it in the app. Fill it in with write_range.',
      inputSchema: schemas.create_sheet.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title }) =>
      guard(async () => {
        const file = await service.createSheet(title);
        service.setOpen({ kind: 'sheet', id: file.id });
        return ok({ file, ...service.state() });
      }),
  );

  // A file the user attached in ChatGPT: the host turns the `file` argument into a download URL (openai/fileParams).
  server.registerTool(
    'import_file',
    {
      title: 'Import a file',
      description:
        'Import any file the user attached and open it in the app. Always try this first when the user wants a file uploaded, saved or added to their files: pass the attachment whatever its type, and if the type is not one the app can take, the tool returns an error that says so (tell the user; do not work around it by putting the file inside a new document). What each type becomes: a Word document (.docx) or Markdown file (.md) a new document; a PowerPoint presentation (.pptx) a new presentation; an Excel workbook (.xlsx) or CSV file (.csv) a new spreadsheet; a PDF, web page (.html, such as a page or chart you generated), video (.mp4, .mov, .webm) or image (PNG, JPEG, GIF, WebP) a stored file, kept as it is and shown in the app\'s viewer (a web page is rendered, with its scripts running in a sandbox), which the other tools cannot read or edit. insert_image and set_cell_image are only for putting a picture inside a document or a spreadsheet cell.',
      inputSchema: {
        file: attachedFile.describe('The attached file.'),
        title: z.string().max(200).optional().describe('Title for the new file. Defaults to the file name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { 'openai/fileParams': ['file'] },
    },
    async ({ file, title }) =>
      guard(async () => {
        const bytes = await download(file.download_url, opts.fetchFn ?? fetch, importLimit(file.file_name));
        const r = await service.importFile(bytes, file.file_name, title);
        service.setOpen({ kind: r.file.kind, id: r.file.id });
        return ok({ ...r, ...service.state() });
      }),
  );

  // Opening a file shows the app with it (the same app the sidebar opens).
  server.registerTool(
    'open_file',
    {
      title: 'Open file',
      description: `Open a document, presentation or spreadsheet in the app so the user sees it, and return its outline (a document's first ${MAX_OUTLINE_BLOCKS} blocks, every slide, or every tab's layout). The document, presentation or spreadsheet tools then act on it by default. A stored file (a PDF, video or image) is shown in the app's viewer; only its name, type and size come back.`,
      inputSchema: { kind: anyKind, id: fileId },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...(ui ? { _meta: rendersApp() } : {}),
    },
    async ({ kind: k, id }) =>
      guard(async () => {
        service.setOpen({ kind: k, id });
        if (k === 'file') return ok({ file: service.storedFile(id), ...service.state() });
        const outline = k === 'doc' ? await service.editDoc(id, 'read_doc', {}) : k === 'deck' ? await service.editDeck(id, 'read_deck', {}) : await service.editSheet(id, 'get_sheet_overview', {});
        return ok({ ...outline, ...service.state() });
      }),
  );

  server.registerTool(
    'rename_file',
    {
      title: 'Rename file',
      description: 'Change the title of a document, presentation or spreadsheet. Defaults to the open file. A stored PDF, video or image keeps its name.',
      inputSchema: { kind: anyKind.optional(), id: z.string().optional(), title: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ kind: k, id, title }) =>
      guard(() => {
        const target = k && id ? { kind: k, id } : service.open;
        if (!target) return fail('No file is open. Pass kind and id (see list_files).');
        return ok({ file: service.rename(target.kind, target.id, title) });
      }),
  );

  server.registerTool(
    'delete_file',
    {
      title: 'Delete file',
      description: 'Delete a document, presentation, spreadsheet or stored file permanently. Only when the user clearly asks for it.',
      inputSchema: { kind: anyKind, id: fileId },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ kind: k, id }) =>
      guard(async () => {
        await service.delete(k, id);
        return ok({ deleted: id, ...service.state() });
      }),
  );

  const describe = (name: EditTool) => (DESCRIPTIONS[name] ?? schemas[name].description ?? '').replace(/the open (document|presentation|spreadsheet)/g, 'the $1');

  // Image tools also take the image the user attached in the chat (openai/fileParams): the host turns `file`
  // into a download URL, the bytes are stored like an upload, and the address goes where a URL would.
  const inputShape = (name: EditTool): Record<string, z.ZodType> => {
    const shape = schemas[name].shape as Record<string, z.ZodType>;
    const field = IMAGE_TOOLS[name];
    if (!field) return shape;
    return {
      ...shape,
      [field]: (shape[field] as z.ZodString).optional().describe(`${shape[field].description ?? ''} Leave out when passing the attached image as file.`),
      file: attachedFile.optional().describe('An image the user attached in the chat (ChatGPT fills in its download address). Use this instead of an address for attachments.'),
    };
  };
  const imageMeta = (name: EditTool) => (IMAGE_TOOLS[name] ? { _meta: { 'openai/fileParams': ['file'] } } : {});
  const resolveImage = async (name: EditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const field = IMAGE_TOOLS[name];
    if (!field) return input;
    const { file, ...rest } = input as Record<string, unknown> & { file?: z.infer<typeof attachedFile> };
    const url = typeof rest[field] === 'string' ? rest[field].trim() : '';
    if (file?.download_url) {
      const bytes = await download(file.download_url, opts.fetchFn ?? fetch, MAX_IMPORT_BYTES);
      const type = sniffImageType(bytes) ?? file.mime_type ?? '';
      rest[field] = await service.storeImage(type, bytes);
    } else if (/^https?:/i.test(url) && !service.isOwnImage(url)) {
      // A web image is fetched and stored too: the app runs under a CSP that only allows our own origin,
      // and the model should hear now if the address is not an image.
      const bytes = await download(url, opts.fetchFn ?? fetch, MAX_IMPORT_BYTES);
      const type = sniffImageType(bytes);
      if (!type) throw new ToolError(`${url} is not a PNG, JPEG, GIF or WebP image. Give the address of the image file itself, not of a page that shows it.`);
      rest[field] = await service.storeImage(type, bytes);
    } else if (!url) throw new ToolError(`Give ${field} (an https image address) or attach the image as file.`);
    return rest;
  };

  for (const name of DOC_EDIT_TOOLS) {
    server.registerTool(
      name,
      { description: describe(name), inputSchema: { ...inputShape(name), doc_id: optionalDocId }, annotations: { ...ANNOTATIONS[name], openWorldHint: false }, ...imageMeta(name) },
      async (args: Record<string, unknown>) =>
        guard(async () => {
          const { doc_id, ...input } = args as Record<string, unknown> & { doc_id?: string };
          const id = service.target('doc', doc_id);
          if (!id) return fail('No document is open in the app. Pass doc_id (see list_files), or open one with open_file.');
          return ok(await service.editDoc(id, name, await resolveImage(name, input)));
        }),
    );
  }

  for (const name of DECK_EDIT_TOOLS) {
    server.registerTool(
      name,
      { description: describe(name), inputSchema: { ...schemas[name].shape, deck_id: optionalDeckId }, annotations: { ...ANNOTATIONS[name], openWorldHint: false } },
      async (args: Record<string, unknown>) =>
        guard(async () => {
          const { deck_id, ...input } = args as Record<string, unknown> & { deck_id?: string };
          const id = service.target('deck', deck_id);
          if (!id) return fail('No presentation is open in the app. Pass deck_id (see list_files), or open one with open_file.');
          return ok(await service.editDeck(id, name, input));
        }),
    );
  }

  for (const name of SHEET_EDIT_TOOLS) {
    server.registerTool(
      name,
      { description: describe(name), inputSchema: { ...inputShape(name), sheet_id: optionalSheetId }, annotations: { ...ANNOTATIONS[name], openWorldHint: false }, ...imageMeta(name) },
      async (args: Record<string, unknown>) =>
        guard(async () => {
          const { sheet_id, ...input } = args as Record<string, unknown> & { sheet_id?: string };
          const id = service.target('sheet', sheet_id);
          if (!id) return fail('No spreadsheet is open in the app. Pass sheet_id (see list_files), or open one with open_file.');
          return ok(await service.editSheet(id, name, await resolveImage(name, input)));
        }),
    );
  }

  // --- Tools for the app only (hidden from the model) ------------------------------------

  if (!appTools) return server;
  const appOnly = (readOnly: boolean) => ({ _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true }, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } });

  server.registerTool('app_state', { description: 'Which file is open and its revision.', inputSchema: {}, ...appOnly(true) }, async () => ok({ ...service.state() }));

  server.registerTool(
    'set_open_file',
    {
      description: 'The app reports which file it shows (none when omitted) and where the user is in it.',
      inputSchema: {
        kind: anyKind.optional(),
        id: z.string().optional(),
        cursor_block: z.number().int().min(1).optional(),
        selected_text: z.string().max(500).optional(),
        slide: z.number().int().min(1).optional(),
        selection: z.array(z.string()).max(50).optional(),
        tab: z.string().optional(),
      },
      ...appOnly(false),
    },
    async ({ kind: k, id, cursor_block, selected_text, slide, selection, tab }) =>
      guard(() => {
        service.setOpen(k && id ? { kind: k, id } : null, { cursor_block, selected_text, slide, selection, tab });
        return ok({ ...service.state() });
      }),
  );

  server.registerTool('get_file', { description: 'Load a whole file for the editor.', inputSchema: { kind, id: fileId }, ...appOnly(true) }, async ({ kind: k, id }) => guard(async () => ok({ ...(await service.get(k, id)) })));

  server.registerTool(
    'save_file',
    {
      description: 'Save a whole file from the editor. Fails when the revision is stale.',
      inputSchema: { kind, id: fileId, rev: z.string().describe('The revision the editor loaded.'), data: z.looseObject({}).describe('The whole file.') },
      ...appOnly(false),
    },
    async ({ kind: k, id, rev, data }) =>
      guard(async () => {
        try {
          return ok({ ...(await service.save(k, id, data as unknown as FileData, rev)) });
        } catch (e) {
          if (e instanceof ConflictError) return { content: [{ type: 'text', text: e.message }], structuredContent: { conflict: true, rev: e.rev }, isError: true };
          throw e;
        }
      }),
  );

  server.registerTool(
    'upload_ticket',
    { description: 'A one-time ticket and URL for the app to upload a file to import.', inputSchema: {}, ...appOnly(false) },
    async () => guard(() => ok({ ticket: service.hub.issueTicket(service.userId), url: `${opts.publicUrl ?? ''}/plugin/import` })),
  );

  server.registerTool(
    'file_link',
    { description: 'A stored file (a PDF, video or image) and an address the app can load it from for the next few hours.', inputSchema: { id: fileId }, ...appOnly(true) },
    async ({ id }) => guard(() => ok({ ...service.fileLink(id) })),
  );

  server.registerTool(
    'upload_image',
    { description: 'Store an image pasted or dropped into the editor.', inputSchema: { type: z.string(), data: z.string().describe('Base64 bytes.') }, ...appOnly(false) },
    async ({ type, data }) => guard(async () => ok({ src: await service.uploadImage(type, data) })),
  );

  return server;
}
