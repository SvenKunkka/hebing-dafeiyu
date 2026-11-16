import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value);
const canonical = value => JSON.stringify(value,(_key,item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const defaults = { maxTotalBytes: 512 * 1024 * 1024, maxFileBytes: 256 * 1024 * 1024, maxSessions: 1000, maxCatalogSessions: 20000, maxEvents: 1000000, maxAttachments: 10000, maxChannels:10000, maxChannelMessages:1000000 };
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const slugOf = source => source?.bot?.slug ?? source?.slug;
function limitsOf(input = {}) {
  const limits = { ...defaults, ...input };
  for (const [key, value] of Object.entries(limits)) if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) throw new Error('归档容量限制无效');
  return limits;
}
function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('归档路径无效');
  return value;
}
async function symlinkFree(candidate) {
  const absolute = path.resolve(candidate);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('归档路径不能包含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return absolute;
}
async function archiveLocation(dataRoot, jobId, slug) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/.test(jobId) || typeof slug !== 'string' || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('归档位置或机器人标识无效');
  const root = await symlinkFree(dataRoot);
  const home = await fs.realpath(homedir());
  if (root === path.parse(root).root || root === home) throw new Error('归档必须使用独立资料目录');
  for (const reserved of [path.join(home, '.dsh'),path.join(home, '.botharness'),'/Applications']) {
    let protectedRoot = reserved;
    try { protectedRoot = await fs.realpath(reserved); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (root === protectedRoot || inside(protectedRoot, root) || inside(root, protectedRoot)) throw new Error('归档不能写入生产资料目录');
  }
  const target = path.join(root, 'fusion-archives', jobId, slug);
  await symlinkFree(target);
  return { root, target, parent: path.dirname(target) };
}
async function sourceLocation(adapter,slug,dataRoot) {
  const requested=adapter.memoryRoot(slug);
  if (typeof requested!=='string' || !path.isAbsolute(requested)) throw new Error('来源 Memory 目录无效');
  const source=await symlinkFree(requested);
  const root=await fs.realpath(dataRoot);
  if (!inside(root,source) || await fs.realpath(source)!==source) throw new Error('来源 Memory 不属于同一独立资料目录');
  return source;
}
function gitEnv() { return { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }; }
const gitArgs = (root, args) => ['-c','gc.auto=0','-c','maintenance.auto=false','-c','core.fsmonitor=false','-C',root,...args];
async function git(root, args, signal) { return (await exec('git',gitArgs(root,args),{ env:gitEnv(), encoding:'utf8', maxBuffer:16*1024*1024, timeout:120000, signal })).stdout; }
async function gitOutput(root,args,consume,signal) {
  const bounded=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(120000)]);
  const child=spawn('git',gitArgs(root,args),{env:gitEnv(),stdio:['ignore','pipe','pipe'],signal:bounded});
  child.stderr.resume();
  const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Git 历史归档失败')));});
  void completed.catch(()=>{});
  try {const value=await consume(child.stdout);await completed;return value;}
  finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await completed.catch(()=>{});}
}
const diffArgs=['diff','--binary','--no-ext-diff','--no-textconv','HEAD','--'];
async function diffDigest(root,limits,signal) {
  return gitOutput(root,diffArgs,async chunks=>{
    const digest=createHash('sha256');let size=0;
    for await(const chunk of chunks){signal?.throwIfAborted();size+=chunk.length;if(size>limits.maxFileBytes||size>limits.maxTotalBytes)throw new Error('Git 工作区差异超过归档容量');digest.update(chunk);}
    return {sha256:digest.digest('hex'),size};
  },signal);
}
async function assertGitRoot(root) {
  const directory = path.join(root, '.git');
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('归档需要独立的 Git Memory 仓库');
  const pending = [directory];
  let count = 0;
  while (pending.length) for (const item of await fs.readdir(pending.pop(), { withFileTypes:true })) {
    if (++count > 100000) throw new Error('Git 元数据超过归档范围');
    const filename = path.join(item.parentPath ?? item.path, item.name);
    if (item.isSymbolicLink()) throw new Error('Git Memory 元数据不能包含符号链接');
    if (item.isDirectory()) pending.push(filename);
    if (['alternates','http-alternates','commondir'].includes(item.name) && (await fs.readFile(filename,'utf8')).trim()) throw new Error('共享 Git 对象或工作树不能独立归档');
  }
}
async function gitState(root, signal, limits=defaults) {
  const [head, refs, reflog, dirty, diff, shallow] = await Promise.all([
    git(root,['rev-parse','HEAD'],signal), git(root,['show-ref','--head'],signal),
    git(root,['reflog','show','--all','--date=iso-strict','--format=%H%x00%gD%x00%gs'],signal),
    git(root,['status','--porcelain=v1','-z','--untracked-files=all'],signal),
    diffDigest(root,limits,signal),
    git(root,['rev-parse','--is-shallow-repository'],signal),
  ]);
  if (shallow.trim() === 'true') throw new Error('浅克隆不能验证完整 Git 历史归档');
  return { head:head.trim(), refs, reflog, dirty, diffSha256:diff.sha256, diffSize:diff.size };
}
function sameGit(a,b) { return Object.keys(a).every(key => a[key] === b[key]); }
function makeBudget(limits) { return { total:0, events:0, limits }; }
async function writeBytes(root, relative, chunks, budget, files, signal) {
  safePath(relative);
  const filename = path.join(root,relative);
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const digest = createHash('sha256'); let size = 0;
  try {
    for await (const input of chunks) {
      signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      size += chunk.length; budget.total += chunk.length;
      if (size > budget.limits.maxFileBytes || budget.total > budget.limits.maxTotalBytes) throw new Error('归档超过容量上限，来源保持不变');
      await handle.writeFile(chunk); digest.update(chunk);
    }
    await handle.sync();
  } finally { await handle.close(); }
  const file = {path:relative,sha256:digest.digest('hex'),size}; files.push(file); return file;
}
async function bundleGit(sourceRoot, destinationRoot, budget, files, signal) {
  // Streaming the ordinary Git bundle to the private file bounds disk use even
  // when an existing Git history is larger than the permitted archive capacity.
  await gitOutput(sourceRoot,['bundle','create','-','--all','--reflog'],chunks=>writeBytes(destinationRoot,'git/history.bundle',chunks,budget,files,signal),signal);
  const bundle = path.join(destinationRoot,'git/history.bundle');
  await git(sourceRoot,['bundle','verify',bundle],signal);
  const restored = path.join(destinationRoot,'.verify-git');
  try {
    await exec('git',['-c','gc.auto=0','clone','--mirror',bundle,restored],{env:gitEnv(),maxBuffer:1024*1024,timeout:120000,signal});
    await git(restored,['fsck','--full','--no-dangling'],signal);
  } finally { await fs.rm(restored,{recursive:true,force:true}); }
}
async function catalog(ctx, roots, limits, signal) {
  if (!ctx?.sessionPersistence) throw new Error('Session 归档服务不可用');
  const rows = await ctx.sessionPersistence.list({signal});
  if (!Array.isArray(rows) || rows.length > limits.maxCatalogSessions) throw new Error('Session 目录超过归档范围');
  const byId = new Map();
  for (const row of rows) {
    if (typeof row?.header?.id !== 'string' || byId.has(row.header.id)) throw new Error('Session 目录身份无效');
    byId.set(row.header.id,row);
  }
  for (const id of roots) if (!byId.has(id)) throw new Error('来源关联 Session 不存在，不能完成归档');
  const selected = new Set(roots);
  let changed = true;
  while (changed) { changed = false; for (const row of rows) if (selected.has(row.header.parentSession) && !selected.has(row.header.id)) { selected.add(row.header.id); changed = true; } }
  if (selected.size > limits.maxSessions) throw new Error('来源后代 Session 超过归档范围');
  return [...selected].sort().map(id => byId.get(id));
}
function sameCatalog(a,b) { return a.length === b.length && a.every((row,i) => row.header.id === b[i].header.id && row.revision === b[i].revision && json(row.header) === json(b[i].header)); }
function refsInContent(content, refs) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!['image','file'].includes(block?.type) || !block.attachment || typeof block.attachment !== 'object') continue;
    const ref = block.attachment;
    if (typeof ref.attachmentId !== 'string' || !ref.attachmentId || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('Session 附件引用无效');
    const key = `${block.type}\0${ref.attachmentId}\0${block.type === 'file' ? ref.name : ''}`;
    const intrinsic = value => block.type === 'image' ? {attachmentId:value.attachmentId,bytes:value.bytes,mediaType:value.mediaType,width:value.width,height:value.height} : value;
    if (refs.has(key) && canonical(intrinsic(refs.get(key).ref)) !== canonical(intrinsic(ref))) throw new Error('同一附件引用的元数据不一致');
    if (!refs.has(key)) refs.set(key,{kind:block.type,ref});
  }
}
function refsInEvent(event, refs) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return;
  switch (event.type) {
    case 'user/message': case 'tool/ptc-dispatch': refsInContent(data.content,refs); return;
    case 'system/message': case 'developer/message': case 'tool/result': case 'team/message/queued': refsInContent(data.message?.content,refs); return;
    case 'agent/inbox/spliced': if (Array.isArray(data.inserted)) for (const message of data.inserted) refsInContent(message?.content,refs); return;
    case 'compaction/summary': refsInContent(data.summary,refs); refsInContent(data.rawOutput,refs); return;
    case 'assistant/message': refsInContent(data.message?.content,refs); break;
    case 'assistant/attempt': break;
    default: return;
  }
  if (Array.isArray(data.stream)) for (const row of data.stream) if (row?.type === 'chunk' && row.chunk?.type === 'block-end') refsInContent([row.chunk.block],refs);
}
async function* sessionChunks(ctx, row, metadata, budget, refs, signal, serializationVersion=2) {
  const handle = await ctx.sessionPersistence.open(row.header.id,'read',{signal});
  try {
    if (handle.header.id !== row.header.id || json(handle.header) !== json(row.header) || !Number.isSafeInteger(handle.inheritedEventCount) || handle.inheritedEventCount < 0) throw new Error('Session 读取身份或继承边界无效');
    metadata.id = handle.header.id; metadata.parentSession = handle.header.parentSession; metadata.inheritedEventCount = handle.inheritedEventCount;
    yield serializationVersion===1 ? `{"header":${json(handle.header)},"inheritedEventCount":${handle.inheritedEventCount},"events":[` : `{\n"header":${json(handle.header)},\n"inheritedEventCount":${handle.inheritedEventCount},\n"events":[\n`;
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const result = await handle.read(offset,512,{signal});
      if (!Array.isArray(result?.events)) throw new Error('Session 事件读取失败');
      if (!result.events.length) break;
      for (const event of result.events) {
        if (event.seq !== offset || ++budget.events > budget.limits.maxEvents) throw new Error('Session 事件序号或容量无效');
        refsInEvent(event,refs);
        if (refs.size > budget.limits.maxAttachments) throw new Error('Session 附件数量超过归档范围');
        yield `${offset ? serializationVersion===1?',':',\n' : ''}${json(event)}`;
        offset++;
      }
    }
    if (handle.inheritedEventCount > offset) throw new Error('Session 继承前缀超过完整事件数');
    metadata.eventCount = offset;
    yield serializationVersion===1 ? ']}\n' : '\n]}\n';
  } finally { await handle.close(); }
}
async function checkSnapshot(adapter, source) {
  const current = await adapter.snapshot(slugOf(source));
  if (current.fingerprint !== source.fingerprint || current.running) throw new Error('来源在归档期间发生变化或仍在运行，请重新预览');
  return current;
}
const rootsOf = snapshot => [...new Set(snapshot.dependencies?.sessions ?? [])].sort();
const uploadIdentity = ref => ref?.fileId ?? ref?.hash;
function uploadRef(ref,limits) {
  const identity=uploadIdentity(ref);
  if(!ref || typeof identity!=='string' || !identity || identity.length>256 || typeof ref.name!=='string' || !ref.name || ref.name.length>1024 || typeof ref.mime!=='string' || ref.mime.length>256 || !Number.isSafeInteger(ref.size) || ref.size<0 || ref.size>limits.maxFileBytes)throw new Error('原生 Bot 上传引用或容量无效');
  return ref;
}
function uploadFilename(name) {
  let leaf=name.normalize('NFC').replace(/[<>:"|?*\\/\x00-\x1f\x7f]/g,'_').replace(/^\.+/,'').replace(/[. ]+$/,'');
  const extension=leaf.match(/\.[a-z0-9]{1,12}$/i)?.[0]??'';
  let stem=extension?leaf.slice(0,-extension.length):leaf;
  while(Buffer.byteLength(stem)>180)stem=Array.from(stem).slice(0,-1).join('');
  leaf=`${stem||'upload'}${extension}`;
  return leaf;
}
function channelBytes(record,revision,entries) {
  return Buffer.from(`{\n"channel":${json(record)},\n"revision":${revision},\n"entries":[\n${entries.map(json).join(',\n')}\n]}\n`);
}
async function nativeCatalog(adapter,dataRoot,slug,sessionIds,limits,signal,{keepBytes=false}={}) {
  const core=typeof adapter.core==='function'?adapter.core():undefined;
  const channels=core?.channels;const attachments=core?.attachments;
  if(!channels || !['list','get','revision','readHumanJournalPage','attachmentReference'].every(method=>typeof channels[method]==='function') || !attachments || !['current','contentVersion','download'].every(method=>typeof attachments[method]==='function'))throw new Error('原生 Bot 频道与上传归档服务不可用');
  if(typeof attachments.rootDir!=='string' || !path.isAbsolute(attachments.rootDir) || !inside(await fs.realpath(dataRoot),await symlinkFree(attachments.rootDir)))throw new Error('原生 Bot 上传仓库不属于同一独立资料目录');
  const related=()=>{
    const records=channels.list();
    if(!Array.isArray(records) || records.length>limits.maxChannels)throw new Error('原生频道目录超过归档范围');
    const selected=records.filter(record=>!record.deletedAt && (record.botSlug===slug || Array.isArray(record.members)&&record.members.includes(slug))).sort((a,b)=>a.id.localeCompare(b.id));
    const ids=new Set();for(const record of selected){if(typeof record.id!=='string'||!record.id||ids.has(record.id))throw new Error('原生频道身份无效');ids.add(record.id);}
    return selected;
  };
  const selected=related();const archived=[];const uploads=new Map();let count=0;let bytes=0;let uploadBytes=0;let uploadMetadataBytes=0;
  for(const record of selected) {
    signal?.throwIfAborted();
    const revision=channels.revision(record.id);
    if(!Number.isSafeInteger(revision)||revision<0)throw new Error('原生频道版本无效');
    const entries=[];let before;
    for(;;) {
      const page=channels.readHumanJournalPage(record.id,{through:revision,before,limit:200});
      if(page===undefined){if(before!==undefined)throw new Error('原生频道可见性在归档期间发生变化');archived.push({channelId:record.id,recordSha256:hash(canonical(record)),revision,visibility:'not-visible'});break;}
      if(!Array.isArray(page.entries)||page.entries.length>200||typeof page.hasOlder!=='boolean')throw new Error('原生频道日志读取失败');
      if(page.hasOlder&&!page.entries.length)throw new Error('原生频道分页没有进展');
      let previous=0;
      for(const entry of page.entries) {
        if(entry.channelId!==record.id || !Number.isSafeInteger(entry.revision) || entry.revision<1 || entry.revision>revision || before!==undefined&&entry.revision>=before || entry.revision<=previous || typeof entry.message?.id!=='string')throw new Error('原生频道日志身份或版本无效');
        previous=entry.revision;
        if(++count>limits.maxChannelMessages)throw new Error('原生频道消息超过归档范围');
        bytes+=Buffer.byteLength(json(entry));if(bytes>limits.maxTotalBytes)throw new Error('原生频道日志超过归档容量');
        if(entry.message.attachments!==undefined&&!Array.isArray(entry.message.attachments))throw new Error('原生 Bot 上传列表无效');
        for(const original of entry.message.attachments??[]) {
          uploadRef(original,limits);
          const bound=channels.attachmentReference(record.id,entry.message.id,uploadIdentity(original));
          if(!bound)throw new Error('原生 Bot 上传没有对应的频道消息');
          const ref=uploadRef(attachments.current(bound),limits);
          if(uploadIdentity(ref)!==uploadIdentity(bound))throw new Error('原生 Bot 上传绑定校验失败');
          const key=canonical({identity:uploadIdentity(ref),name:ref.name});
          const sourceEventId=channels.humanSendStatus?.(record.id,entry.message.id)?.sourceEventId;
          const association={botSlug:slug,channelId:record.id,messageId:entry.message.id,revision:entry.revision,originalRef:original,...(typeof sourceEventId==='string'?{sourceEventId}:{})};
          const found=uploads.get(key);
          if(!found){uploadBytes+=ref.size;if(uploadBytes+bytes>limits.maxTotalBytes)throw new Error('原生 Bot 上传超过归档容量');}
          const contentVersion=found?.contentVersion??attachments.contentVersion(ref);
          if(typeof contentVersion!=='string'||!contentVersion||contentVersion.length>1024)throw new Error('原生 Bot 上传绑定校验失败');
          if(found&&(canonical(found.ref)!==canonical(ref)||found.contentVersion!==contentVersion))throw new Error('同一原生 Bot 上传版本不一致');
          if(found)found.associations.push(association);
          else uploads.set(key,{key,ref,contentVersion,associations:[association],associatedBotSessionIds:[...sessionIds],sessionAssociation:'同一机器人所属 Session；原生频道未提供逐文件的精确消费会话映射'});
          uploadMetadataBytes+=Buffer.byteLength(json(found?association:uploads.get(key)));if(uploadMetadataBytes>3*1024*1024)throw new Error('原生 Bot 上传索引超过归档容量');
          if(uploads.size>limits.maxAttachments)throw new Error('原生 Bot 上传数量超过归档范围');
        }
      }
      entries.unshift(...page.entries);
      if(!page.hasOlder) {
        const content=channelBytes(record,revision,entries);
        if(content.length>limits.maxFileBytes)throw new Error('原生频道日志超过单文件归档容量');
        archived.push({channelId:record.id,recordSha256:hash(canonical(record)),revision,visibility:'visible',path:`channels/${hash(record.id)}.json`,sha256:hash(content),size:content.length,messageCount:entries.length,...(keepBytes?{bytes:content}:{})});
        break;
      }
      const next=page.entries[0].revision;
      if(before!==undefined&&next>=before)throw new Error('原生频道分页没有进展');
      before=next;
    }
    if(channels.revision(record.id)!==revision||canonical(channels.get(record.id))!==canonical(record))throw new Error('原生频道在归档期间发生变化');
  }
  if(canonical(selected)!==canonical(related()))throw new Error('来源相关频道在归档期间发生变化');
  for(const item of uploads.values())item.associations.sort((a,b)=>`${a.channelId}:${a.messageId}:${a.revision}`.localeCompare(`${b.channelId}:${b.messageId}:${b.revision}`));
  const plain=archived.map(({bytes,...record})=>record);const uploadRows=[...uploads.values()].sort((a,b)=>a.key.localeCompare(b.key));
  return {channels:archived,uploads:uploadRows,signature:hash(canonical({channels:plain,uploads:uploadRows})),attachments};
}
async function fileDigest(filename, limit, signal) {
  const handle = await fs.open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash('sha256'); let size = 0;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('归档文件类型或容量无效');
    for await (const chunk of handle.createReadStream({autoClose:false})) { signal?.throwIfAborted(); size += chunk.length; if (size > limit) throw new Error('归档文件超过容量'); digest.update(chunk); }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) throw new Error('归档文件读取期间发生变化');
  } finally { await handle.close(); }
  return {sha256:digest.digest('hex'),size};
}
async function readSmall(filename, limit, signal) {
  const handle=await fs.open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks=[]; let size=0;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('归档清单类型无效');
    for await (const chunk of handle.createReadStream({autoClose:false})) {
      signal?.throwIfAborted(); size+=chunk.length;
      if (size>limit) throw new Error('归档清单超过容量');
      chunks.push(chunk);
    }
  } finally {await handle.close();}
  return Buffer.concat(chunks);
}

export async function verifySourceArchive({dataRoot,jobId,slug,sourceFingerprint,manifestSha256,ctx,adapter,source,signal,limits:inputLimits}) {
  const limits = limitsOf(inputLimits);
  const {target} = await archiveLocation(dataRoot,jobId,slug);
  const manifestFile = path.join(target,'manifest.json');
  await symlinkFree(manifestFile);
  const bytes = await readSmall(manifestFile,Math.min(4*1024*1024,limits.maxTotalBytes),signal);
  if (manifestSha256 && hash(bytes) !== manifestSha256) throw new Error('归档清单校验失败');
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1 || manifest.jobId !== jobId || manifest.slug !== slug || manifest.sourceFingerprint !== (sourceFingerprint ?? source?.fingerprint) || manifest.complete !== true || !Array.isArray(manifest.files) || !Array.isArray(manifest.sessions)) throw new Error('归档身份或覆盖范围不一致');
  const serializationVersion=manifest.serializationVersion??1;
  if(![1,2].includes(serializationVersion))throw new Error('归档序列化版本不受支持');
  if(serializationVersion===2&&(!Array.isArray(manifest.channels)||!Array.isArray(manifest.nativeBotUploads)||typeof manifest.nativeChannelFingerprint!=='string'))throw new Error('归档缺少原生频道与上传覆盖索引');
  if (manifest.files.length > limits.maxAttachments + limits.maxSessions + limits.maxChannels + 8) throw new Error('归档清单文件数超过范围');
  const names = new Set(); let total = bytes.length;
  for (const file of manifest.files) {
    const relative = safePath(file.path);
    if (names.has(relative)) throw new Error('归档清单路径重复'); names.add(relative);
    const filename = path.join(target,relative); await symlinkFree(filename);
    const actual = await fileDigest(filename,limits.maxFileBytes,signal); total += actual.size;
    if (total > limits.maxTotalBytes || actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error('归档文件校验失败');
  }
  if (manifest.git?.bundle !== 'git/history.bundle' || manifest.git.verified !== true || manifest.git.reflogIncluded !== true || !Array.isArray(manifest.rootSessionIds) || !Array.isArray(manifest.attachments) || !Array.isArray(manifest.unknowns) || manifest.unknowns.length) throw new Error('归档覆盖范围无效');
  for (const required of ['git/history.bundle','git/refs.txt','git/reflog.txt','git/working.diff','git/status.porcelain']) if (!names.has(required)) throw new Error('归档缺少 Git 恢复对象');
  const ids = new Set();
  for (const session of manifest.sessions) {
    if (ids.has(session.id)) throw new Error('归档 Session 身份重复'); ids.add(session.id);
  }
  for (const object of [...manifest.sessions,...manifest.attachments,...(manifest.channels??[]).filter(channel=>channel.visibility==='visible'),...(manifest.nativeBotUploads??[])]) {
    const file=manifest.files.find(file=>file.path===object.path);
    if (!file || file.sha256!==object.sha256 || file.size!==object.size) throw new Error('归档索引与恢复对象不一致');
  }
  if (ctx || adapter || source) {
    if (!ctx || !adapter || !source) throw new Error('归档实时校验需要完整来源与服务');
    const before = await checkSnapshot(adapter,source);
    if (json(rootsOf(before)) !== json(manifest.rootSessionIds)) throw new Error('来源关联 Session 已发生变化');
    const sourceRoot = await sourceLocation(adapter,slug,dataRoot); await assertGitRoot(sourceRoot);
    const initialGit = await gitState(sourceRoot,signal,limits);
    if (hash(initialGit.refs) !== manifest.git.refsSha256 || hash(initialGit.reflog) !== manifest.git.reflogSha256 || initialGit.diffSha256 !== manifest.git.diffSha256 || initialGit.head !== manifest.git.head) throw new Error('来源 Git 历史已发生变化');
    const rows = await catalog(ctx,rootsOf(before),limits,signal);
    if (json(rows.map(row => row.header.id)) !== json(manifest.sessions.map(session => session.id))) throw new Error('来源后代 Session 已发生变化');
    const native=await nativeCatalog(adapter,dataRoot,slug,rows.map(row=>row.header.id),limits,signal);
    if(serializationVersion===1&&native.channels.some(channel=>(channel.messageCount??0)>0))throw new Error('旧版档案未包含原生频道与上传文件，请重新创建融合预览');
    if(serializationVersion===2&&native.signature!==manifest.nativeChannelFingerprint)throw new Error('来源原生频道或上传文件已发生变化');
    const budget = makeBudget(limits); const refs = new Map();
    for (let i=0;i<rows.length;i++) {
      const digest = createHash('sha256'); let size = 0; const metadata = {};
      for await (const value of sessionChunks(ctx,rows[i],metadata,budget,refs,signal,serializationVersion)) { const chunk=Buffer.from(value); size+=chunk.length; budget.total+=chunk.length; if (size > limits.maxFileBytes || budget.total > limits.maxTotalBytes) throw new Error('Session 实时校验超过容量'); digest.update(chunk); }
      if (digest.digest('hex') !== manifest.sessions[i].sha256 || size !== manifest.sessions[i].size) throw new Error('来源 Session 日志已发生变化');
    }
    if (!sameCatalog(rows,await catalog(ctx,rootsOf(before),limits,signal)) || !sameGit(initialGit,await gitState(sourceRoot,signal,limits))) throw new Error('来源历史在校验期间发生变化');
    if(native.signature!==(await nativeCatalog(adapter,dataRoot,slug,rows.map(row=>row.header.id),limits,signal)).signature)throw new Error('来源原生频道或上传文件在校验期间发生变化');
    await checkSnapshot(adapter,source);
  }
  return {...manifest,root:target,manifestSha256:hash(bytes)};
}

const active = new Map();
export async function archiveSource(input) {
  const slug = slugOf(input.source);
  const {target,parent} = await archiveLocation(input.dataRoot,input.jobId,slug);
  if (active.has(target)) {
    const previous = active.get(target);
    if (previous.fingerprint !== input.source.fingerprint) throw new Error('同一归档正在处理不同来源版本');
    return previous.promise;
  }
  const promise = createArchive(input,{slug,target,parent});
  active.set(target,{fingerprint:input.source.fingerprint,promise});
  try { return await promise; } finally { if (active.get(target)?.promise === promise) active.delete(target); }
}
async function createArchive(input,{slug,target,parent}) {
  const {ctx,adapter,dataRoot,jobId,source,signal} = input;
  const limits = limitsOf(input.limits);
  let current = await checkSnapshot(adapter,source);
  const sourceRoot = await sourceLocation(adapter,slug,dataRoot); await assertGitRoot(sourceRoot);
  // This public native operation only prepares isolated Git recovery metadata.
  // Capturing it now prevents a first-observation checkpoint appearing after
  // restart and falling outside the archive's complete set of source refs.
  await adapter.prepareRecovery?.(slug);
  current = await checkSnapshot(adapter,source);
  try {
    await fs.lstat(target);
    return verifySourceArchive({dataRoot,jobId,slug,sourceFingerprint:source.fingerprint,ctx,adapter,source,signal,limits});
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rootSessionIds = rootsOf(current);
  const rows = await catalog(ctx,rootSessionIds,limits,signal);
  const initialGit = await gitState(sourceRoot,signal,limits);
  const native=await nativeCatalog(adapter,dataRoot,slug,rows.map(row=>row.header.id),limits,signal,{keepBytes:true});
  await fs.mkdir(parent,{recursive:true,mode:0o700}); await symlinkFree(parent);
  const stage = path.join(parent,`.${slug}.${randomUUID()}.partial`);
  await fs.mkdir(stage,{mode:0o700});
  const budget = makeBudget(limits); const files = []; const sessions = []; const attachments = []; const refs = new Map();const nativeBotUploads=[];
  try {
    await bundleGit(sourceRoot,stage,budget,files,signal);
    for (const [filename,content] of [['refs.txt',initialGit.refs],['reflog.txt',initialGit.reflog],['status.porcelain',initialGit.dirty]]) await writeBytes(stage,`git/${filename}`,[content],budget,files,signal);
    const diff=await gitOutput(sourceRoot,diffArgs,chunks=>writeBytes(stage,'git/working.diff',chunks,budget,files,signal),signal);
    if(diff.sha256!==initialGit.diffSha256||diff.size!==initialGit.diffSize)throw new Error('来源工作区在归档期间发生变化');
    for (const row of rows) {
      const metadata = {};
      const file = await writeBytes(stage,`sessions/${hash(row.header.id)}.json`,sessionChunks(ctx,row,metadata,budget,refs,signal),budget,files,signal);
      sessions.push({...metadata,...file});
    }
    if (refs.size && !ctx.attachments) throw new Error('Session 附件服务不可用，不能完成归档');
    for (const [key,{kind,ref}] of refs) {
      if (ref.bytes > limits.maxFileBytes || budget.total + ref.bytes > limits.maxTotalBytes) throw new Error('Session 附件超过归档容量');
      let chunks;
      if (kind === 'image') { const stored=await ctx.attachments.readImage(ref,signal); if (stored.ref.attachmentId !== ref.attachmentId) throw new Error('Session 图片引用校验失败'); chunks=[stored.data]; }
      else chunks=ctx.attachments.readFileStream(ref,signal);
      const file = await writeBytes(stage,`attachments/${kind}-${hash(key)}.bin`,chunks,budget,files,signal);
      const contentDigest = String(ref.attachmentId).replace(/^sha256:/,'');
      if (file.size !== ref.bytes || /^[a-f0-9]{64}$/.test(contentDigest) && file.sha256 !== contentDigest) throw new Error('Session 附件字节校验失败');
      attachments.push({kind,ref,...file});
    }
    if(refs.size+native.uploads.length>limits.maxAttachments)throw new Error('Session 与原生 Bot 上传总数超过归档范围');
    for(const channel of native.channels)if(channel.visibility==='visible') {
      const file=await writeBytes(stage,channel.path,[channel.bytes],budget,files,signal);
      if(file.sha256!==channel.sha256||file.size!==channel.size)throw new Error('原生频道日志归档校验失败');
    }
    for(const upload of native.uploads) {
      if(budget.total+upload.ref.size>limits.maxTotalBytes)throw new Error('原生 Bot 上传超过归档容量');
      const downloaded=await native.attachments.download(uploadIdentity(upload.ref),upload.ref.name,signal);
      try {
        if(canonical(downloaded.ref)!==canonical(upload.ref))throw new Error('原生 Bot 上传在读取期间发生变化');
        const file=await writeBytes(stage,`native-uploads/${hash(upload.key)}/${uploadFilename(upload.ref.name)}`,downloaded.body,budget,files,signal);
        const expected=upload.contentVersion.replace(/^sha256:/,'');
        if(file.size!==upload.ref.size||/^[a-f0-9]{64}$/.test(expected)&&file.sha256!==expected)throw new Error('原生 Bot 上传字节校验失败');
        nativeBotUploads.push({...upload,...file});
      } finally {if(typeof downloaded.body?.cancel==='function')await downloaded.body.cancel().catch(()=>{});}
    }
    if (!sameCatalog(rows,await catalog(ctx,rootSessionIds,limits,signal)) || !sameGit(initialGit,await gitState(sourceRoot,signal,limits))) throw new Error('来源历史在归档期间发生变化');
    if(native.signature!==(await nativeCatalog(adapter,dataRoot,slug,rows.map(row=>row.header.id),limits,signal)).signature)throw new Error('来源原生频道或上传文件在归档期间发生变化');
    await checkSnapshot(adapter,source);
    const manifest = {version:1,serializationVersion:2,jobId,slug,sourceFingerprint:source.fingerprint,createdAt:new Date().toISOString(),complete:true,rootSessionIds,files,sessions,attachments,channels:native.channels.map(({bytes,...channel})=>channel),nativeBotUploads,nativeChannelFingerprint:native.signature,git:{bundle:'git/history.bundle',head:initialGit.head,refsSha256:hash(initialGit.refs),reflogSha256:hash(initialGit.reflog),diffSha256:initialGit.diffSha256,verified:true,reflogIncluded:true,dirty:initialGit.dirty},coverage:{git:'本机全部引用及 reflog 可达对象；bundle 已镜像恢复并 fsck 验证',sessions:'关联原生 Session 与全部后代的完整逻辑日志，保留原始 header、继承边界与事件序号，每条事件单列一行',attachments:'DSH 已声明消息内容字段的附件引用，逐字节保存',nativeBotUploads:'原生 Bot 频道消息一级 attachments，经公开绑定与下载服务取得当前原文件字节；与 DSH 附件分别列出',channels:'仅来源参与且当前用户原生服务可见的完整频道消息；not-visible 频道明确列出，不扩大可见性',uploadSessionAssociation:'上传绑定原生频道与消息及可得的 sourceEventId；另列同机器人所属会话，不推定逐文件消费会话',opaqueEventPayloads:'插件或未知事件原样保存在日志中，不跟随其任意路径或未声明附件引用',workingTree:'当前文件原文由同一融合任务的来源快照保留，另存 tracked binary diff 与工作区状态'},unknowns:[]};
    const bytes = Buffer.from(json(manifest)+'\n');
    if (bytes.length > 4*1024*1024 || budget.total + bytes.length > limits.maxTotalBytes) throw new Error('归档清单超过容量');
    await fs.writeFile(path.join(stage,'manifest.json'),bytes,{flag:'wx',mode:0o600});
    await fs.rename(stage,target);
    return verifySourceArchive({dataRoot,jobId,slug,sourceFingerprint:source.fingerprint,manifestSha256:hash(bytes),signal,limits});
  } finally { await fs.rm(stage,{recursive:true,force:true}); }
}
