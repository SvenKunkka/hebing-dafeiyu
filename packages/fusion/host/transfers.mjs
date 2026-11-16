import { randomUUID } from 'node:crypto';
import { digest } from './merge.mjs';

const WINDOW_MS = 60_000;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const recipe = schedule => ({ title: schedule.title, prompt: schedule.prompt, trigger: schedule.trigger });
const keyOf = schedule => `${schedule.botSlug}:${schedule.id}`;
const list = (core, slug) => {
  const rows = core.schedules.list(slug);
  if (!Array.isArray(rows) || rows.some(row => row.botSlug !== slug || typeof row.id !== 'string') || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('原生例程清单身份无效');
  return structuredClone(rows).sort((a, b) => a.id.localeCompare(b.id));
};
const anchor = snapshot => digest(JSON.stringify(stable({
  bot: snapshot.bot, head: snapshot.head, dirty: snapshot.dirty, dependencies: snapshot.dependencies,
  files: snapshot.files.map(file => [file.path, file.sha256, file.size]), excluded: snapshot.excluded,
  protected: snapshot.protected, provisional: snapshot.provisional, standing: snapshot.standing,
})));
const attention = message => Object.assign(new Error(message), { transferAttention: true });

function firingBlock(core, slug, schedules) {
  for (const schedule of schedules) {
    const history = core.schedules.history?.(slug, schedule.id) ?? [];
    if (history.length >= 20) return '原生仅提供最近20次触发，无法确认更早未处理状态';
    if ([schedule.lastFiring, ...history].some(firing => firing && ['pending', 'observed'].includes(firing.state))) return '来源仍有未完成的例程触发';
    // A coalesced record can refer to an older admission outside the history page.
    if (schedule.lastFiring?.state === 'coalesced') return '合并的例程触发尚不能确认已完成';
  }
}

function timingBlock(schedule) {
  if (schedule.trigger?.kind === 'once' && schedule.lastFiring) return '已触发的一次性例程不会迁移或补跑';
  if (schedule.enabled) {
    const next = Date.parse(schedule.nextRunAt);
    if (!Number.isFinite(next)) return '启用例程缺少可核验的下次触发时间';
    if (next <= Date.now() + WINDOW_MS) return '下次触发已过期或不足 60 秒，请等待本次完成后重新预览';
  }
}

function newTitle(job, row) {
  const suffix = `（融合迁移 ${digest(`${job.id}:${row.key}`).slice(0, 8)}）`;
  let prefix = row.title.slice(0, 120 - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}

function replaceExpected(owner, result, previous) {
  const index = owner.expectedSchedules.findIndex(row => row.id === previous.id);
  if (index < 0 || result.id !== previous.id || result.botSlug !== owner.slug) throw attention('原生例程更新身份不符，请检查例程页');
  owner.expectedSchedules[index] = structuredClone(result);
  owner.expectedSchedules.sort((a, b) => a.id.localeCompare(b.id));
}

function change(core, owner, id, enabled) {
  const before = owner.expectedSchedules.find(row => row.id === id);
  if (!before || !same(list(core, owner.slug), owner.expectedSchedules)) throw attention('例程被外部修改，未执行写入');
  const result = core.schedules.update(owner.slug, id, { enabled }, 'human');
  if (!result || result.enabled !== enabled || !same(recipe(result), recipe(before)) || result.locked !== before.locked || result.creator !== before.creator) throw attention('例程更新未按确认内容完成');
  replaceExpected(owner, result, before);
  if (!same(list(core, owner.slug), owner.expectedSchedules)) throw attention('例程更新回读不符');
  return { before: structuredClone(before), after: structuredClone(result) };
}

async function checkOwner(service, core, owner, { fingerprint, allowPending = false } = {}) {
  const before = list(core, owner.slug);
  if (!same(before, owner.expectedSchedules)) throw attention('完整例程清单已变化，请保留全部机器人并重新检查');
  const snapshot = await service.adapter.snapshot(owner.slug);
  const after = list(core, owner.slug);
  if (!same(before, after) || anchor(snapshot) !== owner.anchor || snapshot.running || (!allowPending && firingBlock(core, owner.slug, after))) throw attention('机器人资料、权限、运行任务或例程触发已变化，切换已停止');
  if (fingerprint !== undefined && snapshot.fingerprint !== fingerprint) throw attention('机器人在预览期间发生变化，请重新预览');
  return snapshot;
}

async function checkTransfer(service, core, transfer) {
  const snapshots = [];
  for (const owner of transfer.sources) snapshots.push(await checkOwner(service, core, owner));
  const candidate = await checkOwner(service, core, transfer.candidate);
  for (const row of transfer.rows) if (timingBlock(row)) throw attention(timingBlock(row));
  return { snapshots, candidate };
}

export function schedulePreview(service, { id, behaviorConfirmed }) {
  return service.store.lock(id, async () => {
    const job = service.store.get(id);
    if (!job.verification?.ok || behaviorConfirmed !== true) throw new Error('请先完成新机器人资料和实际能力验收');
    if (job.scheduleTransfer && job.scheduleTransfer.status !== 'complete') throw new Error('已有例程切换记录，请继续该记录或在原生例程页检查');
    await service.assertCandidate(job); await service.assertSources(job);
    const core = service.adapter.core();
    const sources = job.sources.map(source => ({ slug: source.slug, anchor: anchor(job.snapshots.find(snapshot => snapshot.bot.slug === source.slug)), expectedSchedules: list(core, source.slug) }));
    const candidateSnapshot = await service.adapter.snapshot(job.newBot.slug);
    const candidate = { slug: job.newBot.slug, anchor: anchor(candidateSnapshot), expectedSchedules: list(core, job.newBot.slug) };
    for (const owner of sources) await checkOwner(service, core, owner, { fingerprint: job.sources.find(source => source.slug === owner.slug).fingerprint, allowPending: true });
    await checkOwner(service, core, candidate, { fingerprint: job.verification.candidateFingerprint });
    const rows = sources.flatMap(owner => {
      const source = job.sources.find(source => source.slug === owner.slug);
      const pending = firingBlock(core, owner.slug, owner.expectedSchedules);
      return owner.expectedSchedules.map(schedule => {
        const reason = source.protected ? '系统机器人例程保留在原位置' : schedule.locked ? '锁定的例程需要在原生例程页处理' : pending ?? timingBlock(schedule);
        return { key: keyOf(schedule), sourceSlug: source.slug, sourceName: source.displayName, ...structuredClone(schedule), blocked: Boolean(reason), reason };
      });
    });
    const token = randomUUID();
    job.schedulePreview = { token, at: Date.now(), rows, sources, candidate };
    service.store.save(job);
    return { token, rows, reason: '先建立暂停副本，再停止所选旧例程，最后启用原来已启用的新例程。不会补跑；周期例程会从新启用时重新计时，不能保留原周期相位。下次触发不足 60 秒时不能迁移。权限和账号不会继承。' };
  });
}

function recoverCopy(core, transfer, row) {
  const intent = row.copyIntent;
  const actual = list(core, transfer.candidate.slug);
  const known = actual.filter(schedule => intent.beforeIds.includes(schedule.id));
  const added = actual.filter(schedule => !intent.beforeIds.includes(schedule.id));
  if (!same(known, transfer.candidate.expectedSchedules) || added.length !== 1) throw attention('无法唯一确认中断前的例程副本，不会自动重建');
  const copy = added[0];
  if (digest(JSON.stringify(stable(intent.tuple))) !== intent.tupleDigest || !same(recipe(copy), recipe(intent.tuple)) || copy.enabled !== false || copy.locked !== false || copy.creator !== 'human' || copy.lastFiring || !Number.isFinite(Date.parse(copy.createdAt)) || Date.parse(copy.createdAt) < intent.at || copy.createdAt !== copy.updatedAt) throw attention('中断前的例程副本不符合创建意图，请在原生例程页检查');
  row.newId = copy.id; row.phase = 'copied';
  transfer.candidate.expectedSchedules.push(copy); transfer.candidate.expectedSchedules.sort((a, b) => a.id.localeCompare(b.id));
}

function reconcileCopies(service, core, job) {
  for (const row of job.scheduleTransfer.rows) if (!row.newId && row.copyIntent) {
    recoverCopy(core, job.scheduleTransfer, row); service.store.save(job);
  }
}

async function rollback(service, core, job) {
  const transfer = job.scheduleTransfer;
  let copiesPaused = true;
  try { reconcileCopies(service, core, job); } catch { copiesPaused = false; }
  if (!same(list(core, transfer.candidate.slug), transfer.candidate.expectedSchedules)) copiesPaused = false;
  for (const row of transfer.rows) {
    if (!row.newId) continue;
    try {
      const expected = transfer.candidate.expectedSchedules.find(schedule => schedule.id === row.newId);
      const actual = list(core, transfer.candidate.slug).find(schedule => schedule.id === row.newId);
      if (!expected || !same(actual, expected) || firingBlock(core, transfer.candidate.slug, [actual])) throw new Error('新例程状态未知');
      if (actual.enabled) { change(core, transfer.candidate, row.newId, false); service.store.save(job); }
      if (list(core, transfer.candidate.slug).find(schedule => schedule.id === row.newId)?.enabled !== false) throw new Error('新例程未暂停');
    } catch { copiesPaused = false; }
  }
  let restored = copiesPaused;
  if (copiesPaused) for (const row of transfer.rows) {
    if (row.stopIntent && !row.stopReceipt && !row.rollbackReceipt && !same(list(core, row.sourceSlug).find(schedule => schedule.id === row.id), row.stopIntent.before)) restored = false;
    if (!row.stopReceipt || row.stopReceipt.before.enabled !== true) continue;
    const owner = transfer.sources.find(source => source.slug === row.sourceSlug);
    try {
      const actual = list(core, owner.slug).find(schedule => schedule.id === row.id);
      if (!same(actual, row.stopReceipt.after) || !same(actual, owner.expectedSchedules.find(schedule => schedule.id === row.id))) throw new Error('旧例程已被外部修改');
      const receipt = change(core, owner, row.id, true);
      row.rollbackReceipt = receipt; delete row.stopReceipt; row.phase = 'copied'; service.store.save(job);
    } catch { restored = false; }
  }
  transfer.recovery = !copiesPaused ? '无法确认全部新副本已暂停；没有自动恢复旧例程，请在原生例程页检查'
    : restored ? '已暂停新副本，并恢复本事务确实停止且版本未变的旧项；周期例程从恢复启用时重新计时'
      : '新副本已暂停；存在外部变化或未知写入，没有覆盖这些旧例程，请在原生例程页检查';
  return restored;
}

export function migrateSchedules(service, { id, token, selectedKeys, acknowledgement }) {
  return service.store.lock(id, async () => {
    const job = service.store.get(id);
    if (!job.verification?.ok || acknowledgement !== job.name) throw new Error('请确认新机器人验收结果和准确名称');
    await service.assertCandidate(job, { allowScheduleChanges: Boolean(job.scheduleTransfer) });
    const core = service.adapter.core();
    if (job.scheduleTransfer?.status === 'complete') return { job };
    if (!job.scheduleTransfer) {
      const preview = job.schedulePreview;
      if (!preview?.sources || !preview.candidate || preview.token !== token || Date.now() - preview.at > 300000) throw new Error('例程切换预览已过期');
      if (!Array.isArray(selectedKeys) || !selectedKeys.length || new Set(selectedKeys).size !== selectedKeys.length || selectedKeys.some(key => typeof key !== 'string')) throw new Error('请选择需要迁移的例程');
      const chosen = selectedKeys.map(key => preview.rows.find(row => row.key === key));
      if (chosen.some(row => !row || row.blocked)) throw new Error('所选例程不属于可迁移清单');
      await service.assertSources(job);
      job.scheduleTransfer = { version: 2, status: 'preparing', startedAt: new Date().toISOString(), sources: structuredClone(preview.sources), candidate: structuredClone(preview.candidate), rows: chosen.map(row => ({ ...structuredClone(row), newTitle: newTitle(job, row), phase: 'pending' })) };
      service.store.save(job);
    }
    const transfer = job.scheduleTransfer;
    if (transfer.version !== 2 || !transfer.sources || !transfer.candidate) throw attention('旧版切换记录不能自动继续，请在原生例程页检查');
    try {
      reconcileCopies(service, core, job);
      await checkTransfer(service, core, transfer);
      for (const row of transfer.rows) {
        const copy = transfer.candidate.expectedSchedules.find(schedule => schedule.id === row.newId);
        if (copy?.enabled) { change(core, transfer.candidate, row.newId, false); service.store.save(job); }
      }
      await checkTransfer(service, core, transfer);
      for (const row of transfer.rows) {
        if (row.newId) continue;
        await checkTransfer(service, core, transfer);
        const tuple = { ...recipe(row), title: row.newTitle, enabled: false, locked: false };
        row.copyIntent = { beforeIds: list(core, job.newBot.slug).map(schedule => schedule.id), tuple, tupleDigest: digest(JSON.stringify(stable(tuple))), at: Date.now() };
        row.phase = 'copy-intent'; service.store.save(job);
        const copy = core.schedules.create(job.newBot.slug, tuple, 'human');
        row.newId = copy.id; row.phase = 'copied'; transfer.candidate.expectedSchedules.push(structuredClone(copy)); transfer.candidate.expectedSchedules.sort((a, b) => a.id.localeCompare(b.id));
        service.store.save(job);
        if (!same(recipe(copy), recipe(tuple)) || copy.creator !== 'human' || copy.enabled !== false || copy.locked !== false || !same(list(core, job.newBot.slug), transfer.candidate.expectedSchedules)) throw attention('新副本没有按确认内容创建');
      }
      await checkTransfer(service, core, transfer);
      transfer.status = 'stopping-old'; service.store.save(job);
      for (const row of transfer.rows) {
        await checkTransfer(service, core, transfer);
        const owner = transfer.sources.find(source => source.slug === row.sourceSlug);
        const old = owner.expectedSchedules.find(schedule => schedule.id === row.id);
        if (old.enabled) {
          delete row.rollbackReceipt;
          row.stopIntent = { before: structuredClone(old), at: Date.now() }; service.store.save(job);
          row.stopReceipt = change(core, owner, row.id, false); service.store.save(job);
        }
        row.phase = 'old-stopped'; service.store.save(job);
      }
      await checkTransfer(service, core, transfer);
      transfer.status = 'starting-new'; service.store.save(job);
      for (const row of transfer.rows) {
        await checkTransfer(service, core, transfer);
        const owner = transfer.sources.find(source => source.slug === row.sourceSlug);
        if (owner.expectedSchedules.find(schedule => schedule.id === row.id)?.enabled !== false) throw attention('旧例程尚未确认停止');
        if (row.enabled) {
          row.startIntent = { id: row.newId, at: Date.now() }; service.store.save(job);
          row.startReceipt = change(core, transfer.candidate, row.newId, true); service.store.save(job);
        }
        row.phase = 'complete'; service.store.save(job);
      }
      const checked = await checkTransfer(service, core, transfer);
      for (const snapshot of checked.snapshots) {
        job.sources.find(source => source.slug === snapshot.bot.slug).fingerprint = snapshot.fingerprint;
        job.snapshots.find(source => source.bot.slug === snapshot.bot.slug).fingerprint = snapshot.fingerprint;
      }
      job.verification.candidateFingerprint = checked.candidate.fingerprint;
      job.verification.behaviorConfirmed = false;
      transfer.status = 'complete'; transfer.completedAt = new Date().toISOString(); delete transfer.error;
      delete job.schedulePreview; service.store.save(job);
      return { job };
    } catch (error) {
      transfer.status = 'failed'; transfer.error = error.message;
      const restored = await rollback(service, core, job);
      if (!restored || error.transferAttention) transfer.status = 'attention';
      service.store.save(job);
      throw new Error(`${transfer.error}。${transfer.recovery}`);
    }
  });
}
