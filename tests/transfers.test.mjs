import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schedulePreview, migrateSchedules } from '../packages/fusion/host/transfers.mjs';
import { JobStore } from '../packages/fusion/host/store.mjs';
import { digest } from '../packages/fusion/host/merge.mjs';

function setup(t, options = {}) {
  const base = fileURLToPath(new URL('../.runtime/', import.meta.url)); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'transfer-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = Date.now(); let clock = at; let copies = 0;
  const timestamp = () => new Date(clock = Math.max(Date.now(), clock + 1)).toISOString();
  const future = () => new Date(Date.now() + 3_600_000).toISOString();
  const original = { title: '周报', prompt: '只生成本地草稿', trigger: { kind: 'cron', expression: '0 9 * * 1', timeZone: 'Asia/Shanghai' }, enabled: true, locked: false, createdAt: new Date(at - 1000).toISOString(), updatedAt: new Date(at - 1000).toISOString(), nextRunAt: future() };
  const data = new Map([
    ['a', [{ botSlug: 'a', id: 'first', creator: 'human', ...structuredClone(original), ...options.a }]],
    ['b', [{ botSlug: 'b', id: 'second', creator: 'human', ...structuredClone(original), enabled: false, nextRunAt: undefined, ...options.b }]],
    ['new', []],
  ]);
  const metadata = new Map(['a', 'b', 'new'].map(slug => [slug, { bot: { slug, displayName: slug }, head: `head-${slug}`, dirty: '', dependencies: { grants: [], sessions: [] }, files: [], running: false }]));
  const events = []; const hooks = {};
  const schedules = {
    list: slug => structuredClone(data.get(slug) ?? []),
    history: (slug, id) => structuredClone(slug === 'a' && options.aHistory ? options.aHistory : data.get(slug).find(row => row.id === id)?.history ?? []),
    create(slug, input, creator) {
      assert.ok(['cron', 'daily', 'weekly', 'every', 'once'].includes(input.trigger.kind), 'native schedule DTO uses kind');
      assert.ok(input.title.length <= 120, 'native title limit');
      const time = timestamp();
      const row = { botSlug: slug, id: `copy-${++copies}`, creator, ...structuredClone(input), createdAt: time, updatedAt: time, ...(input.enabled ? { nextRunAt: future() } : {}) };
      data.get(slug).push(row); events.push(['create', slug, row.id, input.enabled]);
      hooks.afterCreate?.(row);
      return structuredClone(row);
    },
    update(slug, id, patch) {
      events.push(['update', slug, id, patch.enabled]);
      hooks.beforeUpdate?.(slug, id, patch);
      const row = data.get(slug).find(item => item.id === id); if (!row) throw new Error('missing');
      const wasEnabled = row.enabled;
      Object.assign(row, patch, { updatedAt: timestamp() });
      if (!row.enabled) delete row.nextRunAt;
      else if (!wasEnabled) row.nextRunAt = future();
      hooks.afterUpdate?.(slug, id, patch);
      return structuredClone(row);
    },
  };
  const snapshot = slug => {
    const value = structuredClone(metadata.get(slug));
    return { ...value, fingerprint: digest(JSON.stringify({ ...value, running: undefined, schedules: data.get(slug) })) };
  };
  const snapshots = ['a', 'b'].map(snapshot);
  const store = new JobStore(root);
  const job = store.create({ name: '融合', status: 'verified', verification: { ok: true, candidateFingerprint: snapshot('new').fingerprint }, newBot: { slug: 'new' }, sources: snapshots.map(value => ({ slug: value.bot.slug, displayName: value.bot.displayName, fingerprint: value.fingerprint })), snapshots });
  const service = {
    store, adapter: { core: () => ({ schedules }), snapshot: async slug => { hooks.beforeSnapshot?.(slug); return snapshot(slug); } },
    assertCandidate: async (job, { allowScheduleChanges = false } = {}) => { if (!allowScheduleChanges) assert.equal(snapshot('new').fingerprint, job.verification.candidateFingerprint); },
    assertSources: async job => { for (const source of job.sources) assert.equal(snapshot(source.slug).fingerprint, source.fingerprint); },
  };
  return { root, store, service, job, data, events, hooks, metadata, snapshot, copies: () => copies };
}

async function preview(f) { return schedulePreview(f.service, { id: f.job.id, behaviorConfirmed: true }); }
async function migrate(f, p, keys = p?.rows.map(row => row.key)) {
  return migrateSchedules(f.service, { id: f.job.id, token: p?.token, selectedKeys: keys, acknowledgement: '融合' });
}
async function failedActivation(f) {
  const p = await preview(f); let once = true;
  f.hooks.beforeUpdate = (slug, _id, patch) => { if (slug === 'new' && patch.enabled && once) { once = false; throw new Error('模拟启用失败'); } };
  await assert.rejects(migrate(f, p, [p.rows[0].key]), /模拟启用失败/);
  delete f.hooks.beforeUpdate;
  return p;
}

test('schedule transfer stops all old items before activating copies and preserves disabled state and native time zone', async t => {
  const f = setup(t); const p = await preview(f);
  const result = await migrate(f, p);
  assert.equal(result.job.scheduleTransfer.status, 'complete');
  assert.equal(f.data.get('a')[0].enabled, false); assert.equal(f.data.get('b')[0].enabled, false);
  assert.deepEqual(f.data.get('new').map(row => row.enabled), [true, false]);
  assert.equal(f.data.get('new')[0].trigger.timeZone, 'Asia/Shanghai');
  const enabledAt = f.events.findIndex(event => event[0] === 'update' && event[1] === 'new' && event[3]);
  assert.ok(f.events.slice(0, enabledAt).some(event => event[1] === 'a' && event[3] === false));
  assert.ok(!f.events.some(event => event[1] === 'b' && event[0] === 'update'), 'already disabled old schedules stay untouched');
  await migrate(f); assert.equal(f.copies(), 2);
  assert.deepEqual(f.metadata.get('new').dependencies.grants, []);
  assert.match(p.reason, /重新计时/); assert.match(p.reason, /不会继承/);
});

test('failed activation restores only the old version this operation stopped and retry reuses the paused copy', async t => {
  const f = setup(t); await failedActivation(f);
  assert.equal(f.data.get('a')[0].enabled, true); assert.equal(f.data.get('new')[0].enabled, false);
  const result = await migrate(f);
  assert.equal(result.job.scheduleTransfer.status, 'complete'); assert.equal(f.copies(), 1); assert.equal(f.data.get('a')[0].enabled, false);
});

test('retry refuses pending or observed source firings before any new activation', async t => {
  for (const state of ['pending', 'observed']) {
    const f = setup(t); await failedActivation(f);
    f.data.get('a')[0].lastFiring = { state };
    const offset = f.events.length;
    await assert.rejects(migrate(f), /例程|触发/);
    assert.equal(f.data.get('new')[0].enabled, false);
    assert.ok(!f.events.slice(offset).some(event => event[1] === 'new' && event[3]));
  }
});

test('rollback never re-enables a source that the user changed and disabled after an earlier failure', async t => {
  const f = setup(t); await failedActivation(f);
  Object.assign(f.data.get('a')[0], { prompt: '后来修改的任务', enabled: false, updatedAt: new Date().toISOString() });
  await assert.rejects(migrate(f), /例程清单/);
  assert.equal(f.data.get('a')[0].enabled, false); assert.equal(f.data.get('a')[0].prompt, '后来修改的任务');
});

test('external dependency changes during cutover are not accepted as a new source fingerprint', async t => {
  const f = setup(t); const p = await preview(f); const original = f.job.sources[0].fingerprint;
  f.hooks.beforeSnapshot = slug => { if (slug === 'a' && f.data.get('new').some(row => row.enabled)) f.metadata.get('a').dependencies.grants = ['external-grant']; };
  await assert.rejects(migrate(f, p, [p.rows[0].key]), /资料|权限/);
  const job = f.store.get(f.job.id);
  assert.equal(job.sources[0].fingerprint, original); assert.deepEqual(job.snapshots[0].dependencies.grants, []);
  assert.equal(job.scheduleTransfer.status, 'attention'); assert.equal(f.data.get('new')[0].enabled, false);
});

test('unselected schedule changes are detected instead of being absorbed by post-cutover receipts', async t => {
  const f = setup(t); const p = await preview(f); const original = f.job.sources[1].fingerprint; let changed = false;
  f.hooks.beforeSnapshot = () => {
    if (!changed && f.data.get('new').some(row => row.enabled)) { changed = true; f.data.get('b').push({ ...f.data.get('b')[0], id: 'new-external', prompt: '用户新增', enabled: false }); }
  };
  await assert.rejects(migrate(f, p, [p.rows[0].key]), /例程清单/);
  assert.equal(f.store.get(f.job.id).sources[1].fingerprint, original);
  assert.equal(f.data.get('b').find(row => row.id === 'new-external').prompt, '用户新增');
});

test('running source discovered after copy creation blocks stopping old or enabling new', async t => {
  const f = setup(t); const p = await preview(f);
  f.hooks.beforeSnapshot = slug => { if (slug === 'a' && f.copies()) f.metadata.get('a').running = true; };
  await assert.rejects(migrate(f, p, [p.rows[0].key]), /运行任务/);
  assert.ok(!f.events.some(event => event[0] === 'update' && event[1] === 'a'));
  assert.equal(f.data.get('a')[0].enabled, true); assert.equal(f.data.get('new')[0].enabled, false);
});

test('copy creation crash is recovered only from one new disabled exact tuple, without creating another copy', async t => {
  const f = setup(t); const p = await preview(f); let checkpoint;
  // Native create() timestamps the actual write, which can happen well after a
  // preview under concurrent load. Exercise that gap deterministically.
  await new Promise(resolve => setTimeout(resolve, 25));
  f.hooks.afterCreate = () => { checkpoint = f.store.get(f.job.id); throw new Error('模拟创建后进程退出'); };
  await assert.rejects(migrate(f, p, [p.rows[0].key]), /模拟创建后/);
  assert.ok(checkpoint.scheduleTransfer.rows[0].copyIntent); assert.equal(checkpoint.scheduleTransfer.rows[0].newId, undefined);
  f.store.save(checkpoint); f.service.store = new JobStore(f.root); delete f.hooks.afterCreate;
  const result = await migrate(f);
  assert.equal(result.job.scheduleTransfer.status, 'complete'); assert.equal(f.copies(), 1);
});

test('ambiguous or missing crash copies stop without reconstructing or modifying unknown objects', async t => {
  for (const mode of ['missing', 'multiple']) {
    const f = setup(t); const p = await preview(f); let checkpoint;
    f.hooks.afterCreate = () => { checkpoint = f.store.get(f.job.id); throw new Error('crash'); };
    await assert.rejects(migrate(f, p, [p.rows[0].key]), /crash/);
    f.store.save(checkpoint); delete f.hooks.afterCreate;
    if (mode === 'missing') f.data.set('new', []);
    else f.data.get('new').push({ ...f.data.get('new')[0], id: 'ambiguous' });
    await assert.rejects(migrate(f), /唯一确认|不会自动重建/);
    assert.equal(f.copies(), 1); assert.equal(f.data.get('a')[0].enabled, true);
    assert.equal(f.store.get(f.job.id).scheduleTransfer.status, 'attention');
  }
});

test('failure stopping a later source restores earlier confirmed stops while keeping all copies disabled', async t => {
  const f = setup(t, { b: { enabled: true, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() } }); const p = await preview(f);
  f.hooks.beforeUpdate = (slug, _id, patch) => { if (slug === 'b' && patch.enabled === false) throw new Error('停止第二项失败'); };
  await assert.rejects(migrate(f, p), /停止第二项失败/);
  assert.equal(f.data.get('a')[0].enabled, true); assert.equal(f.data.get('b')[0].enabled, true);
  assert.ok(f.data.get('new').every(row => !row.enabled));
  assert.ok(!f.events.some(event => event[1] === 'new' && event[3]));
});

test('unknown stop outcome is not blindly restored and requires native inspection', async t => {
  const f = setup(t); const p = await preview(f);
  f.hooks.afterUpdate = (slug, _id, patch) => { if (slug === 'a' && patch.enabled === false) throw new Error('写入后失去回执'); };
  await assert.rejects(migrate(f, p, [p.rows[0].key]), /写入后失去回执/);
  assert.equal(f.data.get('a')[0].enabled, false); assert.equal(f.store.get(f.job.id).scheduleTransfer.status, 'attention');
  assert.ok(f.data.get('new').every(row => !row.enabled));
});

test('locked, unfinished and already fired once schedules are blocked by preview and cannot be selected through a request', async t => {
  for (const a of [{ locked: true }, { lastFiring: { state: 'pending' } }, { lastFiring: { state: 'observed' } }, { lastFiring: { state: 'coalesced' } }, { trigger: { kind: 'once', date: '2099-01-01', time: '09:00', timeZone: 'Asia/Shanghai' }, enabled: false, lastFiring: { state: 'handled' } }]) {
    const f = setup(t, { a }); const p = await preview(f); const row = p.rows.find(row => row.sourceSlug === 'a');
    assert.equal(row.blocked, true);
    await assert.rejects(migrate(f, p, [row.key]), /不属于可迁移/); assert.equal(f.copies(), 0);
  }
});

test('enabled schedules require a future verified run time outside the safety window', async t => {
  for (const nextRunAt of [undefined, 'invalid', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 30_000).toISOString()]) {
    const f = setup(t, { a: { nextRunAt } }); const p = await preview(f);
    assert.equal(p.rows.find(row => row.sourceSlug === 'a').blocked, true);
  }
});

test('a full native history page cannot prove that earlier firings are complete', async t => {
  for (const count of [19, 20]) {
    const f = setup(t, { a: { lastFiring: { state: 'handled' } }, aHistory: Array.from({ length: count }, (_, id) => ({ id, state: 'handled' })) });
    const p = await preview(f); const row = p.rows.find(row => row.sourceSlug === 'a');
    assert.equal(row.blocked, count === 20);
    if (count === 20) {
      assert.match(row.reason, /原生仅提供最近20次触发，无法确认更早未处理状态/);
      await assert.rejects(migrate(f, p, [row.key]), /不属于可迁移/); assert.equal(f.copies(), 0);
    }
  }
});

test('valid source titles at the native maximum length receive a bounded deterministic copy title', async t => {
  const f = setup(t, { a: { title: '长'.repeat(120) } }); const p = await preview(f);
  await migrate(f, p, [p.rows[0].key]); assert.ok(f.data.get('new')[0].title.length <= 120);
});
