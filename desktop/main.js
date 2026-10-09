// The desktop app (Electron). It opens a folder as the library: the folder given on the command line, or
// the directory the app was started in. The app itself is the web app, served to this window by a local
// server (desktop/server.ts) that reads and writes the folder's files.
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// Also names the app's data directory, which would otherwise be the generic "Electron" one.
app.setName('FreeFlow Docs');
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

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

/** Start a server for the folder; resolves to its origin once it is listening. */
function startServer(dir) {
  const token = randomBytes(32).toString('base64url');
  // What the app keeps for a folder (chat history, settings, pasted images, deleted files) lives with the
  // app's own data, not in the folder.
  const dataDir = path.join(app.getPath('userData'), 'folders', createHash('sha256').update(dir).digest('hex').slice(0, 16));
  // Electron runs as plain Node in a forked child. The working directory is the app's, where .env is.
  const child = fork(path.join(root, 'desktop', 'server.ts'), [], {
    cwd: root,
    env: { ...process.env, LOCAL_DIR: dir, DATA_DIR: dataDir, LOCAL_TOKEN: token, PORT: '0' },
  });
  return new Promise((resolve, reject) => {
    child.once('message', (msg) => resolve({ child, dir, token, origin: `http://127.0.0.1:${msg.port}` }));
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
  const win = new BrowserWindow({ width: 1400, height: 900, title: 'FreeFlow Docs', tabbingIdentifier: TABS });
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

/** Serve `dir` and show it, replacing the folder that was open. */
async function openFolder(dir) {
  const windows = BrowserWindow.getAllWindows();
  stopServer();
  current = await startServer(dir);
  rememberFolder(dir);
  current.child.once('exit', () => {
    dialog.showErrorBox('FreeFlow Docs', 'The local server stopped unexpectedly. The app will close.');
    app.quit();
  });
  // Only this app's windows hold the token, so nothing else on the machine can use the server.
  await session.defaultSession.cookies.set({ url: current.origin, name: 'local', value: current.token, httpOnly: true, sameSite: 'strict' });
  createWindow(`${current.origin}/`);
  for (const w of windows) w.destroy();
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
      ...(mac ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void chooseFolder().catch((e) => dialog.showErrorBox('FreeFlow Docs', String(e.message ?? e))) },
          { label: mac ? 'Show Folder in Finder' : 'Show Folder', click: () => current && void shell.openPath(current.dir) },
          { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => current && createWindow(`${current.origin}/`) },
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
  if (!existsSync(path.join(root, 'dist', 'client', 'index.html'))) {
    dialog.showErrorBox('FreeFlow Docs', 'The app has not been built yet. Run "npm run build" in the project, then start it again.');
    return app.quit();
  }
  // electron [flags] desktop/main.js [folder]: the folder is the argument that is neither a flag nor this script.
  const arg = process.argv.slice(1).find((a) => !a.startsWith('-') && path.resolve(a) !== import.meta.filename);
  try {
    if (!arg && app.isPackaged) {
      const last = lastFolder();
      if (last) await openFolder(last);
      else if (!(await chooseFolder())) app.quit();
      return;
    }
    const dir = path.resolve(arg ?? process.cwd());
    if (isDir(dir)) await openFolder(dir);
    else {
      dialog.showErrorBox('FreeFlow Docs', `"${dir}" is not a folder. Choose a folder to open.`);
      if (!(await chooseFolder())) app.quit();
    }
  } catch (e) {
    dialog.showErrorBox('FreeFlow Docs', `The app could not start: ${e.message ?? e}`);
    app.quit();
  }
});

app.on('activate', () => {
  if (current && BrowserWindow.getAllWindows().length === 0) createWindow(`${current.origin}/`);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('quit', stopServer);
