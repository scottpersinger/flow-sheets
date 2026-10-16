#!/usr/bin/env node
// `npx @scottpersinger/mcp-docs`: install (or update) the MCP Docs desktop app from the latest GitHub release, then the
// Claude Code plugin that connects Claude Code to it (the claude-plugin folder of the same repository,
// whose marketplace is .claude-plugin/marketplace.json there). With --uninstall, remove all of it again: the
// app, its data and settings, and what it added to Claude Code.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
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
  console.log(`Usage: npx @scottpersinger/mcp-docs [--skip-app] [--skip-plugin]
       npx @scottpersinger/mcp-docs --uninstall [--yes]

Installs the latest MCP Docs desktop app into /Applications (or ~/Applications), and the mcp-docs
plugin into Claude Code, which connects Claude Code to the app. Run it again to update both.

  --skip-app      only install or update the Claude Code plugin
  --skip-plugin   only install or update the app
  --uninstall     remove the app, its data and settings (chats, API keys, connected agents), and the
                  mcp-docs plugin, marketplace and MCP server from Claude Code. Your documents, in the
                  folders you opened, are not touched. It lists what it will remove and asks first.
  --yes           with --uninstall, do not ask`);
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

/** Quit the running app (it saves as it goes) so it can be replaced or removed; waits up to 15 seconds. */
async function quitApp(app, why = 'to update it') {
  if (!appPids(app).length) return false;
  say(`  Quitting ${APP_NAME} ${why}…`);
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
    say('  Claude Code was not found (the `claude` command). Install it, then run `npx @scottpersinger/mcp-docs --skip-app`.');
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

// --- Uninstall ------------------------------------------------------------------------------------------

/**
 * Where the app keeps its own things: its data folder (chats, settings with the API keys, connected agents'
 * tokens, each folder's index, deleted files), under each name it has had, and macOS's files for it.
 */
function appData() {
  const lib = path.join(homedir(), 'Library');
  const BUNDLE_ID = 'im.freeflow.docs';
  return [
    ...['MCP Docs', 'Universal Docs', 'FreeFlow Docs'].map((name) => path.join(lib, 'Application Support', name)),
    path.join(lib, 'Preferences', `${BUNDLE_ID}.plist`),
    path.join(lib, 'Saved Application State', `${BUNDLE_ID}.savedState`),
    path.join(lib, 'Caches', BUNDLE_ID),
    path.join(lib, 'HTTPStorages', BUNDLE_ID),
    path.join(lib, 'Logs', APP_NAME),
  ].filter((p) => existsSync(p));
}

/** The apps installed, in either place. */
const installedApps = () => ['/Applications', path.join(homedir(), 'Applications')].map((dir) => path.join(dir, `${APP_NAME}.app`)).filter((p) => existsSync(p));

/** What it added to Claude Code: the plugin, its marketplace, and an MCP server added by hand (by either name it has had). */
function claudeThings() {
  if (run('claude', ['--version']).status !== 0) return { plugin: false, marketplace: false, servers: [] };
  let plugin = false;
  let marketplace = false;
  try {
    plugin = JSON.parse(claude(['plugin', 'list', '--json']).out).some((p) => p.id === PLUGIN);
  } catch {
    // An older Claude Code: tried below anyway.
    plugin = true;
  }
  try {
    marketplace = JSON.parse(claude(['plugin', 'marketplace', 'list', '--json']).out).some((m) => m.name === MARKETPLACE);
  } catch {
    marketplace = true;
  }
  const servers = ['mcp-docs', 'universal-local'].filter((name) => claude(['mcp', 'get', name]).ok);
  return { plugin, marketplace, servers };
}

async function uninstall() {
  const apps = installedApps();
  const data = appData();
  const fromClaude = claudeThings();
  const lines = [
    ...apps.map((a) => `  the app: ${a}`),
    ...data.map((d) => `  its data: ${d.replace(homedir(), '~')}`),
    ...(fromClaude.plugin ? [`  the ${PLUGIN} plugin in Claude Code`] : []),
    ...(fromClaude.marketplace ? [`  the ${MARKETPLACE} plugin marketplace in Claude Code`] : []),
    ...fromClaude.servers.map((s) => `  the ${s} MCP server in Claude Code`),
  ];
  if (!lines.length) {
    say(`\nThere is nothing of ${APP_NAME} to remove.`);
    return;
  }
  say(`\nThis removes:\n${lines.join('\n')}\n\nThe data holds your assistant chats, settings (API keys too) and connected agents. Your documents, in the folders you opened, are not touched.`);
  if (!flag('yes')) {
    if (!process.stdin.isTTY) fail('Run it with --yes to remove these without being asked.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('\nRemove them? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      say('Nothing was removed.');
      return;
    }
  }

  for (const app of apps) {
    await quitApp(app, 'to remove it');
    rmSync(app, { recursive: true, force: true });
    say(`  Removed ${app}`);
  }
  for (const d of data) {
    rmSync(d, { recursive: true, force: true });
    say(`  Removed ${d.replace(homedir(), '~')}`);
  }
  if (fromClaude.plugin) {
    const r = claude(['plugin', 'uninstall', PLUGIN]);
    say(r.ok ? `  Uninstalled the ${PLUGIN} plugin` : `  Could not uninstall the ${PLUGIN} plugin: ${r.out}`);
  }
  if (fromClaude.marketplace) {
    const r = claude(['plugin', 'marketplace', 'remove', MARKETPLACE]);
    say(r.ok ? `  Removed the ${MARKETPLACE} marketplace` : `  Could not remove the ${MARKETPLACE} marketplace: ${r.out}`);
  }
  for (const s of fromClaude.servers) {
    // Added for the user (File › Connect an Agent's command), or for one project.
    const r = claude(['mcp', 'remove', s, '--scope', 'user']).ok ? { ok: true } : claude(['mcp', 'remove', s]);
    say(r.ok ? `  Removed the ${s} MCP server` : `  Could not remove the ${s} MCP server: ${r.out}`);
  }
  say(`\n${APP_NAME} is uninstalled. Restart Claude Code to let go of the plugin.`);
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  fail(`${APP_NAME} is only available for Macs with Apple silicon so far.`);
}

if (flag('uninstall')) {
  say(`MCP Docs uninstaller (${REPO})`);
  await uninstall();
  process.exit(0);
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
