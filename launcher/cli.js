#!/usr/bin/env node
// `universal-docs`: the self-improving install of the Universal Docs desktop app. The app runs from a git
// checkout of its source (by default ~/.universal-docs/app) so its assistant can change the app's own code;
// those changes are commits on the checkout's `my-changes` branch. This package only manages the checkout:
//
//   universal-docs [folder]   open the app on a folder (the current directory by default); installs it first
//   universal-docs update     move your changes onto the newest release, then install and build again
//   universal-docs where      print where the app's source is
//
// UNIVERSAL_DOCS_HOME sets the checkout's place and UNIVERSAL_DOCS_REPO the repository it is cloned from.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const REPO = process.env.UNIVERSAL_DOCS_REPO || 'https://github.com/scottpersinger/universal-docs.git';
const HOME = path.resolve(process.env.UNIVERSAL_DOCS_HOME || path.join(homedir(), '.universal-docs', 'app'));
const BRANCH = 'my-changes';
const TAGS = 'desktop-v*';
const MIN_NODE = 24;

function fail(message) {
  console.error(`universal-docs: ${message}`);
  process.exit(1);
}

/** Run a command, showing its output unless quiet; returns false when it failed, else its output ('' when shown). */
function run(cmd, args, { cwd = HOME, quiet = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'npm' });
  return res.status === 0 ? (res.stdout ?? '').trim() : false;
}

function must(cmd, args, opts) {
  const out = run(cmd, args, opts);
  if (out === false) fail(`${cmd} ${args.join(' ')} failed.`);
  return out;
}

function checkTools() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE) fail(`Node ${MIN_NODE} or later is needed (this is ${process.versions.node}).`);
  if (run('git', ['--version'], { cwd: process.cwd(), quiet: true }) === false) fail('git is needed: install it, then run this again.');
}

/** The newest release tag on the remote, e.g. desktop-v0.2.3. */
function latestRelease() {
  must('git', ['fetch', '--quiet', '--tags', 'origin']);
  const tags = must('git', ['tag', '--list', TAGS, '--sort=-v:refname'], { quiet: true }).split('\n').filter(Boolean);
  if (!tags.length) fail(`No release (${TAGS} tag) found in ${REPO}.`);
  return tags[0];
}

function build() {
  console.log('Installing dependencies…');
  must('npm', ['install', '--no-audit', '--no-fund']);
  console.log('Building the app…');
  must('npm', ['run', 'build']);
}

function install() {
  console.log(`Installing Universal Docs in ${HOME}…`);
  must('git', ['clone', '--quiet', REPO, HOME], { cwd: process.cwd() });
  const release = latestRelease();
  // Your changes (and the assistant's) live on this branch, started from the release.
  must('git', ['checkout', '--quiet', '-b', BRANCH, release]);
  console.log(`Checked out ${release} on the branch ${BRANCH}.`);
  build();
}

function update() {
  if (!existsSync(path.join(HOME, '.git'))) return install();
  const branch = must('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true });
  if (branch !== BRANCH) fail(`The app's source (${HOME}) is on "${branch}", not ${BRANCH}. Switch back to ${BRANCH} and run this again.`);
  if (must('git', ['status', '--porcelain'], { quiet: true })) fail(`The app's source (${HOME}) has uncommitted changes. Commit or discard them, then run this again.`);
  const release = latestRelease();
  console.log(`Moving your changes onto ${release}…`);
  if (run('git', ['rebase', '--quiet', release]) === false) {
    run('git', ['rebase', '--abort'], { quiet: true });
    fail(`Your changes conflict with ${release}, so nothing was changed. Resolve it in ${HOME} (git rebase ${release}), then run universal-docs again.`);
  }
  build();
  console.log(`Universal Docs is up to date (${release}, with your changes).`);
}

function open(folder) {
  if (!existsSync(path.join(HOME, '.git'))) install();
  else if (!existsSync(path.join(HOME, 'dist', 'client', 'index.html'))) build();
  const res = spawnSync(process.execPath, [path.join(HOME, 'desktop', 'cli.js'), path.resolve(folder ?? process.cwd())], { cwd: HOME, stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

const [command, arg] = process.argv.slice(2);
checkTools();
if (command === 'update') update();
else if (command === 'where') console.log(HOME);
else if (command === '--help' || command === '-h' || command === 'help') {
  console.log(`universal-docs [folder]   open the app on a folder (the current directory by default)
universal-docs update     move your changes onto the newest release, then rebuild
universal-docs where      print where the app's source is (${HOME})`);
} else open(command === 'open' ? arg : command);
