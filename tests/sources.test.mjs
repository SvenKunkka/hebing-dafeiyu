import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { localSourceSnapshot, listLocalSources } from '../packages/fusion/host/sources.mjs';

const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
function testHome(t) {
  mkdirSync(runtime, { recursive: true });
  const home = mkdtempSync(join(runtime, 'source-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('local import is read only, preserves binary bytes and explicitly excludes ignored files and symlinks', async t => {
  const home = testHome(t);
  const memory = join(home, 'botharness', 'bots', 'bot-source', 'memory'); mkdirSync(memory, { recursive: true });
  const dbPath = join(home,'botharness','botharness.db');
  const db = new DatabaseSync(dbPath); db.exec('CREATE TABLE persona_bots(slug TEXT PRIMARY KEY, body TEXT NOT NULL)');
  db.prepare('INSERT INTO persona_bots VALUES(?,?)').run('bot-source', JSON.stringify({ displayName: 'Source' })); db.close();
  writeFileSync(join(memory,'MEMORY.md'), 'facts'); writeFileSync(join(memory,'binary.bin'), Buffer.from([0,255,1])); writeFileSync(join(memory,'.gitignore'), 'private.txt\n'); writeFileSync(join(memory,'private.txt'), 'ignored');
  symlinkSync('/etc/hosts',join(memory,'external-link'));
  const git = args => execFileSync('git', ['-C',memory,...args], { stdio: 'pipe' });
  git(['init']); git(['add','MEMORY.md','.gitignore','binary.bin']); git(['-c','user.name=Forge Test','-c','user.email=test@example.invalid','commit','-m','baseline']);
  writeFileSync(join(memory,'MEMORY.md'),'dirty current facts');
  const before = readFileSync(dbPath);
  const indexBefore = readFileSync(join(memory, '.git', 'index'));
  assert.equal((await listLocalSources(home)).length, 1);
  const snapshot = await localSourceSnapshot(home,'bot-source');
  assert.equal(snapshot.files.find(f => f.path === 'MEMORY.md').content,'dirty current facts');
  assert.deepEqual(Buffer.from(snapshot.files.find(f => f.path === 'binary.bin').content,'base64'),Buffer.from([0,255,1]));
  assert.ok(!snapshot.files.some(f => ['private.txt','external-link'].includes(f.path)));
  assert.deepEqual(readFileSync(dbPath), before);
  assert.deepEqual(readFileSync(join(memory, '.git', 'index')), indexBefore);
  assert.ok(snapshot.excluded.some(value => value.includes('private.txt')));
  assert.ok(snapshot.excluded.some(value => value.includes('external-link')));
  await assert.rejects(localSourceSnapshot(home,'../../other'));
});

function sourceFixture(t) {
  const home = testHome(t);
  const memory = join(home, 'botharness', 'bots', 'bot-source', 'memory');
  mkdirSync(memory, { recursive: true });
  const dbPath = join(home, 'botharness', 'botharness.db');
  const database = new DatabaseSync(dbPath);
  database.exec('CREATE TABLE persona_bots(slug TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE persona_bot_deletions(slug TEXT PRIMARY KEY, body TEXT NOT NULL)');
  database.prepare('INSERT INTO persona_bots VALUES(?,?)').run('bot-source', JSON.stringify({ displayName: 'Source' }));
  database.close();
  writeFileSync(join(memory, 'A.md'), 'first'); writeFileSync(join(memory, 'B.md'), 'second');
  const git = args => execFileSync('git', ['-C', memory, ...args], { stdio: 'pipe' });
  git(['init']); git(['add', '--all']); git(['-c','user.name=Fixture','-c','user.email=fixture@invalid.test','commit','-m','initial']);
  return { home, memory, editDatabase(action) { const db = new DatabaseSync(dbPath); try { return action(db); } finally { db.close(); } } };
}

test('native deleted records remain excluded even when their original Memory still exists', async t => {
  const f = sourceFixture(t);
  f.editDatabase(db => db.prepare('INSERT INTO persona_bot_deletions VALUES(?,?)').run('bot-source', '{}'));
  assert.deepEqual(await listLocalSources(f.home), []);
  await assert.rejects(localSourceSnapshot(f.home, 'bot-source'), /来源不存在/);
});

test('a linked Memory root is unavailable and is never traversed', async t => {
  const f = sourceFixture(t);
  const retained = join(f.home, 'retained-memory');
  renameSync(f.memory, retained); symlinkSync(retained, f.memory);
  assert.equal((await listLocalSources(f.home))[0].available, false);
  await assert.rejects(localSourceSnapshot(f.home, 'bot-source'), /路径不可用/);
});

test('changes to an earlier dirty file are detected during the final byte verification', async t => {
  const f = sourceFixture(t);
  writeFileSync(join(f.memory, 'A.md'), 'dirty first');
  let count = 0;
  await assert.rejects(localSourceSnapshot(f.home, 'bot-source', { readFile(fd) {
    const data = readFileSync(fd);
    if (++count === 2) writeFileSync(join(f.memory, 'A.md'), 'dirty changed');
    return data;
  } }), /来源发生变化/);
});

test('new untracked files and registry changes invalidate an in-progress import snapshot', async t => {
  const f = sourceFixture(t);
  let count = 0;
  await assert.rejects(localSourceSnapshot(f.home, 'bot-source', { readFile(fd) {
    const data = readFileSync(fd);
    if (++count === 1) writeFileSync(join(f.memory, 'C.md'), 'arrived while reading');
    return data;
  } }), /来源版本或资料发生变化/);
  count = 0;
  await assert.rejects(localSourceSnapshot(f.home, 'bot-source', { readFile(fd) {
    const data = readFileSync(fd);
    if (++count === 1) f.editDatabase(db => db.prepare('UPDATE persona_bots SET body=? WHERE slug=?').run(JSON.stringify({ displayName: 'Changed' }), 'bot-source'));
    return data;
  } }), /来源版本或资料发生变化/);
});
