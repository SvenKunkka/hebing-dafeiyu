import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { startRuntime, redactRuntimeLog } from '../electron/runtime.mjs';
import { execFileSync } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createCore } from '@botharness/core';
import { avatar } from '../packages/fusion/host/merge.mjs';

// This acceptance test creates and deletes only its own synthetic Bots in a
// separate runtime. It never calls the production-source import endpoints.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = path.join(projectRoot, '.runtime/integration');
const reportPath = path.join(projectRoot, '.evidence/integration.json');
const runId = randomUUID();
const report = { runId, startedAt: new Date().toISOString(), dataRoot, syntheticOnly: true, productionBotImport: false, tokenPersisted: false, checks: [] };
const owned = new Set();
const samples = Buffer.from([0,255,1,128,9,10,13,4,0,240,159]);
let runtime;
let cookie;
let historicalFixture;
let nativeUploadFixture;

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, input] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(filename.length,26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); directory.writeUInt16LE(0x800,8);
    directory.writeUInt32LE(crc,16); directory.writeUInt32LE(data.length,20); directory.writeUInt32LE(data.length,24); directory.writeUInt16LE(filename.length,28); directory.writeUInt32LE(offset,42);
    chunks.push(local, filename, data); central.push(directory, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length,8); end.writeUInt16LE(Object.keys(files).length,10);
  end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks, directory, end]);
}

function check(name, details = {}) { report.checks.push({ name, ok: true, ...details }); console.log(`PASS ${name}`); }

async function start() {
  runtime = await startRuntime({ projectRoot, dataRoot, inheritModelConfig: true, startupTimeoutMs: 120000 });
  const auth = await fetch(runtime.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  cookie = auth.headers.getSetCookie().map(value => value.split(';',1)[0]).join('; ');
  assert.ok(cookie && [302,303].includes(auth.status), 'private runtime must issue an authenticated session');
  const page = await fetch(new URL(auth.headers.get('location') ?? '/', runtime.origin), { headers: { cookie }, signal: AbortSignal.timeout(15000) });
  assert.equal(page.status, 200);
  return runtime;
}

const methods = new Set(['forgeFusion/status','forgeFusion/listBots','forgeFusion/listJobs','forgeFusion/preview','forgeFusion/getJob','forgeFusion/revise','forgeFusion/analyze','forgeFusion/commit','forgeFusion/verify','forgeFusion/schedulePreview','forgeFusion/migrateSchedules','forgeFusion/cleanupPreview','forgeFusion/cleanup','botharness/get','botharness/list','botharness/channelDm','botharness/memorySnapshot','botharness/memoryFile','botharness/memoryFileTarget','botharness/scheduleCreate','botharness/scheduleList','botharness/deletionPreview','botharness/deletionConfirm','botharness/deletionRetry']);
async function rpc(method, args = {}) {
  assert.ok(methods.has(method), 'integration RPC method must be explicitly allowed');
  const response = await fetch(`${runtime.origin}/api/${method}`, {
    method: 'POST', headers: { cookie, origin: runtime.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(method.endsWith('/analyze') ? 135000 : 120000),
  });
  assert.equal(response.status, 200, `${method} HTTP response`);
  const envelope = await response.json();
  const result = envelope.result ?? envelope;
  if (result.ok === false) throw new Error(`${method}: ${redactRuntimeLog(result.error?.message ?? result.error?.code ?? 'failed')}`);
  if (result.ok !== true) throw new Error(`${method}: unexpected gateway response keys ${Object.keys(envelope).join(',')}`);
  return result.value;
}

async function seedNativeSessionHistory(bot) {
  // Exercise the same HTTP upload route as the native attachment picker.
  // The synthetic channel binding below uses the public Core store while
  // stopped, so this byte-preservation test does not queue a model turn.
  const uploadBytes=Buffer.from('Native Bot HTTP upload fixture: 青柠 / FILE-592.\n');
  const uploadUrl=new URL('/api/botharness/attachment/upload',runtime.origin);
  uploadUrl.searchParams.set('name','native-upload-fixture.txt');uploadUrl.searchParams.set('uploadId',randomUUID());
  const uploadResponse=await fetch(uploadUrl,{method:'POST',headers:{cookie,origin:runtime.origin,'content-type':'application/octet-stream'},body:uploadBytes,signal:AbortSignal.timeout(30000)});
  assert.equal(uploadResponse.status,200,'native HTTP attachment upload');
  const {attachment:uploaded}=await uploadResponse.json();
  assert.ok(uploaded?.fileId?.startsWith('file:'));assert.equal(uploaded.size,uploadBytes.length);
  // Pause the private runtime before opening its public Core facade, ensuring
  // the fixture never has two Core processes writing the same operational DB.
  const dshHome=runtime.dshHome;
  assert.ok(path.relative(dataRoot,dshHome) && !path.relative(dataRoot,dshHome).startsWith('..'));
  await runtime.stop();runtime=undefined;cookie=undefined;
  const ctx=new Context();
  const persistence=ctx.plugin(jsonl,{root:path.join(dshHome,'sessions')});
  await persistence.await();
  const attachments=new LocalAttachmentStore(ctx,{dshHome});
  let core;
  try {
    core=createCore({dshHome});core.schedules.close();
    const cwd=core.registry.memoryDirFor(bot.slug);
    assert.ok(cwd && path.relative(dataRoot,cwd) && !path.relative(dataRoot,cwd).startsWith('..'));
    const nativeMessageId=`native-upload-fixture-${runId}`;
    const nativeMessage=await core.channels.appendMessage(bot.channelId,{id:nativeMessageId,at:new Date().toISOString(),author:{kind:'bot',slug:bot.slug},body:'Synthetic native channel record for the HTTP upload; no model requested.',attachments:[uploaded]});
    assert.ok(nativeMessage);
    assert.deepEqual(core.channels.attachmentReference(bot.channelId,nativeMessageId,uploaded.fileId),uploaded);
    nativeUploadFixture={sourceSlug:bot.slug,channelId:bot.channelId,messageId:nativeMessageId,ref:uploaded,bytes:uploadBytes};
    const fileBytes=Buffer.from('Synthetic attachment retained with the source Session.\n');
    const fileRef=await attachments.saveFile({data:fileBytes,name:'synthetic-session.txt'});
    const imageBytes=Buffer.from(avatar(`history-${runId}`).dataUrl.split(',')[1],'base64');
    const imageRef=await attachments.saveImage({data:imageBytes,mediaType:'image/png',name:'synthetic-session.png'});
    const storedImage=await attachments.readImage(imageRef);
    const start=Date.now();const rootId=randomUUID();const childId=randomUUID();
    const header={version:4,id:rootId,createdAt:start,cwd,isSeeded:false,delegationDepth:0};
    const rootEvents=[
      {seq:0,time:start,type:'turn/start',data:{turn:1}},
      {seq:1,time:start+1,type:'user/message',surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'Synthetic archive fixture; no model response requested.'},{type:'file',attachment:fileRef},{type:'image',attachment:imageRef}],source:{kind:'user'}})},
      {seq:2,time:start+2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    ];
    const parent=await ctx.sessionPersistence.create(header);await parent.append(rootEvents);await parent.flush();await parent.close();
    const childHeader={version:4,id:childId,createdAt:start+3,cwd,isSeeded:true,parentSession:rootId,delegationDepth:0};
    const childEvents=[...rootEvents,{seq:3,time:start+3,type:'session/end-seed',data:{inherited:true}},
      {seq:4,time:start+4,type:'turn/start',data:{turn:2}},
      {seq:5,time:start+5,type:'user/message',surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'Synthetic fork continuation retained exactly.'}],source:{kind:'user'}})},
      {seq:6,time:start+6,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}}];
    const child=await ctx.sessionPersistence.create(childHeader,{inheritedEventCount:rootEvents.length});await child.append(childEvents);await child.flush();await child.close();
    core.ownership.claim({sessionId:rootId,botSlug:bot.slug,rootRole:'orchestrator',provenance:'created',cwdReference:cwd,at:new Date(start).toISOString()});
    core.ownership.claim({sessionId:childId,botSlug:bot.slug,rootRole:'orchestrator',provenance:'fork',parentSessionId:rootId,cwdReference:cwd,at:new Date(start+3).toISOString()});
    historicalFixture={sourceSlug:bot.slug,rootId,childId,logs:{[rootId]:{header,inheritedEventCount:0,events:rootEvents},[childId]:{header:childHeader,inheritedEventCount:rootEvents.length,events:childEvents}},fileBytes,imageBytes:Buffer.from(storedImage.data),fileRef,imageRef};
  } finally {
    if(core){await core.runtime.close();core.schedules.close();core.live.close();core.companions.close();await core.externalMessaging.close();core.roster.detach();core.contentPurge.close();core.operationalDatabase.close();}
    await persistence.dispose();
  }
  await start();
  check('native-session-fork-and-attachments-seeded',{sessions:2,attachments:2,modelInvoked:false});
  check('native-bot-upload-http-and-public-channel-binding',{uploads:1,bytes:uploadBytes.length,modelInvoked:false,humanSendModelPathTested:false});
}

async function candidateBytes(slug,filename) {
  const {target}=await rpc('botharness/memoryFileTarget',{slug,path:filename});
  const relative=path.relative(dataRoot,target.path);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return fs.readFile(target.path);
}

async function verifyArchivedHistory(job) {
  const source=historicalFixture.sourceSlug;
  for(const [id,expected] of Object.entries(historicalFixture.logs)){
    const suffix=`/${source}/sessions/${createHash('sha256').update(id).digest('hex')}.json`;
    const file=job.files.find(file=>file.path.endsWith(suffix));assert.ok(file,`candidate must carry raw Session ${id}`);
    const actual=JSON.parse((await candidateBytes(job.newBot.slug,file.path)).toString('utf8'));
    assert.deepEqual(actual,expected);
  }
  const sourceArchive=job.archives?.find(archive=>archive.slug===source);
  if(sourceArchive){
    assert.equal(sourceArchive.sessions.length,2);assert.equal(sourceArchive.attachments.length,2);assert.equal(sourceArchive.git.verified,true);
    assert.equal(sourceArchive.serializationVersion,2);assert.equal(sourceArchive.nativeBotUploads.length,1);
    for(const entry of sourceArchive.attachments){
      const file=job.files.find(file=>file.path.endsWith(`/${source}/${entry.path}`));assert.ok(file);
      assert.deepEqual(await candidateBytes(job.newBot.slug,file.path),entry.kind==='file'?historicalFixture.fileBytes:historicalFixture.imageBytes);
    }
    const upload=sourceArchive.nativeBotUploads[0];assert.deepEqual(upload.ref,nativeUploadFixture.ref);
    const uploadFile=job.files.find(file=>file.path.endsWith(`/${source}/${upload.path}`));assert.ok(uploadFile);
    assert.deepEqual(await candidateBytes(job.newBot.slug,uploadFile.path),nativeUploadFixture.bytes);
    assert.ok(upload.associations.some(association=>association.channelId===nativeUploadFixture.channelId&&association.messageId===nativeUploadFixture.messageId));
    const channel=sourceArchive.channels.find(row=>row.channelId===nativeUploadFixture.channelId);assert.equal(channel.visibility,'visible');
    const channelFile=job.files.find(file=>file.path.endsWith(`/${source}/${channel.path}`));assert.ok(channelFile);
    const rawChannel=JSON.parse((await candidateBytes(job.newBot.slug,channelFile.path)).toString('utf8'));
    assert.ok(rawChannel.entries.some(entry=>entry.message.id===nativeUploadFixture.messageId&&entry.message.attachments.some(ref=>ref.fileId===nativeUploadFixture.ref.fileId)));
    nativeUploadFixture.preservedObjects=[{suffix:`/${source}/${upload.path}`,sha256:upload.sha256},{suffix:`/${source}/${channel.path}`,sha256:channel.sha256},{suffix:`/${source}/git/history.bundle`,sha256:sourceArchive.files.find(file=>file.path==='git/history.bundle').sha256}];
    const bundle=job.files.find(file=>file.path.endsWith(`/${source}/git/history.bundle`));assert.ok(bundle);
    const target=await rpc('botharness/memoryFileTarget',{slug:job.newBot.slug,path:bundle.path});
    const soul=await rpc('botharness/memoryFileTarget',{slug:job.newBot.slug,path:'SOUL.md'});
    execFileSync('git',['-C',path.dirname(soul.target.path),'bundle','verify',target.target.path],{stdio:'pipe',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  }
  // Recheck first-generation originals even when their source Bot has already
  // been erased and a later fusion carries them only as inherited knowledge.
  for(const original of nativeUploadFixture?.preservedObjects??[]) {
    const file=job.files.find(file=>file.path.endsWith(original.suffix));assert.ok(file,`later fusion must retain ${original.suffix}`);
    assert.equal(createHash('sha256').update(await candidateBytes(job.newBot.slug,file.path)).digest('hex'),original.sha256);
  }
}

async function createFutureSchedule(bot,title,enabled,date,timeZone){
  return (await rpc('botharness/scheduleCreate',{slug:bot.slug,input:{title,prompt:'Synthetic acceptance fixture. Do not send external messages.',trigger:{kind:'once',date,time:'09:00',timeZone},enabled,locked:false}})).schedule;
}
async function transferSchedules(job,selected){
  const preview=await rpc('forgeFusion/schedulePreview',{id:job.id,behaviorConfirmed:true});
  const keys=selected.map(schedule=>`${schedule.botSlug}:${schedule.id}`);
  assert.ok(keys.every(key=>preview.rows.some(row=>row.key===key&&!row.blocked)));
  const result=await rpc('forgeFusion/migrateSchedules',{id:job.id,token:preview.token,selectedKeys:keys,acknowledgement:job.name});
  assert.equal(result.job.scheduleTransfer.status,'complete');
  const next=(await rpc('botharness/scheduleList',{slug:job.newBot.slug})).schedules;
  assert.equal(next.length,selected.length);
  for(const original of selected){
    const mapping=result.job.scheduleTransfer.rows.find(row=>row.id===original.id);assert.ok(mapping.newId);
    const copied=next.find(row=>row.id===mapping.newId);assert.ok(copied);
    assert.equal(copied.enabled,original.enabled);assert.equal(copied.prompt,original.prompt);assert.deepEqual(copied.trigger,original.trigger);assert.equal(copied.lastFiring,undefined);
    assert.equal((await rpc('botharness/scheduleList',{slug:original.botSlug})).schedules.find(row=>row.id===original.id).enabled,false);
  }
  const repeated=await rpc('forgeFusion/migrateSchedules',{id:job.id,token:preview.token,selectedKeys:keys,acknowledgement:job.name});
  assert.deepEqual(repeated.job.scheduleTransfer.rows.map(row=>row.newId),result.job.scheduleTransfer.rows.map(row=>row.newId));
  return {job:result.job,schedules:next};
}

async function createSample(letter) {
  const displayName = `Forge Integration ${letter} ${runId.slice(0,8)}`;
  const files = {
    'SOUL.md': `# ${displayName}\nThis is synthetic card ${letter}. Preserve explicit user authorization. Do not claim access to external accounts.`,
    'MEMORY.md': `Synthetic fact ${letter}: fixture-${letter.toLowerCase()}-42.`,
    [`knowledge/${letter}.md`]: `Independent synthetic knowledge from card ${letter}.`,
    ...(letter === 'A' ? { 'assets/diagram.bin': samples, 'AGENTS.md': 'Ask before external messages or deletion.' } : {}),
  };
  const url = new URL('/api/botharness/bot-zip/import', runtime.origin); url.searchParams.set('displayName', displayName);
  const response = await fetch(url, { method: 'POST', headers: { cookie, origin: runtime.origin, 'content-type': 'application/zip' }, body: zip(files), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  const slug = value.bot?.id ?? value.bot?.slug;
  if (slug) owned.add(slug);
  assert.equal(response.status, 200, `native ZIP import of ${letter}`);
  assert.ok(slug, 'native ZIP import must return a Bot identity');
  const dm = await rpc('botharness/channelDm', { slug, displayName });
  assert.ok(dm.channel?.id);
  return { slug, name: displayName, channelId: dm.channel.id };
}

async function inspectCandidate(job, facts) {
  const slug = job.newBot.slug;
  const detail = await rpc('botharness/get', { slug });
  assert.equal(detail.bot.displayName, job.name);
  assert.ok((await rpc('botharness/list',{query:job.name})).bots.some(bot=>bot.slug===slug),'new candidate must be immediately available in the native Bot roster');
  assert.ok(detail.bot.avatar?.startsWith('/api/botharness/bot-avatar?'), 'native Bot exposes its avatar through the authenticated image endpoint');
  const portrait = await fetch(new URL(detail.bot.avatar, runtime.origin), { headers: { cookie }, signal: AbortSignal.timeout(15000) });
  assert.equal(portrait.status, 200);
  assert.deepEqual(Buffer.from(await portrait.arrayBuffer()), Buffer.from(job.avatarDataUrl.split(',')[1], 'base64'));
  const dm = await rpc('botharness/channelDm', { slug, displayName: job.name });
  const memory = await rpc('botharness/memorySnapshot', { channelId: dm.channel.id });
  assert.ok(memory.snapshot.head);
  const soul = await rpc('botharness/memoryFile', { channelId: dm.channel.id, path: 'SOUL.md' });
  assert.ok(soul.file.body.includes('explicit user authorization'));
  const coreMemory = await rpc('botharness/memoryFile', { channelId: dm.channel.id, path: 'MEMORY.md' });
  for (const fact of facts) assert.ok(coreMemory.file.body.includes(fact), `candidate must preserve ${fact}`);
  const target = await rpc('botharness/memoryFileTarget', { slug, path: 'assets/diagram.bin' });
  const filename = target.target.path;
  const relative = path.relative(dataRoot, filename);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'binary fixture must stay inside the private runtime');
  assert.deepEqual(await fs.readFile(filename), samples);
  const verification = await rpc('forgeFusion/verify', { id: job.id });
  assert.equal(verification.job.verification.ok, true);
  if(historicalFixture)await verifyArchivedHistory(verification.job);
  return verification.job;
}

async function fuse(slugs, suffix, facts, analyze = false) {
  let { job } = await rpc('forgeFusion/preview', { slugs, name: `Forge Integration Combined ${suffix} ${runId.slice(0,8)}` });
  if (analyze) {
    try {
      const status = await rpc('forgeFusion/status');
      if (!status.modelAvailable) throw new Error('No default model is configured');
      const analyzed = await rpc('forgeFusion/analyze', { id: job.id });
      assert.equal(analyzed.job.analysis.status, 'ready');
      report.model = { attempted: true, ok: true, provider: analyzed.job.analysis.provider, model: analyzed.job.analysis.model, conflicts: analyzed.job.analysis.proposal.conflicts.length };
      check('real-model-structured-review', { appliedToCandidate: false });
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(path.join(projectRoot, '.evidence/model-review.json'), JSON.stringify({ runId, checkedAt: new Date().toISOString(), syntheticOnly: true, ...report.model }, null, 2) + '\n', { mode: 0o600 });
    } catch (error) { report.model = { attempted: true, ok: false, error: redactRuntimeLog(error.message) }; console.log(`MODEL ${report.model.error}`); }
  }
  const decisions = Object.fromEntries(job.conflicts.map(conflict => [conflict.id, 'merge']));
  ({ job } = await rpc('forgeFusion/revise', { id: job.id, decisions, useAnalysis: false }));
  assert.equal(job.status, 'ready');
  ({ job } = await rpc('forgeFusion/commit', { id: job.id }));
  owned.add(job.newBot.slug);
  const same = await rpc('forgeFusion/commit', { id: job.id });
  assert.equal(same.job.newBot.slug, job.newBot.slug);
  return inspectCandidate(job, facts);
}

async function cleanupSources(job) {
  let preview;
  try{preview = await rpc('forgeFusion/cleanupPreview', { id: job.id, behaviorConfirmed: true });}
  catch(error){
    report.archiveDiagnostics=[];
    for(const archive of job.archives??[]){
      try{
        const target=await rpc('botharness/memoryFileTarget',{slug:archive.slug,path:'SOUL.md'});
        const directory=path.dirname(target.target.path);
        const run=args=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
        const digest=value=>createHash('sha256').update(value).digest('hex');
        const actual={head:run(['rev-parse','HEAD']).trim(),refs:run(['show-ref','--head']),reflog:run(['reflog','show','--all','--date=iso-strict','--format=%H%x00%gD%x00%gs']),diff:run(['diff','--binary','--no-ext-diff','--no-textconv','HEAD','--'])};
        report.archiveDiagnostics.push({slug:archive.slug,changed:['head','refs','reflog','diff'].filter(key=>key==='head'?actual.head!==archive.git.head:digest(actual[key])!==archive.git[`${key}Sha256`]),actualHead:actual.head,expectedHead:archive.git.head,actualRefs:actual.refs,expectedRefs:await fs.readFile(path.join(archive.root,'git/refs.txt'),'utf8'),actualReflog:actual.reflog,expectedReflog:await fs.readFile(path.join(archive.root,'git/reflog.txt'),'utf8')});
      }catch(diagnosticError){report.archiveDiagnostics.push({slug:archive.slug,error:redactRuntimeLog(diagnosticError.message)});}
    }
    throw error;
  }
  assert.equal(preview.allowed, true);
  assert.ok(preview.targets.every(target => owned.has(target.slug)), 'cleanup must be limited to this test run');
  const result = await rpc('forgeFusion/cleanup', { id: job.id, token: preview.token, eraseMemory: true, acknowledgement: job.name, acknowledgeUnmigrated: true });
  assert.equal(result.job.status, 'complete');
  assert.ok(result.job.cleanup.results.every(value => value.ok));
  return result.job;
}

try {
  await start();
  const unauthenticated = await fetch(`${runtime.origin}/api/forgeFusion/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'forgeFusion/status', payload: { args: {} } }) });
  assert.equal(unauthenticated.status, 401);
  const status = await rpc('forgeFusion/status');
  assert.equal(status.isolated, true); assert.equal(status.runtimeVersion, '0.2.1-rc.3');
  report.runtimeVersion = status.runtimeVersion;
  check('authenticated-private-runtime', { unauthenticatedRpcStatus: unauthenticated.status });
  const a = await createSample('A'); const b = await createSample('B'); const c = await createSample('C');
  check('three-native-synthetic-bots-created', { count: 3 });
  await seedNativeSessionHistory(a);
  const enabled=await createFutureSchedule(a,'Synthetic selected enabled',true,'2099-12-31','Asia/Shanghai');
  const disabled=await createFutureSchedule(b,'Synthetic selected disabled',false,'2099-12-30','Europe/London');
  const unselected=await createFutureSchedule(a,'Synthetic unselected',true,'2099-12-29','Pacific/Honolulu');
  let first = await fuse([a.slug,b.slug], 'AB', ['fixture-a-42','fixture-b-42'], process.argv.includes('--model'));
  check('first-fusion-native-byte-readback', { files: first.verification.filesChecked, candidate: first.newBot.slug });
  check('raw-native-history-and-attachment-archives-carried-into-candidate',{sessions:2,declaredSessionAttachments:2,nativeBotUploads:1,channelMessages:true});
  const transfer=await transferSchedules(first,[enabled,disabled]);first=transfer.job;
  assert.equal((await rpc('botharness/scheduleList',{slug:a.slug})).schedules.find(row=>row.id===unselected.id).enabled,true);
  check('selected-future-schedules-switch-without-running',{migrated:2,unselectedPreserved:true,timeZonesPreserved:true,idempotent:true});
  await cleanupSources(first);
  check('first-fusion-source-deletion', { count: 2, erased: true });
  let second = await fuse([first.newBot.slug,c.slug], 'ABC', ['fixture-a-42','fixture-b-42','fixture-c-42']);
  const secondTransfer=await transferSchedules(second,transfer.schedules);second=secondTransfer.job;
  assert.notEqual(second.avatarSeed, first.avatarSeed); assert.notEqual(second.avatarDataUrl, first.avatarDataUrl);
  check('second-fusion-preserves-provenance-and-binary', { files: second.verification.filesChecked, candidate: second.newBot.slug });
  await runtime.stop(); runtime = undefined; cookie = undefined;
  await start();
  const recovered = await rpc('forgeFusion/getJob', { id: second.id });
  assert.equal(recovered.job.newBot.slug, second.newBot.slug); assert.equal(recovered.job.avatarDataUrl, second.avatarDataUrl);
  const verifiedAgain = await inspectCandidate(recovered.job, ['fixture-a-42','fixture-b-42','fixture-c-42']);
  assert.deepEqual((await rpc('botharness/scheduleList',{slug:second.newBot.slug})).schedules.map(row=>row.id).sort(),secondTransfer.schedules.map(row=>row.id).sort());
  check('restart-restores-jobs-avatar-and-native-memory');
  await cleanupSources(verifiedAgain);
  check('second-fusion-source-deletion', { count: 2, erased: true });
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = redactRuntimeLog(error.stack ?? error.message); process.exitCode = 1;
} finally {
  // Every slug was returned by a create or commit in this invocation. Existing
  // system Bots and any artifacts from a different test invocation are excluded.
  report.fixtureCleanup = [];
  if(!runtime&&owned.size){try{await start();}catch(error){report.cleanupStartupError=redactRuntimeLog(error.message);}}
  if (runtime) {
    try {
      const { bots } = await rpc('forgeFusion/listBots');
      for (const bot of bots.filter(bot => owned.has(bot.slug))) {
        try {
          const { preview } = await rpc('botharness/deletionPreview', { slug: bot.slug });
          assert.equal(preview.eraseAvailable, true);
          const result = await rpc('botharness/deletionConfirm', { slug: bot.slug, token: preview.token, eraseMemory: true });
          assert.equal(result.deletion.phase, 'complete');
          report.fixtureCleanup.push({ slug: bot.slug, phase: result.deletion.phase, memory: result.deletion.memory });
        } catch (error) { report.fixtureCleanup.push({ slug: bot.slug, ok: false, error: redactRuntimeLog(error.message) }); }
      }
      report.remainingOwnedBots = (await rpc('forgeFusion/listBots')).bots.filter(bot => owned.has(bot.slug)).map(bot => bot.slug);
      if (report.remainingOwnedBots.length || report.fixtureCleanup.some(value => value.ok === false)) { report.ok = false; process.exitCode = 1; }
    } catch (error) { report.cleanupError = redactRuntimeLog(error.message); report.ok = false; process.exitCode = 1; }
    await runtime.stop();
  }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, model: report.model?.ok ?? 'not attempted', reportPath, error: report.error }));
}
