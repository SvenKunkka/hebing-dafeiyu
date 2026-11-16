import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FusionService } from '../packages/fusion/host/service.mjs';
import { digest } from '../packages/fusion/host/merge.mjs';

function fixture({ protectedSource = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forge-workflow-'));
  const home = join(root, 'dsh-home'); const memoryRoot = join(home, 'botharness'); mkdirSync(memoryRoot, { recursive: true });
  process.env.DSH_FORGE_HOME = home;
  const records = new Map(); const operations = new Map();
  for (const slug of ['a','b','c']) records.set(slug, { bot: { slug, displayName: slug }, protected: slug === 'a' && protectedSource, files: [{ path: 'MEMORY.md', content: `Facts from ${slug}`, encoding: 'utf8', sha256: digest(`Facts from ${slug}`) }] });
  let creates = 0;
  let failAfterCreate = false;
  const adapter = {
    async snapshot(slug) { const snapshot = structuredClone(records.get(slug)); if (!snapshot) throw new Error('missing'); return { ...snapshot, fingerprint: digest(JSON.stringify(snapshot)), head: 'head', excluded: ['sessions'] }; },
    async listBots() { return [...records.values()].map(r => r.bot); },
    async getBot(slug) { return records.get(slug)?.bot; },
    async createBotFromFiles(input) {
      if (operations.has(input.operationKey)) return operations.get(input.operationKey);
      creates++;
      const bot = { slug: `candidate-${creates}`, displayName: input.name, avatar: input.avatar };
      records.set(bot.slug, { bot, files: input.files }); operations.set(input.operationKey, bot);
      if (failAfterCreate) { failAfterCreate = false; throw new Error('simulated disconnect after native commit'); }
      return bot;
    },
    async deletionPreview(slug) { if (records.get(slug)?.protected) throw new Error('protected-bot'); return { token: slug, eraseAvailable: true, dependencies: [] }; },
    async deletionConfirm(slug, token) { assert.equal(slug, token); records.delete(slug); },
  };
  const service = new FusionService({ botharness: { rootDir: memoryRoot } }, { dataRoot: root, adapter,
    archiver: { create:async ({source})=>({slug:source.bot.slug,sourceFingerprint:source.fingerprint,manifestSha256:'test',complete:true}), verify:async()=>{}, files:job=>job.files },
  });
  const ready = async () => {
    const { job } = await service.preview({ slugs: ['a','b','c'], name: 'Combined' });
    return (await service.revise({ id: job.id, decisions: Object.fromEntries(job.conflicts.map(c => [c.id,'merge'])) })).job;
  };
  return { service, records, ready, created: () => creates, disconnectNext: () => { failAfterCreate = true; } };
}

test('three-source workflow requires review, native readback, behavior acknowledgement and exact deletion confirmation', async () => {
  const f = fixture(); const job = await f.ready();
  await assert.rejects(f.service.cleanupPreview({ id: job.id, behaviorConfirmed: true }), /回读/);
  await Promise.all([f.service.commit({ id: job.id }), f.service.commit({ id: job.id })]);
  assert.equal(f.created(), 1);
  assert.equal((await f.service.verify({ id: job.id })).job.verification.ok, true);
  await assert.rejects(f.service.cleanupPreview({ id: job.id }), /实际能力/);
  const preview = await f.service.cleanupPreview({ id: job.id, behaviorConfirmed: true });
  await assert.rejects(f.service.cleanup({ id: job.id, token: preview.token, acknowledgement: 'wrong' }), /信息不符/);
  await assert.rejects(f.service.cleanup({ id: job.id, token: preview.token, acknowledgement: 'Combined' }), /未迁入/);
  const result = await f.service.cleanup({ id: job.id, token: preview.token, acknowledgement: 'Combined', eraseMemory: false, acknowledgeUnmigrated: true });
  assert.equal(result.job.status, 'complete');
  assert.equal((await f.service.listBots()).bots.length, 1);
});

test('a source change blocks creation and deletion, preserving all sources', async () => {
  const f = fixture(); const job = await f.ready();
  f.records.get('a').bot.description = 'changed after preview';
  await assert.rejects(f.service.commit({ id: job.id }), /发生变化/);
  assert.equal(f.created(), 0);
  assert.equal(f.records.size, 3);
});

test('a crash after native creation is recovered by persistent operation key', async () => {
  const f = fixture(); const job = await f.ready(); f.disconnectNext();
  await assert.rejects(f.service.commit({ id: job.id }), /disconnect/);
  await f.service.commit({ id: job.id });
  assert.equal(f.created(), 1);
  assert.equal(f.records.size, 4);
});

test('protected source cannot be deleted even by a constructed API call', async () => {
  const f = fixture({ protectedSource: true }); const job = await f.ready();
  await f.service.commit({ id: job.id }); await f.service.verify({ id: job.id });
  await assert.rejects(f.service.cleanupPreview({ id: job.id, behaviorConfirmed: true }), /受保护/);
  assert.equal(f.records.size, 4);
});

test('cleanup rechecks the candidate after preview and preserves every source when it changes', async () => {
  const f = fixture(); const job = await f.ready();
  const { job: created } = await f.service.commit({ id: job.id }); await f.service.verify({ id: job.id });
  const preview = await f.service.cleanupPreview({ id: job.id, behaviorConfirmed: true });
  f.records.get(created.newBot.slug).files[0].content = 'changed';
  f.records.get(created.newBot.slug).files[0].sha256 = digest('changed');
  await assert.rejects(f.service.cleanupPreview({ id: job.id, behaviorConfirmed: true }), /验收后发生变化/);
  await assert.rejects(f.service.cleanup({ id: job.id, token: preview.token, acknowledgement: 'Combined', acknowledgeUnmigrated: true }), /验收后发生变化/);
  assert.equal(f.records.size, 4);
  f.records.delete(created.newBot.slug);
  await assert.rejects(f.service.cleanupPreview({ id: job.id, behaviorConfirmed: true }), /不可用/);
  assert.equal(f.records.size, 3);
});

test('one analysis owns the draft until cancellation; duplicate calls and edits cannot race it', async () => {
  const f = fixture(); const job = await f.ready();
  let reachedModel;
  const atModel = new Promise(resolve => { reachedModel = resolve; });
  f.service.modelContext = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: { prepareCall: async (_config, signal) => {
      reachedModel();
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  };
  const pending = f.service.analyze({ id: job.id });
  const cancelled = assert.rejects(pending, /停止/);
  await atModel;
  await assert.rejects(f.service.analyze({ id: job.id }), /正在智能整理/);
  await assert.rejects(f.service.revise({ id: job.id, name: 'changed' }), /智能整理进行中/);
  await assert.rejects(f.service.commit({ id: job.id }), /智能整理进行中/);
  assert.equal(f.service.cancelAnalyze({ id: job.id }).cancelled, true);
  await cancelled;
  const current = f.service.store.get(job.id);
  assert.equal(current.status, 'ready'); assert.equal(current.name, 'Combined'); assert.equal(current.analysis.status, 'cancelled');
});

test('edited model conflicts require a specific acknowledgement and reject injected permissions', async () => {
  const f = fixture(); const job = await f.ready();
  const stored = f.service.store.get(job.id);
  stored.analysis = { status: 'ready', proposal: { persona: 'reviewed persona', memory: 'reviewed facts', notes: [], conflicts: ['A and B disagree'] } };
  f.service.store.save(stored);
  const edits = { persona: 'reviewed persona', memory: 'user resolved facts', notes: ['user checked sources'], conflicts: [] };
  await assert.rejects(f.service.revise({ id: job.id, analysisEdits: edits, useAnalysis: true }), /明确确认/);
  await assert.rejects(f.service.revise({ id: job.id, analysisEdits: { ...edits, grants: ['all'] }, conflictsReviewed: true }), /未允许/);
  const result = await f.service.revise({ id: job.id, analysisEdits: edits, conflictsReviewed: true, useAnalysis: true });
  assert.equal(result.job.persona, 'reviewed persona');
  assert.equal(result.job.coreMemory, 'user resolved facts');
});

test('behavior conversations may add candidate sessions but cannot silently add permissions', async () => {
  const f=fixture();const job=await f.ready();const created=(await f.service.commit({id:job.id})).job;
  const candidate=f.records.get(created.newBot.slug);candidate.dependencies={sessions:[],grants:[],channels:[]};
  await f.service.verify({id:job.id});candidate.dependencies.sessions.push('behavior-test');
  assert.equal((await f.service.cleanupPreview({id:job.id,behaviorConfirmed:true})).allowed,true);
  candidate.dependencies.grants.push('external-root');
  await assert.rejects(f.service.cleanupPreview({id:job.id,behaviorConfirmed:true}),/验收后发生变化/);
  assert.ok(f.records.has('a'));
});

test('constructed oversized or duplicate source selections fail before reading any source',async()=>{
  const f=fixture();let reads=0;f.service.adapter.snapshot=async()=>{reads++;throw new Error('should not read');};
  await assert.rejects(f.service.preview({slugs:Array.from({length:13},(_,i)=>`source-${i}`),name:'Bounded'}),/2 至 12/);
  await assert.rejects(f.service.preview({slugs:['a','a'],name:'Bounded'}),/不同/);
  assert.equal(reads,0);
});

test('unresolved schedule recovery blocks both cleanup preview and an existing deletion token', async () => {
  const f=fixture();const job=await f.ready();await f.service.commit({id:job.id});await f.service.verify({id:job.id});
  const preview=await f.service.cleanupPreview({id:job.id,behaviorConfirmed:true});
  const stored=f.service.store.get(job.id);stored.scheduleTransfer={status:'attention'};f.service.store.save(stored);
  await assert.rejects(f.service.cleanupPreview({id:job.id,behaviorConfirmed:true}),/例程切换尚未解决/);
  await assert.rejects(f.service.cleanup({id:job.id,token:preview.token,acknowledgement:'Combined',acknowledgeUnmigrated:true}),/例程切换尚未解决/);
  assert.ok(f.records.has('a'));
});

test('partial native deletion recovers after restart even if acceptance preceded the saved receipt', async () => {
  const f=fixture();const job=await f.ready();await f.service.commit({id:job.id});await f.service.verify({id:job.id});
  const states=new Map();const adapter=f.service.adapter;
  adapter.deletionState=async slug=>structuredClone(states.get(slug));
  adapter.deletionConfirm=async slug=>{
    const state={slug,acceptedAt:new Date().toISOString(),eraseMemory:false,phase:slug==='a'?'incomplete':'complete'};states.set(slug,state);f.records.delete(slug);
    if(slug==='a'){const error=new Error('native stop incomplete');Object.assign(error,{nativeDeletionAccepted:true,deletion:state});throw error;}
    return state;
  };
  adapter.deletionRetry=async slug=>{const state=states.get(slug);state.phase='complete';return structuredClone(state);};
  const first=await f.service.cleanupPreview({id:job.id,behaviorConfirmed:true});
  assert.equal((await f.service.cleanup({id:job.id,token:first.token,acknowledgement:'Combined',acknowledgeUnmigrated:true})).job.status,'partial');
  const interrupted=f.service.store.get(job.id);delete interrupted.cleanup.accepted.a;interrupted.status='cleaning';f.service.store.save(interrupted);
  const resumed=new FusionService(f.service.ctx,{dataRoot:f.service.dataRoot,adapter,archiver:f.service.archiver});
  const preview=await resumed.cleanupPreview({id:job.id,behaviorConfirmed:true});assert.deepEqual(preview.targets.map(t=>t.slug),['a']);
  assert.equal((await resumed.cleanup({id:job.id,token:preview.token,acknowledgement:'Combined',acknowledgeUnmigrated:true})).job.status,'complete');
  assert.equal(states.get('a').phase,'complete');
});

test('unreadable related channels are named as specific unmigrated data in deletion review', async () => {
  const f=fixture();const job=await f.ready();await f.service.commit({id:job.id});await f.service.verify({id:job.id});
  const stored=f.service.store.get(job.id);stored.archives[0].channels=[{channelId:'private-related-group',visibility:'not-visible'}];f.service.store.save(stored);
  const review=await f.service.cleanupPreview({id:job.id,behaviorConfirmed:true});
  assert.ok(review.exclusions.some(item=>item.includes('private-related-group')&&item.includes('a')&&item.includes('未归档')));
});
