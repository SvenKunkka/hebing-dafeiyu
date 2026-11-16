import test from 'node:test';
import assert from 'node:assert/strict';
import { avatar, buildPlan, resolveFiles, safePath, standingWarnings } from '../packages/fusion/host/merge.mjs';
const source = (slug, files) => ({ bot: { slug, displayName: slug }, files: Object.entries(files).map(([path, content]) => ({ path, content, encoding: 'utf8' })) });

test('exact duplicates collapse and differing documents require an explicit choice', () => {
  const plan = buildPlan([source('a', { 'MEMORY.md': 'A', 'shared.txt': 'same' }), source('b', { 'MEMORY.md': 'B', 'shared.txt': 'same' })]);
  assert.equal(plan.exactDuplicates, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.throws(() => resolveFiles(plan, {}, { name: 'New' }), /先处理/);
  const files = resolveFiles(plan, { [plan.conflicts[0].id]: 'merge' }, { name: 'New' });
  assert.match(files.find(f => f.path === 'MEMORY.md').content, /来自 a/);
  assert.equal(files.filter(f => f.path === 'shared.txt').length, 1);
});

test('binary files and same-name different files retain their exact contents', () => {
  const a = source('a', { 'x.txt': 'first' });
  a.files.push({ path: 'diagram.bin', encoding: 'base64', content: Buffer.from([0, 255, 8]).toString('base64') });
  const plan = buildPlan([a, source('b', { 'x.txt': 'second' })]);
  const files = resolveFiles(plan, { [plan.conflicts[0].id]: 'merge' }, { name: 'New' });
  assert.ok(files.some(f => f.path === 'knowledge/a/x.txt'));
  assert.deepEqual(Buffer.from(files.find(f => f.path === 'diagram.bin').content, 'base64'), Buffer.from([0,255,8]));
});

test('protected paths, duplicate sources and tampered hashes are rejected', () => {
  for (const path of ['../x', '/x', '.git/config', 'a\\b', 'a/../../x', '.botharness/private']) assert.throws(() => safePath(path));
  const a = source('a', { 'x.txt': 'x' });
  assert.throws(() => buildPlan([a,a]), /重复/);
  a.files[0].sha256 = 'bad';
  assert.throws(() => buildPlan([a,source('b',{})]), /校验失败/);
});

test('avatars are valid small PNGs, stable per task and vary for new tasks', () => {
  const a = avatar('same');
  assert.deepEqual(avatar('same'), a);
  assert.notEqual(avatar().dataUrl, avatar().dataUrl);
  const bytes = Buffer.from(a.dataUrl.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 64);
  assert.ok(bytes.length < 131072);
});

const review = plan => Object.fromEntries(plan.conflicts.map(conflict => [conflict.id, 'merge']));
const assertUnique = files => {
  const keys = files.map(file => file.path.normalize('NFC').toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  for (const path of keys) assert.ok(!keys.some(other => other !== path && other.startsWith(`${path}/`)), `file/directory conflict: ${path}`);
};

test('a fused bot can be fused again without overwriting provenance or reserved metadata', () => {
  const first = buildPlan([source('a', { 'MEMORY.md': 'A' }), source('b', { 'MEMORY.md': 'B' })]);
  const firstFiles = resolveFiles(first, review(first), { name: 'First' });
  const second = buildPlan([{ bot: { slug: 'first', displayName: 'First' }, files: firstFiles }, source('c', { 'MEMORY.md': 'C', '.forge/creation.json': 'source user file' })]);
  const files = resolveFiles(second, review(second), { name: 'Second' });
  assertUnique(files);
  assert.equal(files.filter(file => file.path === 'FUSION-SOURCES.md').length, 1);
  assert.ok(files.some(file => file.path !== 'FUSION-SOURCES.md' && file.content === firstFiles.find(file => file.path === 'FUSION-SOURCES.md').content));
  assert.ok(files.some(file => file.path.startsWith('knowledge/c/') && file.content === 'source user file'));
  assert.ok(!files.some(file => file.path.startsWith('.forge/')));
});

test('generated archive paths avoid source paths, case collisions and file/directory collisions', () => {
  const plan = buildPlan([source('a', { 'x.txt': 'first', 'knowledge/a/x.txt': 'original archive', 'note': 'root file', 'Photo.txt': 'upper' }), source('b', { 'x.txt': 'second', 'note/child.txt': 'descendant', 'photo.txt': 'lower' })]);
  const files = resolveFiles(plan, review(plan), { name: 'Combined' });
  assertUnique(files);
  for (const content of ['first','second','original archive','root file','descendant','upper','lower']) assert.ok(files.some(file => file.content === content), content);
  assert.equal(files.find(file => file.path === 'knowledge/a/x.txt').content, 'original archive');
});

test('oversized standing documents become short indices while their full text remains intact', () => {
  const soul = '甲'.repeat(5001) + '\n禁止未授权发送';
  const memory = '乙'.repeat(3001) + '\n未完成事项';
  const plan = buildPlan([source('a', { 'SOUL.md': soul, 'MEMORY.md': memory }), source('b', { 'other.txt': 'knowledge' })]);
  const files = resolveFiles(plan, review(plan), { name: 'Combined' });
  const warnings = standingWarnings(files);
  assert.equal(warnings.length, 2);
  for (const [path, full, limit] of [['SOUL.md',soul,5000],['MEMORY.md',memory,3000]]) {
    const standing = files.find(file => file.path === path);
    assert.ok([...standing.content].length <= limit);
    assert.match(standing.content, /执行任务前必须先读取/);
    assert.match(standing.content, /明确授权/);
    assert.equal(files.find(file => file.path === standing.standingArchive.path).content, full);
  }
  assertUnique(files);
});

test('exact standing limits remain inline and AI edits retain the reviewed original documents', () => {
  const plan = buildPlan([source('a', { 'SOUL.md': '甲'.repeat(5000), 'MEMORY.md': '乙'.repeat(3000) }), source('b', { 'other.txt': 'knowledge' })]);
  assert.equal(standingWarnings(resolveFiles(plan, review(plan), { name: 'Combined' })).length, 0);
  const files = resolveFiles(plan, review(plan), { name: 'Combined', analysis: { persona: 'edited persona', memory: 'edited memory' } });
  assert.ok(files.some(file => file.path.startsWith('knowledge/fusion/original/') && file.content === '甲'.repeat(5000)));
  assert.equal(files.find(file => file.path === 'SOUL.md').content, 'edited persona');
});

test('binary identity documents and unsafe case variants fail before content transformation', () => {
  const input = source('a', {});
  input.files.push({ path: 'soul.md', encoding: 'base64', content: 'AP8=' });
  assert.throws(() => buildPlan([input, source('b', {})]), /UTF-8/);
  for (const path of ['.GIT/config', '.Botharness/private', 'C:relative']) assert.throws(() => safePath(path));
});

test('both Agent document names reach the standing rules without repeating identical content', () => {
  const plan = buildPlan([source('a', { 'AGENTS.md': 'specific boundary' }), source('b', { 'CLAUDE.md': 'specific boundary' })]);
  const files = resolveFiles(plan, review(plan), { name: 'Combined' });
  const body = files.find(file => file.path === 'SOUL.md').content;
  assert.equal(body.split('specific boundary').length - 1, 1);
  assert.equal(files.find(file => file.path === 'CLAUDE.md').content, 'specific boundary');
});
