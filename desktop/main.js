// The desktop app (Electron). It opens a folder as the library: the folder given on the command line, or
// the directory the app was started in. The app itself is the web app, served to this window by a local
// server (desktop/server.ts) that reads and writes the folder's files.
import { app, BrowserWindow, clipboard, dialog, Menu, session, shell } from 'electron';
import { execFile, fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { LocalOAuth } from './mcpAuth.js';

const root = path.resolve(import.meta.dirname, '..');
// Also names the app's data directory, which would otherwise be the generic "Electron" one.
// The name the app's data folder is kept under (last folder, each folder's database): changing it would lose them.
app.setName('Universal Docs');
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// The app was called FreeFlow Docs: the first time it starts under its new name, its data folder moves over.
const legacyData = path.join(app.getPath('appData'), 'FreeFlow Docs');
if (!existsSync(app.getPath('userData')) && isDir(legacyData)) {
  try {
    renameSync(legacyData, app.getPath('userData'));
  } catch (e) {
    console.error(`Could not move ${legacyData}: ${e.message}`);
  }
}

// The installed app is started from a menu or an icon, where the current directory means nothing: it
// reopens the folder it showed last, or asks for one the first time.
const lastFolderFile = () => path.join(app.getPath('userData'), 'last-folder.txt');
function lastFolder() {
  try {
    const dir = readFileSync(lastFolderFile(), 'utf8').trim();
    return dir && isDir(dir) ? dir : null;
  } catch {
    return null;
  }
}
function rememberFolder(dir) {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(lastFolderFile(), dir);
  } catch {
    // Not remembered, that's all.
  }
}

/** The running server and the folder it serves. */
let current = null;

// --- The MCP server, for agents on this machine (server/localMcp.ts) ------------------------------------
// The folder's server is on a port the system picks, and a new one starts with each folder. Agents are set up
// once, so they reach it on a fixed port, here, which passes MCP requests on to whichever server is running.
// An agent signs in with OAuth (mcpAuth.js): the person allows it in a dialog of the app, and it gets a token
// of its own. Requests it makes with that token are passed on with a secret the folder's server knows, made
// for each run of the app, which no agent ever sees.
const MCP_PORT = Number(process.env.UNIVERSAL_MCP_PORT) || 39217;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}`;
const MCP_SECRET = randomBytes(32).toString('base64url');
/** False until the port is ours: another copy of the app may hold it. */
let mcpListening = false;
let mcpAuth = null;

/** Ask the person whether an agent may connect, in front of whatever they are doing. */
async function approveAgent(name) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  bringToFront();
  const options = {
    type: 'question',
    title: 'Connect an Agent',
    message: `Allow “${name}” to use Universal Docs?`,
    detail:
      'It will be able to read, change, create and delete the files in the folders you open in the app, and show them in this window, until you disconnect it (File › Connect an Agent).\n\nAllow it only if you just asked an agent on this computer to connect. The name is the one the agent gave itself.',
    buttons: ['Allow', 'Don’t Allow'],
    defaultId: 0,
    cancelId: 1,
  };
  const res = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return res.response === 0;
}

/** What a request may be addressed to: this port on this computer, not a name a web page made point here. */
const ownHost = (host) => host === `127.0.0.1:${MCP_PORT}` || host === `localhost:${MCP_PORT}`;

function startMcpProxy() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  // The one shared token an earlier version kept: agents sign in now, so it opens nothing and goes.
  rmSync(path.join(app.getPath('userData'), 'mcp-token'), { force: true });
  mcpAuth = new LocalOAuth({ file: path.join(app.getPath('userData'), 'mcp-auth.json'), issuer: MCP_URL, approve: approveAgent });
  const proxy = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (!ownHost(req.headers.host)) return void res.writeHead(421).end();
    if (mcpAuth.handles(pathname)) {
      mcpAuth.handle(req, res).catch(() => !res.headersSent && res.writeHead(500).end());
      return;
    }
    // Only the MCP endpoint and the plugin's upload and file links; the app itself is not served here.
    const mcp = pathname === '/mcp' || pathname.startsWith('/mcp/');
    if (!(mcp || pathname.startsWith('/plugin/'))) return void res.writeHead(404).end();
    const headers = { ...req.headers };
    if (mcp) {
      if (!mcpAuth.verify(req.headers.authorization)) {
        // The agent learns where to sign in from this (RFC 9728), and opens the sign-in page.
        return void res
          .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${mcpAuth.resourceMetadataUrl}"` })
          .end(JSON.stringify({ error: 'unauthorized', error_description: 'Sign in: the app asks you to allow this agent.' }));
      }
      headers.authorization = `Bearer ${MCP_SECRET}`;
    }
    if (!current) return void res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The app is opening a folder. Try again in a moment.' }));
    const up = http.request({ host: '127.0.0.1', port: current.port, method: req.method, path: req.url, headers }, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The app’s server is not answering.' }));
      else res.end();
    });
    req.pipe(up);
  });
  proxy.on('error', (e) => {
    mcpListening = false;
    console.error(`MCP server not started on ${MCP_URL}: ${e.message}`);
  });
  proxy.listen(MCP_PORT, '127.0.0.1', () => {
    mcpListening = true;
  });
}

/**
 * Make the app the one in front. macOS (14 and later) no longer lets an app take the front on its own
 * (app.focus's steal is ignored), but it does when asked to open the app: for one already running, Launch
 * Services brings it forward rather than starting another.
 */
function bringToFront() {
  if (process.platform !== 'darwin') return app.focus();
  // .../Universal Docs.app/Contents/MacOS/Universal Docs (or Electron.app in development).
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) return app.focus({ steal: true });
  execFile('open', ['-a', bundle], (e) => e && app.focus({ steal: true }));
}

/**
 * Put a page of the app (a file the model opened, created or imported) in the window, and bring the app to
 * the front so the person sees it. Edits to the file already showing do not come here.
 */
function showPage(page) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return current && createWindow(`${current.origin}${page}`);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  bringToFront();
  // The client's router goes there (main.tsx), as a link in the app would.
  void win.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('universal-show', { detail: ${JSON.stringify(page)} }))`).catch(() => {});
}

/** An agent rewrote a stored file: a window showing it loads it again (FilePage listens for this, as for the app's own assistant). */
function fileChanged(id) {
  for (const win of BrowserWindow.getAllWindows()) {
    void win.webContents.executeJavaScript(`dispatchEvent(new CustomEvent('stored-file-changed', { detail: ${JSON.stringify(id)} }))`).catch(() => {});
  }
}

async function connectAgent() {
  const command = `claude mcp add --scope user --transport http universal-local ${MCP_URL}/mcp`;
  const agents = mcpAuth?.clients() ?? [];
  const connected = agents.length ? `Connected now: ${agents.map((a) => a.name).join(', ')}.` : 'No agent is connected yet.';
  const res = await dialog.showMessageBox({
    type: 'info',
    title: 'Connect an Agent',
    message: mcpListening ? 'Agents on this computer can read and edit the open folder’s files, and the app shows what they open.' : `The MCP server is not running: port ${MCP_PORT} is in use, probably by another copy of the app.`,
    detail: `MCP server (Universal Local): ${MCP_URL}/mcp\n\nTo add it to Claude Code, run the command below, then /mcp in Claude Code to sign in. The app asks you to allow each agent that connects.\n\n${command}\n\n${connected}`,
    buttons: agents.length ? ['Copy Command', 'Disconnect All Agents', 'Close'] : ['Copy Command', 'Close'],
    defaultId: 0,
    cancelId: agents.length ? 2 : 1,
  });
  if (res.response === 0) clipboard.writeText(command);
  if (agents.length && res.response === 1) mcpAuth.revokeAll();
}

// --- The assistant's API keys ------------------------------------------------------------------------------
// The app has no model of its own: the assistant runs on the user's Anthropic, OpenAI or OpenRouter key. On
// the first run a key already set where the user works is used (the server keeps it once it has settings,
// server/agent/settings.ts). Started from Finder or the Dock, the app does not get the login shell's
// environment, so it is read from the shell, once.
const KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
const keysCheckedFile = () => path.join(app.getPath('userData'), 'assistant-keys-checked');
let shellKeys = {};

/** The keys set in the user's login shell (or already in this process's environment), by name. */
function readShellKeys() {
  const found = Object.fromEntries(KEY_NAMES.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  if (process.platform === 'win32') return Promise.resolve(found);
  return new Promise((resolve) => {
    // An interactive login shell reads the same files a terminal does (.zprofile, .zshrc, ...).
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'env'], { timeout: 5000, maxBuffer: 1 << 20 }, (_e, out) => {
      for (const line of String(out ?? '').split('\n')) {
        const m = /^([A-Z_]+)=(\S+)$/.exec(line);
        if (m && KEY_NAMES.includes(m[1]) && !found[m[1]]) found[m[1]] = m[2];
      }
      resolve(found);
    });
  });
}

/** Start a server for the folder; resolves to its origin once it is listening. */
function startServer(dir) {
  const token = randomBytes(32).toString('base64url');
  // What the app keeps for a folder (chat history, settings, pasted images, deleted files) lives with the
  // app's own data, not in the folder.
  const dataDir = path.join(app.getPath('userData'), 'folders', createHash('sha256').update(dir).digest('hex').slice(0, 16));
  // Electron runs as plain Node in a forked child. The working directory is the app's, where .env is.
  const child = fork(path.join(root, 'desktop', 'server.ts'), [], {
    cwd: root,
    env: { ...process.env, ...shellKeys, LOCAL_DIR: dir, DATA_DIR: dataDir, APP_DATA_DIR: app.getPath('userData'), LOCAL_TOKEN: token, PORT: '0', MCP_TOKEN: MCP_SECRET, MCP_URL },
  });
  return new Promise((resolve, reject) => {
    child.once('message', (msg) => resolve({ child, dir, token, port: msg.port, origin: `http://127.0.0.1:${msg.port}` }));
    // Later the server asks for a file outside its folder to be shown (one of Recents), or a page (a file an agent opened).
    child.on('message', (msg) => {
      if (msg && typeof msg.openFile === 'string') void openFile(msg.openFile).catch((e) => dialog.showErrorBox('Universal Docs', String(e.message ?? e)));
      if (msg && typeof msg.show === 'string' && msg.show.startsWith('/')) showPage(msg.show);
      if (msg && typeof msg.fileChanged === 'string') fileChanged(msg.fileChanged);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`The server stopped while starting (exit code ${code}).`)));
  });
}

function stopServer() {
  if (!current) return;
  current.child.removeAllListeners('exit');
  current.child.kill('SIGTERM');
  current = null;
}

const TABS = 'freeflow';

function createWindow(url) {
  // On macOS the app's windows share one tab group.
  const win = new BrowserWindow({ width: 1400, height: 900, title: 'Universal Docs', tabbingIdentifier: TABS });
  void win.loadURL(url);
  return win;
}

// "Open in a new tab" (window.open) opens another window of the app, as a tab of the window it came from
// where the system has window tabs (macOS); links to anywhere else go to the browser.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url: target }) => {
    if (current && target.startsWith(`${current.origin}/`)) return { action: 'allow', overrideBrowserWindowOptions: { width: 1400, height: 900, tabbingIdentifier: TABS } };
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => {
    const opener = BrowserWindow.fromWebContents(contents);
    if (process.platform === 'darwin' && opener) opener.addTabbedWindow(child);
  });
});

/** Serve `dir` and show it, replacing the folder that was open. `landing` is the page the window starts on. */
async function openFolder(dir, landing = '/') {
  const windows = BrowserWindow.getAllWindows();
  stopServer();
  current = await startServer(dir);
  rememberFolder(dir);
  current.child.once('exit', () => {
    dialog.showErrorBox('Universal Docs', 'The local server stopped unexpectedly. The app will close.');
    app.quit();
  });
  // Only this app's windows hold the token, so nothing else on the machine can use the server.
  await session.defaultSession.cookies.set({ url: current.origin, name: 'local', value: current.token, httpOnly: true, sameSite: 'strict' });
  createWindow(`${current.origin}${landing}`);
  for (const w of windows) w.destroy();
}

/**
 * Show a file that is not in the open folder: its own folder becomes the open one, and the window starts on
 * the file. One of Recents (`fromRecents`) keeps Recents as the list its breadcrumbs lead back to.
 */
async function openFile(file, fromRecents = true) {
  if (!isDir(path.dirname(file))) throw new Error(`"${file}" is no longer there.`);
  await openFolder(path.dirname(file), `/open?file=${encodeURIComponent(path.basename(file))}${fromRecents ? '&from=recents' : ''}`);
}

/** Show a file the system asked the app to open (Finder): in the open folder when it is there, else in its own. */
async function showFile(file) {
  const rel = current ? path.relative(current.dir, file) : '';
  const parts = rel.split(path.sep);
  // The open folder's server lists no hidden files or folders, so a file among them opens in its own folder.
  if (rel && !path.isAbsolute(rel) && !parts.some((p) => p === '..' || p.startsWith('.'))) showPage(`/open?file=${encodeURIComponent(parts.join('/'))}`);
  else await openFile(file, false);
}

// Finder asks for a file (a double-click when the app is the file's default, Open With, a file dropped on the
// Dock icon) with open-file, which comes before the app is ready when that is what started it.
let launchFile = null;
let started = false;
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (!started) launchFile = file;
  else void showFile(file).catch((err) => dialog.showErrorBox('Universal Docs', String(err.message ?? err)));
});

// --- Default app (macOS) ----------------------------------------------------------------------------------
// The app owns its own formats, but for the standard ones the system prefers Apple's apps whatever the app
// declares, so becoming their default is the person's choice, set as Get Info › Change All… would set it.
const DEFAULT_TYPES = [
  'org.openxmlformats.wordprocessingml.document',
  'org.openxmlformats.spreadsheetml.sheet',
  'com.microsoft.excel.xls',
  'org.openxmlformats.presentationml.presentation',
  'com.adobe.pdf',
  'public.comma-separated-values-text',
  'net.daringfireball.markdown',
];
const canBeDefault = () => process.platform === 'darwin' && app.isPackaged;
const defaultAskedFile = () => path.join(app.getPath('userData'), 'default-app-asked');

/**
 * Make the app (its bundle id is `build.appId` in package.json) the default for DEFAULT_TYPES, with
 * LSSetDefaultRoleHandlerForContentType through JavaScript for Automation. Each call answers 0 when it worked.
 */
function setDefaultApp() {
  const script = `ObjC.import('CoreServices');
ObjC.bindFunction('LSSetDefaultRoleHandlerForContentType', ['int', ['id', 'unsigned int', 'id']]);
${JSON.stringify(DEFAULT_TYPES)}.map((t) => $.LSSetDefaultRoleHandlerForContentType($(t), 0xFFFFFFFF, $('im.freeflow.docs'))).join(',')`;
  return new Promise((resolve, reject) =>
    execFile('osascript', ['-l', 'JavaScript', '-e', script], (e, out) => {
      if (e) return reject(e);
      const failed = out.trim().split(',').filter((code) => code !== '0').length;
      if (failed) reject(new Error(`${failed} of the ${DEFAULT_TYPES.length} file types could not be changed.`));
      else resolve();
    }),
  );
}

/** Ask, then make the app the default. `first` is the one offer at the first start, which can be declined for good. */
async function offerDefaultApp(first = false) {
  const res = await dialog.showMessageBox({
    type: 'question',
    title: 'Default App',
    message: 'Open Word, Excel, PowerPoint, PDF, CSV and Markdown files in Universal Docs?',
    detail: 'Double-clicking one of these files in Finder will open it here. You can change it back for a type with Get Info › Open with › Change All… in Finder.',
    buttons: [first ? 'Use Universal Docs' : 'Make Default', first ? 'Not Now' : 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (first) {
    try {
      writeFileSync(defaultAskedFile(), '');
    } catch {
      // Asked again next time, that's all.
    }
  }
  if (res.response !== 0) return;
  try {
    await setDefaultApp();
  } catch (e) {
    dialog.showErrorBox('Universal Docs', `The app could not be made the default: ${e.message ?? e}`);
  }
}

async function chooseFolder() {
  const res = await dialog.showOpenDialog({ title: 'Open folder', properties: ['openDirectory', 'createDirectory'], defaultPath: current?.dir ?? app.getPath('documents') });
  if (res.canceled || !res.filePaths[0]) return false;
  await openFolder(res.filePaths[0]);
  return true;
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac
        ? [
            {
              role: 'appMenu',
              submenu: [
                { role: 'about' },
                ...(canBeDefault() ? [{ type: 'separator' }, { label: 'Make Default App…', click: () => void offerDefaultApp() }] : []),
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void chooseFolder().catch((e) => dialog.showErrorBox('Universal Docs', String(e.message ?? e))) },
          { label: mac ? 'Show Folder in Finder' : 'Show Folder', click: () => current && void shell.openPath(current.dir) },
          { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => current && createWindow(`${current.origin}/`) },
          { type: 'separator' },
          { label: 'Connect an Agent (MCP)…', click: () => void connectAgent() },
          { type: 'separator' },
          mac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

app.whenReady().then(async () => {
  buildMenu();
  startMcpProxy();
  if (!existsSync(path.join(root, 'dist', 'client', 'index.html'))) {
    dialog.showErrorBox('Universal Docs', 'The app has not been built yet. Run "npm run build" in the project, then start it again.');
    return app.quit();
  }
  if (!existsSync(keysCheckedFile())) {
    shellKeys = await readShellKeys();
    try {
      writeFileSync(keysCheckedFile(), '');
    } catch {
      // Looked for again next time, that's all.
    }
  }
  // electron [flags] desktop/main.js [folder]: the folder is the argument that is neither a flag nor this script.
  const arg = process.argv.slice(1).find((a) => !a.startsWith('-') && path.resolve(a) !== import.meta.filename);
  try {
    if (launchFile) {
      await openFile(launchFile, false);
      return;
    }
    if (!arg && app.isPackaged) {
      const last = lastFolder();
      if (last) await openFolder(last);
      else if (!(await chooseFolder())) app.quit();
      return;
    }
    const dir = path.resolve(arg ?? process.cwd());
    if (isDir(dir)) await openFolder(dir);
    else {
      dialog.showErrorBox('Universal Docs', `"${dir}" is not a folder. Choose a folder to open.`);
      if (!(await chooseFolder())) app.quit();
    }
  } catch (e) {
    dialog.showErrorBox('Universal Docs', `The app could not start: ${e.message ?? e}`);
    app.quit();
  } finally {
    started = true;
    // The installed app offers once to open the standard formats too.
    if (current && canBeDefault() && !existsSync(defaultAskedFile())) void offerDefaultApp(true);
  }
});

app.on('activate', () => {
  if (current && BrowserWindow.getAllWindows().length === 0) createWindow(`${current.origin}/`);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', stopServer);
