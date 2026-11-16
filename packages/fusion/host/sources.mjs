import { constants, existsSync, openSync, closeSync, fstatSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, safePath } from './merge.mjs';

export const IMPORT_EXCLUSIONS = ['聊天与原生 Session', 'Inbox 和运行中任务', 'Git 历史、分支和恢复检查点', '外部账号、模型凭证与 IM 绑定', '工作区授权、工具规则与定时任务', '被 Git 忽略的文件、符号链接和平台元数据'];
const validSlug = slug => typeof slug === 'string' && slug.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
const pathKey = path => path.normalize('NFC').toLowerCase();
const metadata = path => path.split('/').some(part => ['.git','.botharness'].includes(pathKey(part))) || pathKey(path) === '.forge/creation.json';
const same = (a,b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function memoryPath(home, slug) {
  if (!validSlug(slug)) throw new Error('无效的来源机器人');
  let path = home;
  for (const piece of ['', 'botharness', 'bots', slug, 'memory']) {
    if (piece) path = join(path, piece);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('来源记忆目录包含符号链接或不是目录');
  }
  const delta = relative(realpathSync(home), realpathSync(path));
  if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw new Error('来源路径越出机器人记忆目录');
  return path;
}

function fileState(root, path) {
  safePath(path);
  let full = root;
  for (const piece of path.split('/')) {
    full = join(full, piece);
    if (lstatSync(full).isSymbolicLink()) return { kind: 'symlink' };
  }
  const delta = relative(realpathSync(root), realpathSync(full));
  if (!delta || delta === '..' || delta.startsWith('../') || isAbsolute(delta)) throw new Error('来源文件越出机器人记忆目录');
  const info = lstatSync(full);
  return { kind: info.isFile() ? 'file' : 'other', full, info };
}

export async function listLocalSources(home) {
  const database = join(home, 'botharness', 'botharness.db');
  if (!existsSync(database)) return [];
  if (lstatSync(database).isSymbolicLink()) throw new Error('来源数据库不能是符号链接');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const hasDeletions = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='persona_bot_deletions'").get());
    const query = hasDeletions ? 'SELECT b.slug,b.body FROM persona_bots b WHERE NOT EXISTS (SELECT 1 FROM persona_bot_deletions d WHERE d.slug=b.slug)' : 'SELECT slug,body FROM persona_bots';
    return db.prepare(query).all().filter(row => validSlug(row.slug)).map(row => {
      const record = JSON.parse(row.body);
      let available = true;
      try { memoryPath(home, row.slug); } catch { available = false; }
      return { slug: row.slug, displayName: record.displayName, description: record.description ?? '', avatar: record.avatar, available, recordFingerprint: digest(row.body), coverage: '身份与记忆资料副本', excluded: IMPORT_EXCLUSIONS };
    });
  } finally { db.close(); }
}

export async function localSourceSnapshot(home, slug, io = {}) {
  if (!validSlug(slug)) throw new Error('无效的来源机器人');
  const source = (await listLocalSources(home)).find(s => s.slug === slug);
  if (!source?.available) throw new Error('本机来源不存在或记忆路径不可用');
  const memoryRoot = memoryPath(home, slug);
  const rootIdentity = lstatSync(memoryRoot);
  const git = args => execFileSync('git', ['-C', memoryRoot, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const scan = () => ({ head: git(['rev-parse', 'HEAD']).trim(), dirty: git(['status', '--porcelain=v1', '-z', '--untracked-files=all']), paths: [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort() });
  const before = scan();
  const ignored = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard']).split('\0').filter(Boolean).sort();
  const excluded = [...IMPORT_EXCLUSIONS, ...ignored.map(path => `忽略文件：${path}`)];
  const read = io.readFile ?? readFileSync;
  const readSafe = path => {
    const state = fileState(memoryRoot, path);
    if (state.kind !== 'file') return state;
    if (state.info.size > 64 * 1024 * 1024) throw new Error('来源资料超过本次导入的 64 MiB 限制，请先分批整理');
    const fd = openSync(state.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!same(state.info, fstatSync(fd))) throw new Error('读取时来源发生变化，请重试');
      const data = read(fd);
      const after = fileState(memoryRoot, path);
      if (after.kind !== 'file' || !same(state.info, after.info) || !same(state.info, fstatSync(fd)) || data.length !== state.info.size) throw new Error('读取时来源发生变化，请重试');
      return { ...state, data };
    } finally { closeSync(fd); }
  };
  let total = 0;
  const files = [];
  for (const path of before.paths) {
    if (metadata(path)) { excluded.push(`平台元数据：${path}`); continue; }
    let current;
    try { current = readSafe(path); }
    catch (error) { if (error.code === 'ENOENT') { excluded.push(`已删除文件：${path}`); continue; } throw error; }
    if (current.kind !== 'file') { excluded.push(`${current.kind === 'symlink' ? '符号链接' : '非普通文件'}：${path}`); continue; }
    const { data } = current;
    total += data.length;
    if (total > 64 * 1024 * 1024 || files.length >= 19999) throw new Error('来源资料超过本次导入的 64 MiB 或 19,999 个文件限制，请先分批整理');
    const text = data.toString('utf8');
    const isText = !data.includes(0) && Buffer.from(text).equals(data);
    files.push({ path, encoding: isText ? 'utf8' : 'base64', content: isText ? text : data.toString('base64'), sha256: digest(data), size: data.length });
  }
  for (const file of files) {
    const current = readSafe(file.path);
    if (current.kind !== 'file' || digest(current.data) !== file.sha256) throw new Error('读取时来源发生变化，请重试');
  }
  const after = scan();
  const latest = (await listLocalSources(home)).find(s => s.slug === slug);
  memoryPath(home, slug);
  const latestRoot = lstatSync(memoryRoot);
  if (JSON.stringify(before) !== JSON.stringify(after) || rootIdentity.dev !== latestRoot.dev || rootIdentity.ino !== latestRoot.ino || !latest?.available || latest.recordFingerprint !== source.recordFingerprint) throw new Error('读取时来源版本或资料发生变化，请重试');
  return { bot: source, files, head: before.head, dirty: before.dirty, fingerprint: digest(JSON.stringify({ source, memoryRoot: realpathSync(memoryRoot), ...before, files: files.map(f => [f.path,f.sha256]), excluded })), excluded };
}
