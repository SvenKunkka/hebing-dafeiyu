import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { startRuntime } from '../electron/runtime.mjs';
import { localSourceSnapshot, IMPORT_EXCLUSIONS } from '../packages/fusion/host/sources.mjs';

// Source bodies stay in this local process and the authenticated loopback RPC.
// No prompt, source document, credential value or file path is logged/reported.
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const runId=randomUUID();
const dataRoot=path.join(projectRoot,'.runtime/import-smoke',runId);
const sourceHome=path.join(homedir(),'.dsh');
const reportPath=path.join(projectRoot,'.evidence/source-import.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={runId,startedAt:new Date().toISOString(),dataRoot,sourceHome,modelInvoked:false,sourceCoreOpened:false,permissionsOpened:false,sourceBodiesLogged:false,credentialsCopied:false,results:[],cleanup:[]};
const owned=new Set();let runtime;let cookie;let baselineBots=[];let before;let sources=[];
const allowed=new Set(['forgeFusion/status','forgeFusion/listSources','forgeFusion/importSource','forgeFusion/listBots','botharness/channelDm','botharness/memorySnapshot','botharness/memoryFileTarget','botharness/deletionPreview','botharness/deletionConfirm','botharness/deletionRetry']);

function safeReason(error) {
  const text=String(error?.message??'');
  if(/128 KiB|头像/.test(text))return '来源头像格式或大小不符合当前安全导入限制';
  if(/64 MiB|19,999|100 MiB|容量|导入限制/.test(text))return '来源资料超过当前安全导入容量或文件数限制';
  if(/符号链接|路径不可用|越出|来源路径|不安全/.test(text))return '来源路径没有通过隔离或符号链接检查';
  if(/发生变化|版本或资料/.test(text))return '检测到来源并发变化，未绕过一致性条件';
  if(/不存在|ENOENT/.test(text))return '来源或所需文件在验证时不可用';
  if(/摘要|文件|bytes|paths|digest/.test(text))return '原生副本的路径或字节摘要校验未通过';
  if(/模型|model/.test(text))return '无模型运行条件没有通过验证';
  return '操作未通过；报告已省略可能包含来源内容的错误详情';
}

async function rpc(method,args={}) {
  assert.ok(allowed.has(method));
  const response=await fetch(`${runtime.origin}/api/${method}`,{method:'POST',headers:{cookie,origin:runtime.origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}}),signal:AbortSignal.timeout(120000)});
  assert.equal(response.status,200,'local RPC failed');const envelope=await response.json();const result=envelope.result??envelope;
  if(result.ok!==true)throw new Error(result.error?.message??'local RPC failed');
  return result.value;
}

async function fileObservation(filename) {
  let handle;
  try {
    const entry=await fs.lstat(filename);if(entry.isSymbolicLink())return {exists:true,type:'symlink'};
    if(!entry.isFile())return {exists:true,type:'other'};
    handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const initial=await handle.stat();const digest=createHash('sha256');let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){digest.update(chunk);size+=chunk.length;}
    const final=await handle.stat();
    return {exists:true,type:'file',size,sha256:digest.digest('hex'),stableRead:initial.dev===final.dev&&initial.ino===final.ino&&initial.size===final.size&&initial.mtimeMs===final.mtimeMs&&initial.ctimeMs===final.ctimeMs&&size===final.size};
  } catch(error) {if(error.code==='ENOENT'||error.code==='ENOTDIR')return {exists:false};throw error;}
  finally {await handle?.close();}
}
async function metadataTree(root) {
  const records=[];const queue=[root];let count=0;
  while(queue.length) {
    const current=queue.pop();let entry;
    try{entry=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(++count>20000)throw new Error('metadata observation capacity exceeded');
    if(entry.isDirectory()&&!entry.isSymbolicLink()){for(const name of await fs.readdir(current))queue.push(path.join(current,name));}
    else records.push([path.relative(root,current),await fileObservation(current)]);
  }
  return records.sort((a,b)=>a[0].localeCompare(b[0]));
}
async function productionObservation(rows) {
  const observations={credentials:await fileObservation(path.join(sourceHome,'.credentials.yaml')),database:await fileObservation(path.join(sourceHome,'botharness/botharness.db')),wal:await fileObservation(path.join(sourceHome,'botharness/botharness.db-wal')),git:[]};
  for(const source of rows) {
    assert.match(source.slug,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const root=path.join(sourceHome,'botharness/bots',source.slug,'memory/.git');
    observations.git.push({slug:source.slug,index:await fileObservation(path.join(root,'index')),head:await fileObservation(path.join(root,'HEAD')),packedRefs:await fileObservation(path.join(root,'packed-refs')),refs:await metadataTree(path.join(root,'refs')),reflog:await metadataTree(path.join(root,'logs'))});
  }
  return observations;
}
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function observationSummary(initial,final) {
  const stable=value=>!JSON.stringify(value).includes('"stableRead":false');
  return {credentials:{unchangedInObservation:equal(initial.credentials,final.credentials),stableRead:stable([initial.credentials,final.credentials])},database:{unchangedInObservation:equal(initial.database,final.database),stableRead:stable([initial.database,final.database])},wal:{unchangedInObservation:equal(initial.wal,final.wal),stableRead:stable([initial.wal,final.wal])},git:initial.git.map(first=>{const last=final.git.find(row=>row.slug===first.slug);return {slug:first.slug,indexUnchangedInObservation:equal(first.index,last?.index),refsAndReflogUnchangedInObservation:equal([first.head,first.packedRefs,first.refs,first.reflog],[last?.head,last?.packedRefs,last?.refs,last?.reflog]),stableRead:stable([first,last])};}),interpretation:'仅为本次观察窗口；若有变化或读取期间漂移，不据此宣称生产文件字节不变，也不把变化自动归因于外部进程。脚本不打开来源Core，SQLite连接只读，Git扫描使用GIT_OPTIONAL_LOCKS=0，来源文件仅O_RDONLY/O_NOFOLLOW。'};
}
function exclusionCounts(excluded) {
  const prefixes={ignoredFiles:'忽略文件：',symlinks:'符号链接：',metadata:'平台元数据：',deletedFiles:'已删除文件：',nonRegularFiles:'非普通文件：'};
  return Object.fromEntries(Object.entries(prefixes).map(([key,prefix])=>[key,excluded.filter(value=>value.startsWith(prefix)).length]));
}

async function nativeDigests(bot) {
  const {channel}=await rpc('botharness/channelDm',{slug:bot.slug,displayName:bot.displayName});
  const {snapshot}=await rpc('botharness/memorySnapshot',{channelId:channel.id});const rows=[];
  const platformPath=name=>name.normalize('NFC').toLowerCase()==='.forge/creation.json'||name.split('/').some(part=>['.git','.botharness'].includes(part.normalize('NFC').toLowerCase()));
  const excludedNativeMetadataCount=snapshot.files.filter(platformPath).length;
  for(const filename of snapshot.files.filter(name=>!platformPath(name)).sort()) {
    const {target}=await rpc('botharness/memoryFileTarget',{slug:bot.slug,path:filename});
    const delta=path.relative(runtime.dshHome,target.path);
    assert.ok(delta&&!delta.startsWith('..')&&!path.isAbsolute(delta),'native copy path escaped private Home');
    const observed=await fileObservation(target.path);assert.equal(observed.stableRead,true,'native copy changed during reading');assert.equal(observed.type,'file');
    rows.push([filename,observed.sha256,observed.size]);
  }
  return {rows,excludedNativeMetadataCount};
}

try {
  runtime=await startRuntime({projectRoot,dataRoot,inheritModelConfig:false,startupTimeoutMs:120000});
  const auth=await fetch(runtime.url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
  cookie=auth.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');assert.ok(cookie&&[302,303].includes(auth.status));
  const status=await rpc('forgeFusion/status');assert.equal(status.isolated,true);
  report.defaultModelSelectionPresent=status.modelAvailable;report.modelAvailabilityInterpretation='默认选择/服务存在不等于具备凭证；本脚本不调用任何prompt、analyze或即时任务方法。';
  const inheritance=JSON.parse(await fs.readFile(path.join(dataRoot,'model-inheritance.json'),'utf8'));assert.equal(inheritance.credentialsCopied,false);
  const listing=await rpc('forgeFusion/listSources');sources=listing.sources.sort((a,b)=>a.displayName.localeCompare(b.displayName,'zh-CN'));
  report.listedSources=sources.map(({slug,displayName,available})=>({slug,displayName,available}));
  report.sourceCount=sources.length;assert.ok(sources.length,'no actual local sources found');
  baselineBots=(await rpc('forgeFusion/listBots')).bots.map(bot=>bot.slug);
  before=await productionObservation(sources);
  for(const source of sources) {
    const result={sourceSlug:source.slug,displayName:source.displayName,ok:false,excludedCategories:IMPORT_EXCLUSIONS};report.results.push(result);
    try {
      const initial=await localSourceSnapshot(sourceHome,source.slug);
      const imported=await rpc('forgeFusion/importSource',{slug:source.slug});
      assert.ok(imported.bot?.slug&&!baselineBots.includes(imported.bot.slug),'import must create a private copy');owned.add(imported.bot.slug);result.importedSlug=imported.bot.slug;
      const copy=(await rpc('forgeFusion/listBots')).bots.find(bot=>bot.slug===imported.bot.slug);assert.ok(copy);result.copyProtectedByNativeIdentity=copy.protected===true;
      const expected=initial.files.map(file=>[file.path,file.sha256,file.size]).sort((a,b)=>a[0].localeCompare(b[0]));
      const native=await nativeDigests(copy);const actual=native.rows.sort((a,b)=>a[0].localeCompare(b[0]));result.excludedNativeMetadataCount=native.excludedNativeMetadataCount;
      const latest=await localSourceSnapshot(sourceHome,source.slug);
      result.sourceStableAcrossImport=initial.fingerprint===latest.fingerprint;
      result.sourceFileCount=expected.length;result.importedFileCount=actual.length;result.totalBytes=expected.reduce((sum,file)=>sum+file[2],0);result.pathAndByteDigestsMatch=equal(expected,actual);result.excludedCounts=exclusionCounts(imported.excluded);
      assert.equal(result.sourceStableAcrossImport,true,'source changed across import');assert.equal(result.pathAndByteDigestsMatch,true,'native paths or byte digest mismatch');
      const repeated=await rpc('forgeFusion/importSource',{slug:source.slug});owned.add(repeated.bot.slug);result.idempotent=repeated.bot.slug===imported.bot.slug;assert.equal(result.idempotent,true);
      result.ok=true;
      console.log(JSON.stringify({sourceSlug:result.sourceSlug,displayName:result.displayName,importedSlug:result.importedSlug,fileCount:result.sourceFileCount,totalBytes:result.totalBytes,pathAndByteDigestsMatch:true}));
    } catch(error) {result.reason=safeReason(error);console.log(JSON.stringify({sourceSlug:source.slug,displayName:source.displayName,ok:false,reason:result.reason}));}
  }
  report.ok=report.results.length===sources.length&&report.results.every(result=>result.ok);
} catch(error) {report.ok=false;report.reason=safeReason(error);process.exitCode=1;}
finally {
  if(runtime) {
    try {
      for(const slug of owned) {
        const result={slug,ok:false};report.cleanup.push(result);
        try {
          const current=(await rpc('forgeFusion/listBots')).bots.find(bot=>bot.slug===slug);
          if(!current){result.ok=true;result.phase='already-absent';continue;}
          if(current.protected){result.reason='native system protection; no bypass attempted';continue;}
          const {preview}=await rpc('botharness/deletionPreview',{slug});assert.equal(preview.eraseAvailable,true);
          const erased=await rpc('botharness/deletionConfirm',{slug,token:preview.token,eraseMemory:true});
          assert.equal(erased.deletion.phase,'complete');assert.equal(erased.deletion.memory,'erased');result.ok=true;result.phase='complete';result.memory='erased';
        }catch(error){result.reason=safeReason(error);}
      }
      const bots=(await rpc('forgeFusion/listBots')).bots;
      report.remainingOwnedBots=bots.filter(bot=>owned.has(bot.slug)).map(bot=>({slug:bot.slug,protected:bot.protected===true}));
      report.unexpectedNewBots=bots.filter(bot=>!baselineBots.includes(bot.slug)&&!owned.has(bot.slug)&&!bot.protected).map(bot=>({slug:bot.slug}));
      if(report.cleanup.some(result=>!result.ok)||report.remainingOwnedBots.length||report.unexpectedNewBots.length)report.ok=false;
      if(before)report.productionObservation=observationSummary(before,await productionObservation(sources));
    }catch(error){report.ok=false;report.finalObservationReason=safeReason(error);}
    await runtime.stop();report.runtimeStopped=true;
  }
  report.finishedAt=new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  if(!report.ok)process.exitCode=1;
  console.log(JSON.stringify({ok:report.ok,sourceCount:report.sourceCount,passed:report.results.filter(result=>result.ok).length,remainingOwnedBots:report.remainingOwnedBots?.length??0,runtimeStopped:report.runtimeStopped,reportPath}));
}
