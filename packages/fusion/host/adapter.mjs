import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const inside = (root, target) => { const delta = relative(root, target); return delta !== '' && !delta.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && delta !== '..' && !isAbsolute(delta); };
const EXCLUSIONS = ['原生聊天与 Session 历史未迁入', 'Git 历史、分支与恢复检查点未迁入', '账号、IM 绑定、权限、工作区授权和定时任务不自动继承'];
const RECEIPT_PATH = '.forge/creation.json';
function canonicalCandidate(path) {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('无法确认独立资料目录');
    existing = parent;
  }
  return resolve(realpathSync(existing), relative(existing, absolute));
}

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new Error('不安全的记忆文件路径');
  const pieces = value.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..' || ['.git', '.botharness'].includes(piece.toLowerCase()))) throw new Error('不安全的记忆文件路径');
  return value;
}

function bytesOf(file) {
  if (!file || typeof file.content !== 'string') throw new Error('记忆文件内容无效');
  if (file.encoding === 'utf8') return Buffer.from(file.content, 'utf8');
  if (file.encoding !== 'base64' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error('记忆文件编码无效');
  return Buffer.from(file.content, 'base64');
}

function validateAvatar(avatar) {
  if (avatar === undefined) return;
  const match = typeof avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
  if (!match) throw new Error('头像必须是 PNG、JPEG 或 WebP 图片');
  const data = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'jpeg' ? data.subarray(0,3).equals(Buffer.from([255,216,255])) : data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP';
  if (!valid || data.length > 128 * 1024) throw new Error('头像无效或超过 128 KiB');
}

function publicDeletion(state) {
  if (!state) return undefined;
  return Object.fromEntries(['slug','acceptedAt','eraseMemory','phase','memory','cleanupAccepted'].filter(key => state[key] !== undefined).map(key => [key, state[key]]));
}

function incompleteDeletion(state) {
  const error = new Error(`原生机器人删除尚未完成（${state.phase ?? 'incomplete'}，记忆：${state.memory ?? 'pending'}）`);
  error.code = 'FORGE_NATIVE_DELETION_INCOMPLETE';
  error.nativeDeletionAccepted = true;
  error.deletion = publicDeletion(state);
  return error;
}

export class BotAdapter {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.home = options.home ?? process.env.DSH_FORGE_HOME;
    this.imports = new Map();
  }

  core() {
    const core = this.ctx.botharness;
    if (!core?.registry || !core.memory || !core.rootDir || !this.home) throw new Error('Fusion 需要独立的机器人运行环境');
    const home = realpathSync(this.home);
    const root = canonicalCandidate(core.rootDir);
    if (!inside(home, root)) throw new Error('机器人资料路径不属于独立运行环境');
    for (const protectedPath of [resolve(homedir(), '.dsh'), resolve(homedir(), '.botharness')]) {
      const protectedRoot = existsSync(protectedPath) ? realpathSync(protectedPath) : protectedPath;
      if (root === protectedRoot || inside(protectedRoot, root) || home === protectedRoot || inside(protectedRoot, home)) throw new Error('不能在生产 DSH 资料目录中进行融合');
    }
    mkdirSync(core.rootDir, { recursive: true, mode: 0o700 });
    if (realpathSync(core.rootDir) !== root) throw new Error('独立资料目录在初始化时发生变化');
    return core;
  }

  memoryRoot(slug) {
    const core = this.core();
    if (typeof slug !== 'string' || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !core.registry.get(slug)) throw new Error('机器人不存在');
    const path = core.registry.memoryDirFor(slug);
    if (!path || lstatSync(path).isSymbolicLink()) throw new Error('机器人记忆目录不可用');
    const real = realpathSync(path);
    if (!inside(realpathSync(core.rootDir), real)) throw new Error('机器人记忆目录不属于当前独立环境');
    return real;
  }

  protected(slug) { return this.core().tob?.isTob?.(slug) === true; }

  running(slug) {
    const core = this.core();
    const state = core.states?.snapshot?.(slug);
    return Boolean(core.runtime?.turnRunning?.(slug) || Object.values(state?.sessions ?? {}).some(value => value === 'thinking' || value === 'working' || value?.state === 'thinking' || value?.state === 'working'));
  }

  async listBots() {
    return this.core().registry.list().map(bot => ({ ...bot, protected: this.protected(bot.slug), running: this.running(bot.slug) }));
  }

  async getBot(slug) {
    this.memoryRoot(slug);
    const bot = this.core().registry.get(slug);
    return bot ? { ...bot, protected: this.protected(slug), running: this.running(slug) } : undefined;
  }

  git(root, args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async readFile(slug, path, root) {
    safePath(path);
    let probe = root;
    for (const part of path.split('/')) {
      probe = join(probe, part);
      if (lstatSync(probe).isSymbolicLink()) throw new Error('记忆文件包含符号链接');
    }
    if (!inside(root, realpathSync(probe))) throw new Error('记忆文件超出当前目录');
    const download = this.core().memory.downloadFile(slug, path);
    if (download.size > 100 * 1024 * 1024) throw new Error('单个记忆文件超过 100 MiB');
    const data = Buffer.from(await new Response(download.body).arrayBuffer());
    if (data.length !== download.size) throw new Error('记忆文件在读取期间变化，请重试');
    let encoding = 'utf8';
    let content;
    try { if (data.includes(0)) throw new Error('binary'); content = new TextDecoder('utf-8', { fatal: true }).decode(data); if (!Buffer.from(content).equals(data)) throw new Error('binary'); }
    catch { encoding = 'base64'; content = data.toString('base64'); }
    return { path, encoding, content, sha256: hash(data), size: data.length };
  }

  async snapshot(slug) {
    const core = this.core();
    const root = this.memoryRoot(slug);
    const record = core.registry.get(slug);
    const accepted = await core.memory.snapshot(slug);
    const gitBefore = { head: this.git(root, ['rev-parse', 'HEAD']).trim(), dirty: this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) };
    const included = new Set(this.git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
    const files = [];
    const excluded = [...EXCLUSIONS];
    for (const path of [...new Set(accepted.files)].sort()) {
      if (!included.has(path)) { excluded.push(`忽略文件：${path}`); continue; }
      if (path === RECEIPT_PATH) { excluded.push(`平台元数据：${path}`); continue; }
      if (path.split('/').some(piece => ['.git', '.botharness'].includes(piece.toLowerCase()))) { excluded.push(`平台元数据：${path}`); continue; }
      let safe = true;
      let probe = root;
      for (const part of path.split('/')) { probe = join(probe, part); if (lstatSync(probe).isSymbolicLink()) { safe = false; break; } }
      if (!safe) { excluded.push(`符号链接：${path}`); continue; }
      files.push(await this.readFile(slug, path, root));
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > 20000 || totalBytes > 100 * 1024 * 1024) throw new Error('机器人资料超过导入限制：100 MiB 或 20,000 个文件');
    for (const file of files) {
      if ((await this.readFile(slug, file.path, root)).sha256 !== file.sha256) throw new Error('机器人在快照期间变化，请停止任务后重试');
    }
    const after = { head: this.git(root, ['rev-parse', 'HEAD']).trim(), dirty: this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) };
    if (canonical(gitBefore) !== canonical(after) || canonical(record) !== canonical(core.registry.get(slug))) throw new Error('机器人在快照期间变化，请停止任务后重试');
    const dependencies = this.protected(slug) ? {
      sessions:[...new Set((core.ownership?.rootsFor?.(slug)??[]).flatMap(root=>[root.sessionId,...(core.ownership?.descendantsOf?.(root.sessionId)??[]).map(child=>child.sessionId)]))].sort(),
    } : core.deletions?.preview?.(slug)?.dependencies;
    const schedules = core.schedules?.list?.(slug) ?? [];
    const fingerprint = hash(canonical({ bot: record, root, ...after, files: files.map(({ path, sha256, size }) => ({ path, sha256, size })), excluded, dependencies, schedules }));
    return { bot: { ...record, persona: files.find(file => file.path === 'SOUL.md' && file.encoding === 'utf8')?.content ?? '' }, fingerprint, head: after.head, dirty: after.dirty, files, excluded, protected: this.protected(slug), running: this.running(slug), dependencies, schedules, provisional: accepted.provisional, standing: accepted.standing };
  }

  async createBot({ name, persona, description, coreMemory, avatar, operationKey }) {
    const core = this.core();
    validateAvatar(avatar);
    const result = await core.creations.create({ displayName: name, persona, description, coreMemory, avatar, workspaces: [] }, operationKey);
    this.memoryRoot(result.record.slug);
    await this.prepareRecovery(result.record.slug);
    core.live?.publishRosterCommitted();
    return { ...result.record, channelId: result.channelId };
  }

  async createBotFromFiles(input) {
    const core = this.core();
    const { files, avatar, operationKey } = input;
    const name = typeof input.name === 'string' ? input.name.trim() : input.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || !Array.isArray(files) || !files.length) throw new Error('新机器人或资料无效');
    if (typeof operationKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(operationKey)) throw new Error('创建操作标识无效');
    validateAvatar(avatar);
    const operationHash = hash(operationKey);
    const slug = `forge-${operationHash.slice(0, 32)}`;
    const entries = files.map(file => {
      const data = bytesOf(file);
      if (file.sha256 !== undefined && file.sha256 !== hash(data)) throw new Error('记忆文件内容校验失败');
      if (file.size !== undefined && file.size !== data.length) throw new Error('记忆文件长度校验失败');
      return { path: safePath(file.path), data };
    });
    if (new Set(entries.map(file => file.path)).size !== entries.length || entries.some(file => file.path === RECEIPT_PATH)) throw new Error('记忆文件路径重复或使用保留文件名');
    if (entries.length > 19999 || entries.reduce((sum, file) => sum + file.data.length, 0) > 100 * 1024 * 1024 - 4096) throw new Error('机器人资料超过导入限制');
    const digest = hash(canonical({ name, avatar, files: entries.map(file => ({ path: file.path, sha256: hash(file.data) })).sort((a,b) => a.path.localeCompare(b.path)) }));
    const receipt = { version: 1, operationHash, digest };
    const create = async () => {
      const existing = core.registry.getHistorical?.(slug) ?? core.registry.get(slug);
      if (existing) {
        if (!core.registry.get(slug)) throw new Error('此创建操作的机器人已删除，不能重复创建');
        const root = this.memoryRoot(slug);
        const marker = await this.readFile(slug, RECEIPT_PATH, root);
        if (marker.content !== JSON.stringify(receipt)) throw new Error('创建操作标识已用于不同资料');
        if (existing.displayName !== name || existing.avatar !== avatar) throw new Error('已有候选身份变化，请检查融合记录');
        await this.prepareRecovery(slug);
        const channel = core.channels.getOrCreateDm(slug, name);
        core.live?.publishRosterCommitted();
        return { ...existing, channelId: channel?.id };
      }
      const result = await core.registry.createFromFiles({ slug, displayName: name, avatar, workspaces: [], files: [...entries, { path: RECEIPT_PATH, data: Buffer.from(JSON.stringify(receipt)) }] });
      if (!result.ok) throw new Error(`机器人导入失败：${result.reason}`);
      this.memoryRoot(slug);
      await this.prepareRecovery(slug);
      const channel = core.channels.getOrCreateDm(slug, name);
      if (!channel) throw new Error('候选已建立但聊天未准备完成，请重试同一操作');
      core.live?.publishRosterCommitted();
      return { ...result.record, channelId: channel.id };
    };
    const active = this.imports.get(slug);
    if (active) {
      if (active.digest !== digest) throw new Error('创建操作标识已用于不同资料');
      return active.promise;
    }
    const pending = create();
    this.imports.set(slug, { digest, promise: pending });
    try { return await pending; } finally { this.imports.delete(slug); }
  }

  async writeFiles(slug, files) {
    const core = this.core();
    const root = this.memoryRoot(slug);
    for (const file of files) {
      safePath(file.path);
      if (file.encoding !== 'utf8') throw new Error('二进制资料需通过 createBotFromFiles 原样导入');
      const data = bytesOf(file);
      if (data.includes(0) || data.length > 1048576) throw new Error('文本记忆编辑超过 1 MiB 或包含 NUL');
      const existing = await core.memory.readAccepted(slug, file.path);
      if (existing?.body === file.content && !existing.binary) continue;
      const { head } = await core.memory.snapshot(slug);
      await core.memory.saveHuman({ botSlug: slug, path: file.path, body: file.content, expectedHead: head, editId: `forge-${hash(`${slug}:${file.path}:${hash(data)}`).slice(0,48)}` });
      const actual = await this.readFile(slug, file.path, root);
      if (actual.sha256 !== hash(data)) throw new Error('记忆写入回读失败');
    }
    return this.getBot(slug);
  }

  async prepareRecovery(slug) {
    // Native Memory lazily creates its first Git recovery checkpoint. Prepare
    // it inside this isolated runtime before archives freeze every Git ref;
    // neither the source documents nor their accepted HEAD are rewritten.
    const core=this.core();const root=this.memoryRoot(slug);
    if(typeof core.memory.recoveryHistory!=='function')throw new Error('原生记忆恢复基线服务不可用');
    const before=this.git(root,['rev-parse','HEAD']).trim();
    await core.memory.recoveryHistory(slug);
    if(this.git(root,['rev-parse','HEAD']).trim()!==before)throw new Error('准备恢复基线时来源版本发生变化');
  }

  async deletionPreview(slug) {
    this.memoryRoot(slug);
    if (this.protected(slug)) throw new Error('Tob 系统机器人受保护，不能删除');
    return this.core().deletions.preview(slug);
  }

  async deletionConfirm(slug, token, eraseMemory) {
    this.memoryRoot(slug);
    if (this.protected(slug)) throw new Error('Tob 系统机器人受保护，不能删除');
    const core = this.core();
    let result;
    try { result = await core.deletions.confirm(slug, token, eraseMemory === true); }
    catch (error) {
      const accepted = core.deletions.get?.(slug);
      if (accepted) throw incompleteDeletion(accepted);
      throw error;
    }
    if (result.phase !== 'complete') throw incompleteDeletion(result);
    return publicDeletion(result);
  }

  deletionRecord(slug) {
    const core = this.core();
    if (typeof slug !== 'string' || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('机器人标识无效');
    if (this.protected(slug)) throw new Error('Tob 系统机器人受保护，不能删除');
    const state = core.deletions.get(slug);
    if (!state) return undefined;
    if (state.slug !== slug || typeof state.memoryDir !== 'string' || !inside(realpathSync(core.rootDir), canonicalCandidate(state.memoryDir))) throw new Error('原生删除资料不属于当前独立环境');
    return state;
  }

  async deletionState(slug) {
    return publicDeletion(this.deletionRecord(slug));
  }

  async deletionRetry(slug) {
    if (!this.deletionRecord(slug)) throw new Error('原生删除尚未接受');
    const core = this.core();
    let result;
    try { result = await core.deletions.retry(slug); }
    catch (error) {
      const accepted = this.deletionRecord(slug);
      if (accepted) throw incompleteDeletion(accepted);
      throw error;
    }
    if (result.phase !== 'complete') throw incompleteDeletion(result);
    return publicDeletion(result);
  }
}
