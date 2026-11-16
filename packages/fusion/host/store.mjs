import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class JobStore {
  constructor(root) {
    this.root = root;
    this.locks = new Map();
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  path(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的融合任务');
    return join(this.root, `${id}.json`);
  }
  create(job) {
    return this.save({ ...job, id: randomUUID(), createdAt: new Date().toISOString() });
  }
  save(job) {
    job.updatedAt = new Date().toISOString();
    const path = this.path(job.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(job, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    return job;
  }
  get(id) {
    return JSON.parse(readFileSync(this.path(id), 'utf8'));
  }
  list() {
    return readdirSync(this.root).filter(p => /^[a-f0-9-]{36}\.json$/.test(p)).map(p => this.get(p.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  listSummaries() {
    return readdirSync(this.root).filter(p => /^[a-f0-9-]{36}\.json$/.test(p)).map(p => {
      const job = this.get(p.slice(0, -5));
      return Object.fromEntries(['id','name','status','summary','createdAt','updatedAt','avatarDataUrl','newBot','error'].filter(key => job[key] !== undefined).map(key => [key, job[key]]));
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async lock(id, action) {
    this.path(id);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    this.locks.set(id, result);
    try { return await result; }
    finally { if (this.locks.get(id) === result) this.locks.delete(id); }
  }
}

export function publicJob(job) {
  const { snapshots, plan, cleanupTokens, schedulePreview, ...result } = job;
  result.files = (job.files ?? []).map(({ path, encoding, content, sha256 }) => ({ path, encoding, sha256, size: Buffer.byteLength(content, encoding === 'base64' ? 'base64' : 'utf8'), ...(encoding === 'utf8' ? { content } : {}) }));
  return result;
}
