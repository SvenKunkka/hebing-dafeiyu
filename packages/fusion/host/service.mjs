import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BotAdapter } from './adapter.mjs';
import { avatar, buildPlan, digest, resolveFiles, standingWarnings } from './merge.mjs';
import { JobStore, publicJob } from './store.mjs';
import { listLocalSources, localSourceSnapshot, IMPORT_EXCLUSIONS } from './sources.mjs';
import { analyzeJob, validateProposal } from './analysis.mjs';
import { schedulePreview, migrateSchedules } from './transfers.mjs';
import { archiveSource, verifySourceArchive } from './archives.mjs';
import { archiveFiles } from './archive-files.mjs';

const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('请输入 1 至 80 字的机器人名字');
  return value.trim();
};
const permissionsDigest = value => digest(JSON.stringify(value ? { ...value, sessions: [] } : null));

export class FusionService {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.adapter = options.adapter ?? new BotAdapter(ctx);
    this.archiver = options.archiver ?? { create: archiveSource, verify: verifySourceArchive, files: archiveFiles };
    this.dataRoot = options.dataRoot ?? process.env.DSH_FORGE_DATA_ROOT;
    const home = process.env.DSH_FORGE_HOME;
    if (!this.dataRoot || !home || !ctx.botharness?.rootDir) throw new Error('Fusion 只能在独立的 DSH Forge 运行环境中启用');
    const requested = resolve(ctx.botharness.rootDir);
    const homeReal = realpathSync(home);
    let parent = requested;
    while (!existsSync(parent)) parent = dirname(parent);
    const target = join(realpathSync(parent), relative(parent, requested));
    const requestedDelta = relative(homeReal, target);
    if (!requestedDelta || requestedDelta.startsWith('..') || isAbsolute(requestedDelta)) throw new Error('机器人资料路径不属于独立运行环境');
    const parentDelta = relative(homeReal, realpathSync(parent));
    if (parentDelta.startsWith('..') || isAbsolute(parentDelta)) throw new Error('机器人资料目录不能重定向到其他位置');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const actual = realpathSync(target);
    const delta = relative(realpathSync(home), actual);
    if (delta.startsWith('..') || isAbsolute(delta) || actual === realpathSync(home)) throw new Error('机器人资料路径不属于独立运行环境');
    this.store = new JobStore(join(this.dataRoot, 'fusion-jobs'));
    this.analysisControllers = new Map();
    this.sourceHome = process.env.DSH_FORGE_SOURCE_HOME;
    for (const summary of this.store.listSummaries()) {
      const job = this.store.get(summary.id);
      let changed = false;
      if (job.analysis?.status === 'analyzing') { job.analysis = { ...job.analysis, status: 'failed', error: '运行环境已重启，请重新整理' }; changed = true; }
      if (job.status === 'creating') { job.status = 'failed'; job.error = '创建过程被中断，请重试同一任务'; changed = true; }
      if (job.status === 'cleaning') { job.status = 'partial'; changed = true; }
      if (changed) this.store.save(job);
    }
  }
  status() {
    const model = this.modelContext?.agentDefaultModel?.currentSelection?.();
    return { isolated: true, cleanupEnabled: true, version: '0.1.0', runtimeVersion: '0.2.1-rc.3', provider: model?.provider, model: model?.model, dataRoot: this.dataRoot, memoryRoot: this.ctx.botharness.rootDir, modelAvailable: Boolean(this.modelContext?.llm && model), exclusions: IMPORT_EXCLUSIONS };
  }
  async listBots() { return { bots: await this.adapter.listBots() }; }
  listJobs() { return { jobs: this.store.listSummaries() }; }
  getJob({ id }) { return { job: publicJob(this.store.get(id)) }; }
  analyze(input) { return analyzeJob(this, input); }
  schedulePreview(input) { return schedulePreview(this, input); }
  async migrateSchedules(input) { const { job } = await migrateSchedules(this, input); return { job: publicJob(job) }; }
  cancelAnalyze({ id }) {
    const controller = this.analysisControllers.get(id);
    if (controller) controller.abort(new Error('已停止智能整理'));
    return { cancelled: Boolean(controller) };
  }
  async listSources() { return { sources: this.sourceHome && existsSync(this.sourceHome) ? await listLocalSources(this.sourceHome) : [] }; }
  async importSource({ slug }) {
    if (!this.sourceHome) throw new Error('未配置本机 DSH 来源');
    const snapshot = await localSourceSnapshot(this.sourceHome, slug);
    const operationKey = `forge-import-${digest(`${slug}:${snapshot.fingerprint}`).slice(0,32)}`;
    const bot = await this.adapter.createBotFromFiles({ name: `${snapshot.bot.displayName}（副本）`, files: snapshot.files, avatar: snapshot.bot.avatar, operationKey });
    return { bot, coverage: '已导入身份与记忆资料；权限和历史聊天未迁入', excluded: snapshot.excluded };
  }
  async preview({ slugs, name }) {
    name = nameOf(name);
    if (!Array.isArray(slugs) || slugs.length < 2 || slugs.length > 12 || new Set(slugs).size !== slugs.length || slugs.some(s => typeof s !== 'string')) throw new Error('请选择 2 至 12 个不同的来源机器人');
    const snapshots = await Promise.all(slugs.map(slug => this.adapter.snapshot(slug)));
    if (snapshots.some(s => s.running)) throw new Error('来源机器人仍有运行中的任务，请先停止后再合成');
    const plan = buildPlan(snapshots);
    const portrait = avatar();
    const job = this.store.create({ status: 'draft', name, snapshots, plan, decisions: {}, avatarSeed: portrait.seed, avatarDataUrl: portrait.dataUrl,
      sources: snapshots.map(s => ({ slug: s.bot.slug, displayName: s.bot.displayName, fingerprint: s.fingerprint, head: s.head, fileCount: s.files.length, protected: Boolean(s.protected), excluded: s.excluded ?? [] })),
      conflicts: plan.conflicts, summary: `已读取 ${snapshots.length} 个机器人，${plan.uniqueFiles} 份不同文件；合并 ${plan.exactDuplicates} 份完全重复内容。`,
      warnings: ['原始资料快照与独立历史档案保存在融合记录；权限、账号和工作区不自动继承。', '原始聊天、附件与 Git 历史作为检索档案进入新机器人的知识目录，不拼接为新的原生会话。'], files: [],
    });
    await this.ensureArchives(job);
    return { job: publicJob(job) };
  }
  async ensureArchives(job) {
    job.archives ??= [];
    for (const source of job.snapshots) {
      if (job.archives.some(archive => archive.slug === source.bot.slug)) continue;
      const manifest = await this.archiver.create({ ctx: this.archiveContext, adapter: this.adapter, dataRoot: this.dataRoot, jobId: job.id, source });
      job.archives.push(manifest); this.store.save(job);
    }
    job.archivalComplete = job.archives.length === job.sources.length;
    this.store.save(job);
  }
  async assertArchives(job, { allowDeleted = false } = {}) {
    if (!job.archivalComplete || job.archives?.length !== job.sources.length) throw new Error('来源历史档案尚未完成，请保留来源并重新更新草案');
    for (const archive of job.archives) {
      const source = job.snapshots.find(snapshot => snapshot.bot.slug === archive.slug);
      const deleted = allowDeleted && (job.cleanup?.results?.some(result => result.slug === archive.slug && result.ok) || job.cleanup?.accepted?.[archive.slug]);
      await this.archiver.verify({ dataRoot: this.dataRoot, jobId: job.id, slug: archive.slug, sourceFingerprint: archive.sourceFingerprint, manifestSha256: archive.manifestSha256,
        ...(!deleted ? { ctx: this.archiveContext, adapter: this.adapter, source } : {}) });
    }
  }
  revise({ id, decisions, name, useAnalysis, regenerateAvatar, analysisEdits, conflictsReviewed }) {
    return this.store.lock(id, async () => {
      const job = this.store.get(id);
      if (this.analysisControllers.has(id)) throw new Error('智能整理进行中，请先停止或等待完成');
      if (!['draft','ready','failed'].includes(job.status) || job.newBot) throw new Error('此任务已创建候选，不能再修改草案');
      if (name !== undefined) job.name = nameOf(name);
      if (decisions !== undefined) {
        if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('冲突选择无效');
        for (const [key, value] of Object.entries(decisions)) {
          const conflict = job.conflicts.find(c => c.id === key);
          if (!conflict?.options.some(o => o.id === value)) throw new Error('冲突选择不属于当前草案');
        }
        job.decisions = { ...job.decisions, ...decisions };
      }
      if (analysisEdits !== undefined) {
        if (!job.analysis?.proposal) throw new Error('尚无可编辑的智能整理结果');
        const proposal = validateProposal(analysisEdits);
        if (job.analysis.proposal.conflicts.length > proposal.conflicts.length && conflictsReviewed !== true) throw new Error('请明确确认已处理智能整理列出的冲突');
        job.analysis = { ...job.analysis, proposal, conflictsReviewed: conflictsReviewed === true };
      }
      if (useAnalysis !== undefined) {
        if (useAnalysis && !job.analysis?.proposal) throw new Error('尚无智能整理结果');
        if (useAnalysis && job.analysis.proposal.conflicts.length) throw new Error('智能整理仍列有事实冲突，请先使用原文版本选择处理这些内容');
        job.useAnalysis = Boolean(useAnalysis);
      }
      if (regenerateAvatar) {
        const image = avatar(); job.avatarSeed = image.seed; job.avatarDataUrl = image.dataUrl;
      }
      const unresolved = job.conflicts.filter(c => !job.decisions[c.id]);
      if (!unresolved.length) {
        await this.ensureArchives(job);
        job.files = resolveFiles(job.plan, job.decisions, { name: job.name, analysis: job.useAnalysis ? job.analysis.proposal : undefined });
        job.files = this.archiver.files(job, job.archives);
        job.standingWarnings = standingWarnings(job.files);
        job.persona = job.files.find(f => f.path === 'SOUL.md')?.content ?? '';
        job.coreMemory = job.files.find(f => f.path === 'MEMORY.md')?.content ?? '';
        job.status = 'ready';
      } else { job.files = []; job.status = 'draft'; }
      job.revision = (job.revision ?? 0) + 1;
      return { job: publicJob(this.store.save(job)) };
    });
  }
  async assertSources(job, { allowDeleted = false } = {}) {
    for (const source of job.sources) {
      if (allowDeleted && job.cleanup?.results?.some(r => r.slug === source.slug && r.ok)) continue;
      let accepted = job.cleanup?.accepted?.[source.slug];
      const intent = job.cleanup?.intents?.[source.slug];
      if (allowDeleted && !accepted && intent) {
        const state = await this.adapter.deletionState(source.slug);
        if (state && state.eraseMemory === intent.eraseMemory && Date.parse(state.acceptedAt) >= intent.at) {
          job.cleanup.accepted ??= {}; job.cleanup.accepted[source.slug] = state; accepted = state;
          this.store.save(job);
        } else if (state) throw new Error('发现不属于本次确认范围的原生删除状态，请检查');
      }
      if (allowDeleted && accepted) {
        const current = await this.adapter.deletionState(source.slug);
        if (!current || current.acceptedAt !== accepted.acceptedAt || current.eraseMemory !== accepted.eraseMemory) throw new Error('原生删除状态与本任务不符，请保留其他来源并检查');
        continue;
      }
      const snapshot = await this.adapter.snapshot(source.slug);
      if (snapshot.fingerprint !== source.fingerprint || snapshot.running) throw new Error(`${source.displayName} 在预览后发生变化或仍在运行，请重新生成融合草案`);
    }
  }
  commit({ id }) {
    return this.store.lock(id, async () => {
      const job = this.store.get(id);
      if (this.analysisControllers.has(id)) throw new Error('智能整理进行中，请先停止或等待完成');
      if (['created','verified','cleaning','complete','partial'].includes(job.status)) return { job: publicJob(job) };
      if (!job.files?.length || job.conflicts.some(c => !job.decisions[c.id])) throw new Error('请先处理冲突并保存融合草案');
      await this.assertSources(job);
      await this.assertArchives(job);
      job.status = 'creating'; delete job.error; this.store.save(job);
      try {
        if (!job.newBot) {
          job.newBot = await this.adapter.createBotFromFiles({ name: job.name, files: job.files, avatar: job.avatarDataUrl, operationKey: `forge-fusion-${id}` });
          this.store.save(job);
        }
        job.status = 'created'; this.store.save(job);
        return { job: publicJob(job) };
      } catch (error) { job.status = 'failed'; job.error = error.message; this.store.save(job); throw error; }
    });
  }
  async candidateState(job) {
    if (!job.newBot) throw new Error('请先创建新机器人');
    let actual;
    try { actual = await this.adapter.snapshot(job.newBot.slug); }
    catch { throw new Error('新机器人已不可用，请保留来源并重新检查'); }
    const failures = job.files.filter(expected => !actual.files.some(file => file.path === expected.path && file.sha256 === expected.sha256)).map(f => f.path);
    const portrait = actual.bot.avatar ?? (await this.adapter.getBot(job.newBot.slug))?.avatar;
    if (portrait !== job.avatarDataUrl) failures.push('头像');
    if (actual.bot.displayName !== job.name) failures.push('名称');
    return { actual, failures };
  }
  async assertCandidate(job, { allowScheduleChanges = false } = {}) {
    const { actual, failures } = await this.candidateState(job);
    const stableCandidate =
      job.verification.candidateProfileDigest === digest(JSON.stringify(actual.bot)) &&
      job.verification.candidateFilesDigest === digest(JSON.stringify(actual.files.map(f => [f.path,f.sha256]))) &&
      job.verification.candidateDependenciesDigest === permissionsDigest(actual.dependencies);
    const ownScheduleChange = allowScheduleChanges && job.scheduleTransfer;
    const sessionsOnly = stableCandidate && (ownScheduleChange || job.verification.candidateSchedulesDigest === digest(JSON.stringify(actual.schedules ?? [])));
    if (failures.length || actual.running || (!sessionsOnly && job.verification.candidateFingerprint !== actual.fingerprint)) throw new Error('新机器人在验收后发生变化或仍在运行，请重新回读并验收；来源保持不变');
  }
  verify({ id }) {
    return this.store.lock(id, async () => {
      const job = this.store.get(id);
      const { actual, failures } = await this.candidateState(job);
      job.verification = { ok: failures.length === 0, candidateFingerprint: actual.fingerprint,
        candidateProfileDigest: digest(JSON.stringify(actual.bot)), candidateFilesDigest: digest(JSON.stringify(actual.files.map(f => [f.path,f.sha256]))), candidateDependenciesDigest: permissionsDigest(actual.dependencies), candidateSchedulesDigest: digest(JSON.stringify(actual.schedules ?? [])),
        checkedAt: new Date().toISOString(), filesChecked: job.files.length, failures, standingWarnings: standingWarnings(job.files), scope: '原生身份、头像与文件逐字节回读；聊天和工具能力请在新机器人内验收', behaviorConfirmed: false };
      if (job.status !== 'complete') job.status = failures.length ? 'created' : 'verified';
      this.store.save(job);
      return { job: publicJob(job) };
    });
  }
  cleanupPreview({ id, behaviorConfirmed }) {
    return this.store.lock(id, async () => {
      const job = this.store.get(id);
      if (job.scheduleTransfer && job.scheduleTransfer.status !== 'complete') throw new Error('例程切换尚未解决，请先检查迁移结果并恢复，不能清理来源');
      if (!job.verification?.ok) throw new Error('新机器人的资料回读尚未通过');
      if (behaviorConfirmed !== true && !job.verification.behaviorConfirmed) throw new Error('请在新机器人中完成实际能力验收后确认');
      await this.assertCandidate(job);
      await this.assertSources(job, { allowDeleted: true });
      await this.assertArchives(job, { allowDeleted: true });
      job.verification.behaviorConfirmed = true;
      const targets = [];
      for (const source of job.sources) {
        if (source.protected) throw new Error(`${source.displayName} 受保护，不能删除；本次合成会保留来源机器人`);
        if (job.cleanup?.results?.some(r => r.slug === source.slug && r.ok)) continue;
        if (job.cleanup?.accepted?.[source.slug]) {
          const state = await this.adapter.deletionState(source.slug);
          targets.push({ slug: source.slug, displayName: source.displayName, retry: true, native: { ...state, eraseAvailable: false, dependencies: [], token: 'accepted-native-deletion' } });
          continue;
        }
        const native = await this.adapter.deletionPreview(source.slug);
        targets.push({ slug: source.slug, displayName: source.displayName, native });
      }
      const token = randomUUID();
      job.cleanupTokens = { token, targets, at: Date.now() };
      this.store.save(job);
      return { allowed: true, token, targets: targets.map(({ native, ...target }) => ({ ...target, dependencies: native.dependencies, eraseAvailable: native.eraseAvailable })), acknowledgement: job.name,
        exclusions: [...new Set(['旧 Session 的原生身份、时间线与运行状态不转为新会话；原始日志、已声明附件及当前用户可见的 Bot 上传文件已归档', 'Git 全部本机引用及 reflog 可达历史已保存并验证；远程配置、登录与平台内部恢复检查点不迁入', 'Inbox、外部账号、IM 绑定、工作区授权与工具规则不迁入', '只有明确选定且回读成功的例程才会切换；删除会停止其余来源调度', ...job.sources.flatMap(s => s.excluded.filter(item => !['原生聊天与 Session 历史未迁入','Git 历史、分支与恢复检查点未迁入','账号、IM 绑定、权限、工作区授权和定时任务不自动继承'].includes(item)).map(item=>`${s.displayName}（${s.slug}）：${item}`)), ...job.archives.flatMap(archive=>(archive.channels??[]).filter(channel=>channel.visibility==='not-visible').map(channel=>`${job.sources.find(source=>source.slug===archive.slug)?.displayName??archive.slug}（${archive.slug}）：关联频道 ${channel.channelId} 对当前用户不可见，未归档该频道的消息或上传文件。`))])],
        reason: `仅删除当前独立工作区中的所选机器人；本机 DSH 原始来源不在删除范围内。${targets.some(t=>t.retry)?'已接受的删除会按上次确认的范围继续。':''}` };
    });
  }
  cleanup({ id, token, eraseMemory, acknowledgement, acknowledgeUnmigrated }) {
    return this.store.lock(id, async () => {
      const job = this.store.get(id);
      if (job.scheduleTransfer && job.scheduleTransfer.status !== 'complete') throw new Error('例程切换尚未解决，请先检查迁移结果并恢复，不能清理来源');
      if (!job.verification?.ok || !job.verification.behaviorConfirmed || acknowledgement !== job.name || !job.cleanupTokens || token !== job.cleanupTokens.token || Date.now() - job.cleanupTokens.at > 300000) throw new Error('删除确认已过期或信息不符，请重新预览');
      if (acknowledgeUnmigrated !== true) throw new Error('请明确确认未迁入资料与依赖影响');
      if (eraseMemory === true && job.cleanupTokens.targets.some(t => t.native.eraseAvailable !== true)) throw new Error('至少一个来源的记忆不能安全删除，请保留记忆');
      await this.assertCandidate(job);
      await this.assertSources(job, { allowDeleted: true });
      await this.assertArchives(job, { allowDeleted: true });
      job.status = 'cleaning'; job.cleanup ??= { results: [] }; job.cleanup.accepted ??= {}; job.cleanup.intents ??= {}; this.store.save(job);
      for (const target of job.cleanupTokens.targets) {
        if (job.cleanup.results.some(r => r.slug === target.slug && r.ok)) continue;
        try {
          if (target.retry) await this.adapter.deletionRetry(target.slug);
          else {
            job.cleanup.intents[target.slug] = { at: Date.now(), eraseMemory: eraseMemory === true };
            this.store.save(job);
            await this.adapter.deletionConfirm(target.slug, target.native.token, eraseMemory === true);
          }
          const state = await this.adapter.deletionState?.(target.slug);
          if (state) job.cleanup.accepted[target.slug] = state;
          if ((await this.adapter.listBots()).some(bot => bot.slug === target.slug)) throw new Error('删除后机器人仍在列表中');
          job.cleanup.results.push({ slug: target.slug, displayName: target.displayName, ok: true });
        } catch (error) {
          if (error.nativeDeletionAccepted && error.deletion) job.cleanup.accepted[target.slug] = error.deletion;
          job.cleanup.results.push({ slug: target.slug, displayName: target.displayName, ok: false, error: error.message });
        }
        this.store.save(job);
      }
      job.status = job.sources.every(source => job.cleanup.results.some(r => r.slug === source.slug && r.ok)) ? 'complete' : 'partial';
      delete job.cleanupTokens; this.store.save(job);
      return { job: publicJob(job) };
    });
  }
}
