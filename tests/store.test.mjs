import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore, publicJob } from '../packages/fusion/host/store.mjs';

test('a persisted task resumes without exposing raw source snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-store-'));
  const store = new JobStore(root);
  const job = store.create({ status: 'draft', snapshots: ['source'], cleanupTokens: ['native'], plan: {}, files: [] });
  assert.equal(new JobStore(root).get(job.id).status, 'draft');
  assert.equal(statSync(store.path(job.id)).mode & 0o777, 0o600);
  assert.ok(!('snapshots' in publicJob(job)));
  assert.ok(!('cleanupTokens' in publicJob(job)));
  assert.throws(() => store.get('../../private'));
});

test('concurrent requests to the same task execute in order and failure releases lock', async () => {
  const store = new JobStore(mkdtempSync(join(tmpdir(), 'forge-lock-')));
  const job = store.create({ files: [] });
  const order = [];
  await Promise.all([
    store.lock(job.id, async () => { await new Promise(resolve => setTimeout(resolve, 10)); order.push('first'); }),
    store.lock(job.id, () => order.push('second')),
  ]);
  assert.deepEqual(order, ['first','second']);
  await assert.rejects(store.lock(job.id, () => { throw new Error('test'); }));
  await store.lock(job.id, () => order.push('released'));
  assert.equal(order.at(-1), 'released');
});
