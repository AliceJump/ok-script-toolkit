'use strict';

// Real Git/PowerShell integration against temporary local bare remotes only.
// Run with: node scripts/test_release.js (requires git, node and pwsh).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sourceRoot = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-release test '));
const gitConfig = path.join(sandbox, 'gitconfig');
fs.writeFileSync(gitConfig, '');
// Do not inherit Git paths/config injection or let the verifier write CI outputs.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' });
for (const key of ['GITHUB_OUTPUT', 'GITHUB_REF_TYPE', 'GITHUB_REF_NAME']) delete env[key];
const releaseFiles = ['scripts/release.ps1', 'scripts/release/sync-version.js', 'scripts/release/verify-version.js'];

function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60000 });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, expected, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const git = (cwd, ...args) => run('git', args, cwd);
function write(root, name, text) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function configure(root) {
  git(root, 'config', 'user.name', 'Release integration test');
  git(root, 'config', 'user.email', 'release-test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'tag.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
}
function fixture(name) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir);
  const parentRemote = path.join(dir, 'parent.git');
  const childRemote = path.join(dir, 'child.git');
  git(dir, 'init', '--bare', parentRemote);
  git(dir, 'init', '--bare', childRemote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-b', 'main', seed);
  configure(seed);
  write(seed, 'gradle.properties', 'pluginVersion=1.18.0\n');
  const badge = '[Version](https://img.shields.io/badge/version-1.18.0-blue)\n';
  for (const file of ['README.md', 'README.en.md']) write(seed, file, badge);
  write(seed, 'mixed.txt', 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'initial child');
  git(seed, 'remote', 'add', 'origin', childRemote);
  git(seed, 'push', 'origin', 'main');

  const root = path.join(dir, 'project with spaces');
  git(dir, 'init', '-b', 'main', root);
  configure(root);
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', 'main', childRemote, 'jetbrains');
  const child = path.join(root, 'jetbrains');
  configure(child);
  write(root, 'package.json', JSON.stringify({ name: 'ok-script-toolkit', version: '1.18.0' }, null, 2) + '\n');
  write(root, 'package-lock.json', JSON.stringify({ version: '1.18.0', packages: { '': { version: '1.18.0' } } }, null, 2) + '\n');
  for (const file of ['README.md', 'README.en.md']) write(root, file, badge);
  write(root, 'mixed.txt', 'base\n');
  write(root, '.gitignore', 'ignored.txt\n');
  for (const file of releaseFiles) write(root, file, fs.readFileSync(path.join(sourceRoot, file)));
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'initial parent');
  git(root, 'remote', 'add', 'origin', parentRemote);
  git(root, 'push', 'origin', 'main');
  return { root, child, parentRemote, childRemote };
}
function release(f, expected = 0, args = []) {
  return run('pwsh', ['-NoProfile', '-File', path.join(f.root, 'scripts/release.ps1'), ...args], f.root, expected);
}
function priorStash(root) {
  write(root, 'prior-note.txt', 'existing stash\n');
  git(root, 'stash', 'push', '--include-untracked', '-m', 'previous user stash');
  return git(root, 'rev-parse', 'refs/stash');
}
function dirty(root, note) {
  write(root, 'mixed.txt', 'staged edit\n');
  git(root, 'add', 'mixed.txt');
  fs.appendFileSync(path.join(root, 'mixed.txt'), 'unstaged edit\n');
  write(root, note, 'untracked edit\n');
  return {
    note,
    contents: fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'),
    index: git(root, 'show', ':mixed.txt'),
    status: git(root, 'status', '--porcelain', '--ignore-submodules=dirty'),
  };
}
function restored(root, saved, checkStatus = true) {
  assert.strictEqual(fs.readFileSync(path.join(root, 'mixed.txt'), 'utf8'), saved.contents);
  assert.strictEqual(git(root, 'show', ':mixed.txt'), saved.index);
  assert.strictEqual(fs.readFileSync(path.join(root, saved.note), 'utf8'), 'untracked edit\n');
  if (checkStatus) assert.strictEqual(git(root, 'status', '--porcelain', '--ignore-submodules=dirty'), saved.status);
}
function published(f) {
  const head = git(f.root, 'rev-parse', 'HEAD');
  assert.strictEqual(git(f.parentRemote, 'rev-parse', 'refs/heads/main'), head);
  assert.strictEqual(git(f.parentRemote, 'rev-parse', 'refs/tags/v1.19.0^{}'), head);
  assert.strictEqual(JSON.parse(git(f.root, 'show', 'HEAD:package.json')).version, '1.19.0');
  assert.strictEqual(git(f.root, 'rev-parse', 'HEAD:jetbrains'), git(f.child, 'rev-parse', 'HEAD'));
  assert.strictEqual(git(f.childRemote, 'rev-parse', 'refs/heads/main'), git(f.child, 'rev-parse', 'HEAD'));
  assert.strictEqual(git(f.root, 'show', 'HEAD:mixed.txt'), 'base');
  assert.strictEqual(git(f.child, 'show', 'HEAD:mixed.txt'), 'base');
}
function stashIds(root) {
  return git(root, 'stash', 'list', '--format=%H').split('\n').filter(Boolean);
}

try {
  {
    const f = fixture('clean');
    release(f);
    published(f);
    assert.strictEqual(git(f.root, 'status', '--porcelain'), '');
    assert.deepStrictEqual(stashIds(f.root), []);
    console.log('clean release: OK');
  }
  {
    const f = fixture('dirty');
    const oldParent = priorStash(f.root);
    const oldChild = priorStash(f.child);
    const parent = dirty(f.root, 'docs/draft 文件.md');
    const child = dirty(f.child, 'new data.json');
    write(f.root, 'ignored.txt', 'ignored local data\n');
    release(f);
    published(f);
    restored(f.root, parent);
    restored(f.child, child);
    assert.deepStrictEqual(stashIds(f.root), [oldParent]);
    assert.deepStrictEqual(stashIds(f.child), [oldChild]);
    assert.strictEqual(fs.readFileSync(path.join(f.root, 'ignored.txt'), 'utf8'), 'ignored local data\n');
    assert(!git(f.root, 'ls-tree', '-r', '--name-only', 'HEAD').includes(parent.note));
    assert(!git(f.child, 'ls-tree', '-r', '--name-only', 'HEAD').includes(child.note));
    console.log('tracked, staged, unstaged and untracked changes restored; old stashes preserved: OK');
  }
  {
    const f = fixture('dry-run');
    const oldParent = priorStash(f.root);
    const oldChild = priorStash(f.child);
    const parent = dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    const head = git(f.root, 'rev-parse', 'HEAD');
    const childHead = git(f.child, 'rev-parse', 'HEAD');
    write(f.root, 'package.json', '{"name":"ok-script-toolkit","version":"9.99.99"}\n');
    const output = release(f, 0, ['-DryRun']);
    assert(output.includes('Release: 1.18.0 -> v1.19.0'));
    restored(f.root, parent, false);
    restored(f.child, child);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '9.99.99');
    assert.strictEqual(git(f.root, 'rev-parse', 'HEAD'), head);
    assert.strictEqual(git(f.child, 'rev-parse', 'HEAD'), childHead);
    assert.deepStrictEqual(stashIds(f.root), [oldParent]);
    assert.deepStrictEqual(stashIds(f.child), [oldChild]);
    assert.strictEqual(git(f.parentRemote, 'tag', '--list'), '');
    console.log('dry-run leaves worktree, index, stashes and refs unchanged: OK');
  }
  {
    const f = fixture('wrong-branch');
    const parent = dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    git(f.child, 'switch', '-c', 'feature');
    release(f, 1);
    restored(f.root, parent);
    restored(f.child, child);
    assert.deepStrictEqual(stashIds(f.root), []);
    assert.deepStrictEqual(stashIds(f.child), []);
    console.log('branch refusal happens before stashing: OK');
  }
  {
    const f = fixture('stash-failure');
    const parent = dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    const lock = path.join(git(f.root, 'rev-parse', '--absolute-git-dir'), 'index.lock');
    fs.writeFileSync(lock, 'held by another Git operation\n');
    const output = release(f, 1);
    fs.unlinkSync(lock);
    assert(!output.includes('Syncing version'));
    restored(f.root, parent);
    restored(f.child, child);
    assert.deepStrictEqual(stashIds(f.root), []);
    assert.deepStrictEqual(stashIds(f.child), []);
    assert.strictEqual(JSON.parse(git(f.root, 'show', 'HEAD:package.json')).version, '1.18.0');
    assert.strictEqual(git(f.parentRemote, 'tag', '--list'), '');
    console.log('parent stash failure restores saved child edits without stashing unsaved parent edits again: OK');
  }
  {
    const f = fixture('verification-failure');
    write(f.root, 'scripts/release/verify-version.js', "throw new Error('verification failed');\n");
    git(f.root, 'add', 'scripts/release/verify-version.js');
    git(f.root, 'commit', '-m', 'force verification failure');
    const oldParent = priorStash(f.root);
    const oldChild = priorStash(f.child);
    const parent = dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    const head = git(f.root, 'rev-parse', 'HEAD');
    const childHead = git(f.child, 'rev-parse', 'HEAD');
    const output = release(f, 1);
    assert(!output.includes('Committing jetbrains'));
    assert.strictEqual(git(f.root, 'rev-parse', 'HEAD'), head);
    assert.strictEqual(git(f.child, 'rev-parse', 'HEAD'), childHead);
    restored(f.root, parent);
    restored(f.child, child);
    const pendingParent = stashIds(f.root);
    const pendingChild = stashIds(f.child);
    assert.strictEqual(pendingParent.length, 2);
    assert.strictEqual(pendingChild.length, 2);
    assert.strictEqual(pendingParent[1], oldParent);
    assert.strictEqual(pendingChild[1], oldChild);
    assert.strictEqual(JSON.parse(git(f.root, 'show', `${pendingParent[0]}:package.json`)).version, '1.19.0');
    assert.strictEqual(git(f.child, 'show', `${pendingChild[0]}:gradle.properties`), 'pluginVersion=1.19.0');
    assert.strictEqual(git(f.parentRemote, 'tag', '--list'), '');
    console.log('failed version verification stops release and restores edits: OK');
  }
  {
    const f = fixture('commit-failure');
    const parent = dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    const hook = path.join(git(f.child, 'rev-parse', '--absolute-git-dir'), 'hooks/pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const childHead = git(f.child, 'rev-parse', 'HEAD');
    const output = release(f, 1);
    assert(!output.includes('git push (jetbrains)'));
    assert.strictEqual(git(f.child, 'rev-parse', 'HEAD'), childHead);
    restored(f.root, parent);
    restored(f.child, child);
    assert.strictEqual(stashIds(f.root).length, 1);
    assert.strictEqual(stashIds(f.child).length, 1);
    assert.strictEqual(JSON.parse(git(f.root, 'show', `${stashIds(f.root)[0]}:package.json`)).version, '1.19.0');
    assert.strictEqual(git(f.child, 'show', `${stashIds(f.child)[0]}^2:gradle.properties`), 'pluginVersion=1.19.0');
    assert.strictEqual(git(f.parentRemote, 'tag', '--list'), '');
    console.log('failed Git commit stops before push and restores edits: OK');
  }
  {
    const f = fixture('push-failure');
    const parent = dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    const remoteHead = git(f.parentRemote, 'rev-parse', 'refs/heads/main');
    const hook = path.join(f.parentRemote, 'hooks/pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    const output = release(f, 1);
    assert(!output.includes('Creating tag'));
    assert.strictEqual(git(f.parentRemote, 'rev-parse', 'refs/heads/main'), remoteHead);
    assert.strictEqual(git(f.parentRemote, 'tag', '--list'), '');
    assert.strictEqual(JSON.parse(git(f.root, 'show', 'HEAD:package.json')).version, '1.19.0');
    assert.strictEqual(git(f.childRemote, 'rev-parse', 'refs/heads/main'), git(f.child, 'rev-parse', 'HEAD'));
    restored(f.root, parent);
    restored(f.child, child);
    assert.deepStrictEqual(stashIds(f.root), []);
    assert.deepStrictEqual(stashIds(f.child), []);
    console.log('failed push stops before tagging; completed commits remain; edits restored: OK');
  }
  {
    const f = fixture('restore-conflict');
    const oldParent = priorStash(f.root);
    const oldChild = priorStash(f.child);
    dirty(f.root, 'draft.md');
    const child = dirty(f.child, 'draft.json');
    write(f.root, 'package.json', '{"name":"ok-script-toolkit","version":"9.99.99"}\n');
    const output = release(f, 1);
    published(f);
    assert(output.includes('Release v1.19.0 was pushed; only local-change restoration needs attention.'));
    restored(f.child, child);
    assert.deepStrictEqual(stashIds(f.child), [oldChild]);
    const saved = stashIds(f.root);
    assert.strictEqual(saved.length, 2);
    assert.strictEqual(saved[1], oldParent);
    assert(output.includes(saved[0]));
    assert.strictEqual(JSON.parse(git(f.root, 'show', `${saved[0]}:package.json`)).version, '9.99.99');
    console.log('restore conflict retains exact stash and still restores the other repository: OK');
  }
} finally {
  // Delete only the fixture directory created above, after checking its boundary.
  const resolved = fs.realpathSync(sandbox);
  assert.strictEqual(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert(path.basename(resolved).startsWith('ok-release test '));
  fs.rmSync(resolved, { recursive: true, force: true });
}
