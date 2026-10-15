#!/usr/bin/env node
// `npx mcp-docs`: install (or update) the MCP Docs desktop app from the latest GitHub release, then the
// Claude Code plugin that connects Claude Code to it (the claude-plugin folder of the same repository,
// whose marketplace is .claude-plugin/marketplace.json there).
import { spawnSync } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = 'scottpersinger/universal-docs';
const APP_NAME = 'MCP Docs';
const ASSET = /^MCP-Docs-(\d+\.\d+\.\d+)-mac-arm64\.zip$/;
const MARKETPLACE = 'mcp-docs';
const PLUGIN = `mcp-docs@${MARKETPLACE}`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

if (flag('help') || flag('h') || args.some((a) => !a.startsWith('--'))) {
  console.log(`Usage: npx mcp-docs [--skip-app] [--skip-plugin]

Installs the latest MCP Docs desktop app into /Applications (or ~/Applications), and the mcp-docs
plugin into Claude Code, which connects Claude Code to the app. Run it again to update both.

  --skip-app      only install or update the Claude Code plugin
  --skip-plugin   only install or update the app`);
  process.exit(args.some((a) => !a.startsWith('--')) ? 1 : 0);
}

const say = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
/** Run a program; its output is returned, not shown. */
const run = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8' });

/** Where the app goes: /Applications when it can be written to, else the person's own Applications folder. */
function appsDir() {
  try {
    accessSync('/Applications', constants.W_OK);
    return '/Applications';
  } catch {
    const own = path.join(homedir(), 'Applications');
    mkdirSync(own, { recursive: true });
    return own;
  }
}

/** The app already installed, in either place, and its version. */
function installedApp() {
  for (const dir of ['/Applications', path.join(homedir(), 'Applications')]) {
    const app = path.join(dir, `${APP_NAME}.app`);
    if (!existsSync(app)) continue;
    const r = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
    return { app, version: r.status === 0 ? r.stdout.trim() : null };
  }
  return null;
}

/** The newest release of the desktop app: its version and the download of its zip. */
async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'mcp-docs-installer' } });
  if (!res.ok) fail(`Could not look up the latest release on GitHub (${res.status} ${res.statusText}).`);
  for (const release of await res.json()) {
    if (release.draft || release.prerelease) continue;
    for (const asset of release.assets ?? []) {
      const m = ASSET.exec(asset.name);
      if (m) return { version: m[1], url: asset.browser_download_url, name: asset.name, size: asset.size };
    }
  }
  fail(`No release of ${APP_NAME} for macOS was found on GitHub.`);
}

const appPids = (app) => {
  const r = run('pgrep', ['-f', `${app}/Contents/MacOS/`]);
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
};

/** Quit the running app (it saves as it goes) so it can be replaced; waits up to 15 seconds. */
async function quitApp(app) {
  if (!appPids(app).length) return false;
  say(`  Quitting ${APP_NAME} to update it…`);
  run('osascript', ['-e', `tell application "${app}" to quit`]);
  for (let i = 0; i < 30 && appPids(app).length; i++) await new Promise((r) => setTimeout(r, 500));
  if (appPids(app).length) fail(`${APP_NAME} is still running. Quit it and run this again.`);
  return true;
}

async function installApp() {
  say(`\n${APP_NAME} app`);
  const latest = await latestRelease();
  const current = installedApp();
  if (current?.version === latest.version) {
    say(`  ${APP_NAME} ${latest.version} is installed (${current.app}).`);
    return current.app;
  }
  say(current ? `  Updating ${current.version ?? 'an older version'} to ${latest.version}…` : `  Installing ${APP_NAME} ${latest.version}…`);
  const work = mkdtempSync(path.join(tmpdir(), 'mcp-docs-'));
  try {
    const zip = path.join(work, latest.name);
    say(`  Downloading ${latest.name} (${Math.round(latest.size / 1e6)} MB)…`);
    const res = await fetch(latest.url);
    if (!res.ok || !res.body) fail(`The download failed (${res.status} ${res.statusText}).`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    const out = path.join(work, 'app');
    if (run('ditto', ['-x', '-k', zip, out]).status !== 0) fail('The download could not be unpacked.');
    const unpacked = path.join(out, `${APP_NAME}.app`);
    if (!existsSync(unpacked)) fail(`The download does not hold ${APP_NAME}.app.`);

    const app = current?.app ?? path.join(appsDir(), `${APP_NAME}.app`);
    const wasRunning = current ? await quitApp(app) : false;
    rmSync(app, { recursive: true, force: true });
    const copied = run('ditto', [unpacked, app]);
    if (copied.status !== 0) fail(`Could not put the app in ${path.dirname(app)}: ${copied.stderr.trim()}`);
    // Not notarized: without the quarantine mark macOS opens it without asking (a download made by this
    // script has none, but one copied over from a browser's download might).
    run('xattr', ['-dr', 'com.apple.quarantine', app]);
    say(`  Installed ${APP_NAME} ${latest.version} in ${path.dirname(app)}.`);
    if (wasRunning) say('  It was running: it starts again below.');
    return app;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Run `claude` with these arguments, showing what it says when it fails. */
function claude(argv) {
  const r = run('claude', argv);
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function installPlugin() {
  say('\nClaude Code plugin');
  if (run('claude', ['--version']).status !== 0) {
    say('  Claude Code was not found (the `claude` command). Install it, then run `npx mcp-docs --skip-app`.');
    return false;
  }
  const listed = claude(['plugin', 'marketplace', 'list', '--json']);
  let known = false;
  try {
    known = JSON.parse(listed.out).some((m) => m.name === MARKETPLACE);
  } catch {
    // Not JSON (an older Claude Code): add it, which says so if it is there already.
  }
  if (known) {
    const up = claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
    if (!up.ok) say(`  Could not refresh the ${MARKETPLACE} marketplace: ${up.out}`);
  } else {
    // Only the plugin's folders are checked out, not the whole app.
    const add = claude(['plugin', 'marketplace', 'add', REPO, '--sparse', '.claude-plugin', 'claude-plugin']);
    if (!add.ok && !/already/i.test(add.out)) fail(`Could not add the ${MARKETPLACE} marketplace to Claude Code:\n${add.out}`);
  }

  const plugins = claude(['plugin', 'list', '--json']);
  let installed = false;
  try {
    installed = JSON.parse(plugins.out).some((p) => p.id === PLUGIN || `${p.name}@${p.marketplace}` === PLUGIN);
  } catch {
    installed = plugins.out.includes(PLUGIN);
  }
  const step = installed ? claude(['plugin', 'update', PLUGIN]) : claude(['plugin', 'install', PLUGIN]);
  if (!step.ok) fail(`Could not ${installed ? 'update' : 'install'} the ${PLUGIN} plugin:\n${step.out}`);
  say(`  ${installed ? 'Updated' : 'Installed'} the ${PLUGIN} plugin.`);

  // A server added by hand earlier (File › Connect an Agent's command) would be a second copy of the plugin's.
  if (claude(['mcp', 'get', 'mcp-docs']).ok) {
    say('  You also added the mcp-docs server by hand before. The plugin has its own now; remove that one with:');
    say('    claude mcp remove mcp-docs --scope user');
  }
  return true;
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail(`${APP_NAME} is only available for Macs with Apple silicon so far.`);
}

say(`MCP Docs installer (${REPO})`);
const app = flag('skip-app') ? installedApp()?.app : await installApp();
const plugin = flag('skip-plugin') ? false : installPlugin();

if (app && !appPids(app).length) {
  // The MCP server is the running app.
  run('open', ['-a', app]);
  say(`\nStarted ${APP_NAME}.`);
}
if (plugin) {
  say(`
Next, in Claude Code:
  1. Restart Claude Code (or start a new session) to load the plugin.
  2. Run /mcp, choose plugin:mcp-docs:mcp-docs, and sign in. ${APP_NAME} asks you to allow it.
${APP_NAME} must be running for Claude Code to reach it.`);
}
