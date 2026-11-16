import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BotAdapter } from '../packages/fusion/host/adapter.mjs';
import { avatar } from '../packages/fusion/host/merge.mjs';

const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function walk(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).filter(entry => entry.name !== '.git').flatMap(entry => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? walk(join(path, entry.name), name + '/') : [name];
  }).sort();
}

function fixture(t) {
  mkdirSync(runtime, { recursive: true });
  const home = mkdtempSync(join(runtime, 'adapter-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const rootDir = join(home, 'botharness');
  const bots = join(rootDir, 'bots');
  mkdirSync(bots, { recursive: true });
  const records = new Map();
  const calls = { imports: [], human: [], deleted: [], roster: [], recovery: [] };
  const dir = slug => join(bots, slug, 'memory');
  const put = (slug, data = { 'SOUL.md': '# Bot', 'MEMORY.md': '# Memory' }, extra = {}) => {
    mkdirSync(dir(slug), { recursive: true });
    for (const [path, content] of Object.entries(data)) { mkdirSync(dirname(join(dir(slug), path)), { recursive: true }); writeFileSync(join(dir(slug), path), content); }
    git(dir(slug), 'init', '-q');
    git(dir(slug), 'add', '--all');
    git(dir(slug), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.test', 'commit', '-q', '-m', 'initial');
    const record = { slug, displayName: slug, createdAt: '2026-11-16T00:00:00Z', workspaces: [], ...extra };
    records.set(slug, record);
    return structuredClone(record);
  };
  const core = {
    rootDir,
    tob: { isTob: slug => slug === 'system-hidden' },
    states: { snapshot: () => ({ sessions: {} }) },
    runtime: { turnRunning: () => false },
    schedules: { list: () => [] },
    registry: {
      rootDir: bots,
      list: () => [...records.values()].map(record => structuredClone(record)),
      get: slug => records.has(slug) ? structuredClone(records.get(slug)) : undefined,
      getHistorical: slug => records.has(slug) ? structuredClone(records.get(slug)) : undefined,
      memoryDirFor: slug => records.get(slug)?.memoryDir ?? dir(slug),
      createFromFiles: async input => {
        calls.imports.push(input);
        assert.deepEqual(input.workspaces, []);
        const record = put(input.slug, Object.fromEntries(input.files.map(file => [file.path, file.data])), { displayName: input.displayName, avatar: input.avatar });
        return { ok: true, record };
      },
    },
    memory: {
      recoveryHistory: slug => {calls.recovery.push(slug);return [];},
      snapshot: slug => ({ head: git(dir(slug), 'rev-parse', 'HEAD').trim(), files: walk(dir(slug)), provisional: false, standing: [] }),
      downloadFile: (slug, path) => { const data = readFileSync(join(dir(slug), path)); return { size: data.length, body: new Response(data).body }; },
      readAccepted: (slug, path) => { try { return { body: readFileSync(join(dir(slug), path), 'utf8') }; } catch { return undefined; } },
      saveHuman: input => {
        calls.human.push(input);
        assert.equal(input.expectedHead, git(dir(input.botSlug), 'rev-parse', 'HEAD').trim());
        const target = join(dir(input.botSlug), input.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, input.body);
        git(dir(input.botSlug), 'add', '--', input.path);
        git(dir(input.botSlug), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.test', 'commit', '-q', '-m', 'human edit');
      },
    },
    channels: { getOrCreateDm: slug => ({ id: `dm-${slug}` }) },
    live: { publishRosterCommitted: () => calls.roster.push(true) },
    deletions: {
      preview: slug => ({ slug, token: `token-${slug}`, eraseAvailable: true, dependencies: { sessions: [], grants: [], workspaces: [], identities: [], channels: [] } }),
      confirm: async (slug, token, eraseMemory) => { calls.deleted.push({ slug, token, eraseMemory }); return { phase: 'complete', memory: eraseMemory ? 'erased' : 'retained' }; },
    },
  };
  return { home, rootDir, records, core, calls, dir, put, adapter: new BotAdapter({ botharness: core }, { home }) };
}

test('snapshot preserves binary and dirty bytes, omits ignored files, symlinks and platform identity', async t => {
  const f = fixture(t);
  f.put('a', { 'SOUL.md': 'persona', 'diagram.bin': Buffer.from([0, 255, 8]), '.gitignore': 'secret.txt\n', '.botharness/bot.json': '{"name":"old"}' });
  writeFileSync(join(f.dir('a'), 'SOUL.md'), 'dirty persona');
  writeFileSync(join(f.dir('a'), 'secret.txt'), 'must not be read');
  symlinkSync(join(f.dir('a'), 'SOUL.md'), join(f.dir('a'), 'link.md'));
  const snapshot = await f.adapter.snapshot('a');
  assert.equal(snapshot.bot.persona, 'dirty persona');
  assert.deepEqual(Buffer.from(snapshot.files.find(file => file.path === 'diagram.bin').content, 'base64'), Buffer.from([0,255,8]));
  assert.ok(snapshot.dirty);
  assert.ok(snapshot.excluded.some(value => value.includes('secret.txt')));
  assert.ok(snapshot.excluded.some(value => value.includes('link.md')));
  assert.ok(!snapshot.files.some(file => file.path.includes('.botharness')));
  writeFileSync(join(f.dir('a'), 'SOUL.md'), 'another dirty persona');
  assert.notEqual((await f.adapter.snapshot('a')).fingerprint, snapshot.fingerprint);
});

test('snapshot detects content changes while reading even when Git remains dirty', async t => {
  const f = fixture(t); f.put('a');
  writeFileSync(join(f.dir('a'), 'MEMORY.md'), 'dirty one');
  const original = f.core.memory.downloadFile;
  let reads = 0;
  f.core.memory.downloadFile = (slug, path) => {
    const result = original(slug, path);
    if (path === 'MEMORY.md' && ++reads === 1) writeFileSync(join(f.dir(slug), path), 'dirty two');
    return result;
  };
  await assert.rejects(f.adapter.snapshot('a'), /快照期间变化/);
});

test('native file import preserves bytes and provides stable idempotency without permission inheritance', async t => {
  const f = fixture(t);
  const input = { name: 'Combined', operationKey: 'fusion-test-key', avatar: avatar('test').dataUrl, files: [{ path: 'SOUL.md', content: 'merged persona', encoding: 'utf8' }, { path: 'binary.bin', content: Buffer.from([0,255,3]).toString('base64'), encoding: 'base64' }] };
  const first = await f.adapter.createBotFromFiles(input);
  const second = await new BotAdapter({ botharness: f.core }, { home: f.home }).createBotFromFiles(input);
  assert.equal(first.slug, second.slug);
  assert.equal(f.calls.imports.length, 1);
  assert.equal(f.calls.roster.length, 2, 'both a newly created identity and a retry must refresh the native roster');
  assert.equal(f.calls.recovery.length,2,'native recovery metadata is initialized before creation and idempotent-retry receipts return');
  assert.equal(first.channelId, `dm-${first.slug}`);
  assert.deepEqual(readFileSync(join(f.dir(first.slug), 'binary.bin')), Buffer.from([0,255,3]));
  assert.equal(f.calls.imports[0].computerAccess, undefined);
  assert.equal(f.calls.imports[0].browserAccess, undefined);
  assert.equal(f.calls.imports[0].model, undefined);
  const snapshot = await f.adapter.snapshot(first.slug);
  assert.ok(!snapshot.files.some(file => file.path === '.forge/creation.json'));
  await assert.rejects(f.adapter.createBotFromFiles({ ...input, name: 'Different' }), /标识已用于不同资料/);
});

test('concurrent requests with a reused operation key cannot silently use different content', async t => {
  const f = fixture(t);
  let release;
  const original = f.core.registry.createFromFiles;
  f.core.registry.createFromFiles = async input => { await new Promise(resolve => { release = resolve; }); return original(input); };
  const input = { name: 'Bot', operationKey: 'fusion-racing-key', files: [{ path: 'SOUL.md', encoding: 'utf8', content: 'A' }] };
  const first = f.adapter.createBotFromFiles(input);
  await assert.rejects(f.adapter.createBotFromFiles({ ...input, files: [{ path: 'SOUL.md', encoding: 'utf8', content: 'B' }] }), /标识已用于不同资料/);
  release(); await first;
});

test('malformed binary, hash tampering, traversal and oversized avatar are rejected before native writes', async t => {
  const f = fixture(t);
  const base = { name: 'Bot', operationKey: 'fusion-invalid-key', files: [{ path: 'SOUL.md', encoding: 'utf8', content: 'ok' }] };
  for (const file of [{ path: '../escape', encoding: 'utf8', content: 'x' }, { path: '.git/config', encoding: 'utf8', content: 'x' }, { path: 'a.bin', encoding: 'base64', content: '???' }, { path: 'a.md', encoding: 'utf8', content: 'x', sha256: 'wrong' }]) await assert.rejects(f.adapter.createBotFromFiles({ ...base, files: [file] }));
  const bytes = Buffer.alloc(131073); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  await assert.rejects(f.adapter.createBotFromFiles({ ...base, avatar: `data:image/png;base64,${bytes.toString('base64')}` }), /128 KiB/);
  assert.equal(f.calls.imports.length, 0);
});

test('Tob protection follows native system identity and incomplete deletion never succeeds', async t => {
  const f = fixture(t); f.put('system-hidden', undefined, { displayName: 'Renamed' }); f.put('ordinary', undefined, { displayName: 'Tob' });
  await assert.rejects(f.adapter.deletionPreview('system-hidden'), /受保护/);
  await assert.rejects(f.adapter.deletionConfirm('system-hidden', 'forged', true), /受保护/);
  await f.adapter.deletionConfirm('ordinary', 'native-token', false);
  assert.deepEqual(f.calls.deleted, [{ slug: 'ordinary', token: 'native-token', eraseMemory: false }]);
  f.core.deletions.confirm = async () => ({ phase: 'incomplete', failure: 'still stopping' });
  await assert.rejects(f.adapter.deletionConfirm('ordinary', 'token', true), error => error.code === 'FORGE_NATIVE_DELETION_INCOMPLETE' && error.nativeDeletionAccepted === true && !JSON.stringify(error).includes('still stopping'));
});

test('accepted deletion resumes through native retry after the active Bot disappears', async t => {
  const f = fixture(t); f.put('a');
  let state;
  let retries = 0;
  f.core.deletions.get = slug => slug === 'a' ? state : undefined;
  f.core.deletions.confirm = async () => {
    state = { slug: 'a', acceptedAt: '2026-11-16T00:00:00Z', memoryDir: f.dir('a'), eraseMemory: true, phase: 'incomplete', memory: 'pending', failure: 'secret token must never be copied' };
    f.records.delete('a');
    return state;
  };
  f.core.deletions.retry = async () => { retries++; state = { ...state, phase: 'complete', memory: 'erased', cleanupAccepted: true }; return state; };
  await assert.rejects(f.adapter.deletionConfirm('a', 'native', true), error => {
    assert.equal(error.nativeDeletionAccepted, true);
    assert.equal(error.code, 'FORGE_NATIVE_DELETION_INCOMPLETE');
    assert.equal(error.deletion.memory, 'pending');
    assert.equal(JSON.stringify(error).includes('secret token'), false);
    assert.equal(JSON.stringify(error).includes(f.dir('a')), false);
    return true;
  });
  await assert.rejects(f.adapter.getBot('a'), /不存在/);
  assert.equal((await f.adapter.deletionState('a')).phase, 'incomplete');
  const completed = await f.adapter.deletionRetry('a');
  assert.equal(completed.phase, 'complete'); assert.equal(completed.memory, 'erased');
  assert.equal(retries, 1);
  assert.equal('memoryDir' in completed, false); assert.equal('failure' in completed, false);
  await assert.rejects(f.adapter.deletionRetry('unknown'), /尚未接受/);
  await assert.rejects(f.adapter.deletionRetry('system-hidden'), /受保护/);
  state = { ...state, memoryDir: dirname(f.home) };
  await assert.rejects(f.adapter.deletionRetry('a'), /不属于当前独立环境/);
});

test('exceptions after native acceptance carry a minimal recoverable marker', async t => {
  const f = fixture(t); f.put('a');
  const state = { slug: 'a', memoryDir: f.dir('a'), eraseMemory: false, phase: 'cleanup', memory: 'retained' };
  f.core.deletions.confirm = async () => { throw new Error('private failure detail'); };
  f.core.deletions.get = () => state;
  f.core.deletions.retry = async () => { throw new Error('another private detail'); };
  for (const action of [() => f.adapter.deletionConfirm('a', 'native', false), () => f.adapter.deletionRetry('a')]) {
    await assert.rejects(action(), error => error.nativeDeletionAccepted === true && error.deletion.memory === 'retained' && !error.message.includes('private'));
  }
});

test('text changes use Memory expectedHead and skip unchanged writes', async t => {
  const f = fixture(t); f.put('a');
  const file = { path: 'notes/new.md', encoding: 'utf8', content: 'new text' };
  await f.adapter.writeFiles('a', [file]);
  await f.adapter.writeFiles('a', [file]);
  assert.equal(f.calls.human.length, 1);
  await assert.rejects(f.adapter.writeFiles('a', [{ path: 'image.bin', encoding: 'base64', content: 'AA==' }]), /原样导入/);
});

test('managed storage cannot escape the isolated runtime', async t => {
  const f = fixture(t); f.put('a');
  f.records.get('a').memoryDir = dirname(f.home);
  await assert.rejects(f.adapter.snapshot('a'), /不属于当前独立环境/);
  const outside = new BotAdapter({ botharness: f.core }, { home: join(f.home, 'botharness', 'bots') });
  await assert.rejects(outside.listBots(), /不属于独立运行环境/);
});

test('a fresh managed root is created only after verifying it is inside the isolated home', async t => {
  const f = fixture(t);
  rmSync(f.rootDir, { recursive: true });
  assert.deepEqual(await f.adapter.listBots(), []);
  assert.ok(existsSync(f.rootDir));
  const unsafe = new BotAdapter({ botharness: { ...f.core, rootDir: dirname(f.home) } }, { home: f.home });
  await assert.rejects(unsafe.listBots(), /不属于独立运行环境/);
});

test('protected Tob history is still discoverable for fusion through public ownership without deletion preview',async t=>{
  const f=fixture(t);f.put('system-hidden');
  f.core.ownership={rootsFor:()=>[{sessionId:'parent-session'}],descendantsOf:()=>[{sessionId:'child-session'}]};
  f.core.deletions.preview=()=>{throw new Error('protected deletion preview must not be called');};
  const snapshot=await f.adapter.snapshot('system-hidden');
  assert.equal(snapshot.protected,true);assert.deepEqual(snapshot.dependencies.sessions,['child-session','parent-session']);
});
