import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { FusionService } from './service.mjs';

export const name = 'forge-fusion';
export const inject = ['botharness'];

// Explicit parameter names are the SRC gateway's wire contract. Keep request
// objects at the service boundary so validation has one implementation.
export class FusionRemote extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'forgeFusion', { namespace: 'forgeFusion' });
    this.fusion = new FusionService(ctx);
  }

  status() { return this.fusion.status({}); }
  listBots() { return this.fusion.listBots({}); }
  listJobs() { return this.fusion.listJobs({}); }
  preview(slugs, name) { return this.fusion.preview({ slugs, name }); }
  getJob(id) { return this.fusion.getJob({ id }); }
  revise(id, decisions, name, useAnalysis, regenerateAvatar, analysisEdits, conflictsReviewed) {
    return this.fusion.revise({ id, decisions, name, useAnalysis, regenerateAvatar, analysisEdits, conflictsReviewed });
  }
  analyze(id) { return this.fusion.analyze({ id }); }
  cancelAnalyze(id) { return this.fusion.cancelAnalyze({ id }); }
  commit(id) { return this.fusion.commit({ id }); }
  verify(id) { return this.fusion.verify({ id }); }
  schedulePreview(id, behaviorConfirmed) { return this.fusion.schedulePreview({ id, behaviorConfirmed }); }
  migrateSchedules(id, token, selectedKeys, acknowledgement) {
    return this.fusion.migrateSchedules({ id, token, selectedKeys, acknowledgement });
  }
  cleanupPreview(id, behaviorConfirmed) { return this.fusion.cleanupPreview({ id, behaviorConfirmed }); }
  cleanup(id, token, eraseMemory, acknowledgement, acknowledgeUnmigrated) {
    return this.fusion.cleanup({ id, token, eraseMemory, acknowledgement, acknowledgeUnmigrated });
  }
  importSource(slug) { return this.fusion.importSource({ slug }); }
  listSources() { return this.fusion.listSources({}); }
}

Object.defineProperty(
  FusionRemote.prototype,
  '@deepseek-ai/dsh-typert-protocol/remote-methods',
  {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        'status', 'listBots', 'listJobs', 'preview', 'getJob', 'revise', 'analyze', 'cancelAnalyze',
        'commit', 'verify', 'schedulePreview', 'migrateSchedules', 'cleanupPreview', 'cleanup', 'importSource',
        'listSources',
      ].map((method) => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  },
);

export function apply(ctx) {
  const remote = new FusionRemote(ctx);
  // Cordis 4 declares every named dependency as required. A child injection
  // makes model services optional for the fusion registry and file workflow.
  ctx.inject(['llm', 'agentDefaultModel'], (modelContext) => {
    remote.fusion.modelContext = modelContext;
    modelContext.effect(() => () => {
      if (remote.fusion.modelContext === modelContext) remote.fusion.modelContext = undefined;
    });
  });
  ctx.inject(['sessionPersistence', 'attachments'], (archiveContext) => {
    remote.fusion.archiveContext = archiveContext;
    archiveContext.effect(() => () => {
      if (remote.fusion.archiveContext === archiveContext) remote.fusion.archiveContext = undefined;
    });
  });
}
