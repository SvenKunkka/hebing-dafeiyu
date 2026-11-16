import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { archiveSource, verifySourceArchive } from '../packages/fusion/host/archives.mjs';
import { Context } from '@deepseek-ai/cordis';
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';

const runtime = fileURLToPath(new URL('../.runtime/',import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (cwd,...args) => execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
async function fixture(t) {
  await fs.mkdir(runtime,{recursive:true});
  const home = await fs.mkdtemp(path.join(runtime,'archives-test-'));
  t.after(() => fs.rm(home,{recursive:true,force:true}));
  const dataRoot = path.join(home,'data');
  const memoryRoot = path.join(dataRoot,'dsh-home/botharness/bots/selected/memory');
  await fs.mkdir(memoryRoot,{recursive:true});
  await fs.writeFile(path.join(memoryRoot,'SOUL.md'),'# Synthetic source');
  git(memoryRoot,'init','-q'); git(memoryRoot,'add','.'); git(memoryRoot,'-c','user.name=Fixture','-c','user.email=fixture@invalid.test','commit','-q','-m','initial');
  await fs.writeFile(path.join(memoryRoot,'SOUL.md'),'# Historical version only in reflog');
  git(memoryRoot,'add','.'); git(memoryRoot,'-c','user.name=Fixture','-c','user.email=fixture@invalid.test','commit','-q','-m','reflog only');
  const reflogOnly = git(memoryRoot,'rev-parse','HEAD');
  git(memoryRoot,'reset','--hard','HEAD~1');
  const file = Buffer.from([0,255,12,64,0,128]);
  const image = Buffer.from([137,80,78,71,13,10,26,10,0,3]);
  const fileRef = {attachmentId:hash(file),name:'report.bin',bytes:file.length};
  const imageRef = {attachmentId:hash(image),mediaType:'image/png',bytes:image.length,width:1,height:1};
  const original = {seq:0,type:'user/message',data:{content:[{type:'file',attachment:fileRef},{type:'image',attachment:imageRef}]}};
  const ignored = {seq:1,type:'plugin/private',data:{content:[{type:'file',attachment:{attachmentId:'do-not-read',name:'secrets',bytes:123}}],nested:{path:'/private/never-read'}}};
  const assistant = {seq:2,type:'assistant/attempt',data:{stream:[{type:'chunk',chunk:{type:'block-end',block:{type:'image',attachment:imageRef}}}]}};
  const rows = new Map([
    ['root',{header:{version:4,id:'root',createdAt:1,isSeeded:false,cwd:'/synthetic'},inheritedEventCount:0,events:[original,ignored,assistant]}],
    ['child',{header:{version:4,id:'child',createdAt:2,isSeeded:true,parentSession:'root',origin:'subagent'},inheritedEventCount:1,events:[original,{seq:1,type:'system/message',data:{message:{content:[{type:'file',attachment:fileRef}]}}}]}],
    ['grandchild',{header:{version:4,id:'grandchild',createdAt:3,isSeeded:true,parentSession:'child'},inheritedEventCount:1,events:[original,{seq:1,type:'user/message',data:{content:[{type:'text',text:'grandchild'}]}}]}],
    ['unrelated',{header:{version:4,id:'unrelated',createdAt:4,isSeeded:false},inheritedEventCount:0,events:[{seq:0,type:'user/message',data:{content:[{type:'file',attachment:{attachmentId:'unrelated-secret',name:'never-read',bytes:5}}]}}]}],
  ]);
  const calls = {open:[],closed:[],images:[],files:[],nativeDownloads:[]};
  const ctx = {
    sessionPersistence:{
      list:async () => [...rows.values()].map(row => ({header:structuredClone(row.header),revision:hash(JSON.stringify(row.events)),eventCount:row.events.length})),
      open:async (id,access) => {
        assert.equal(access,'read'); calls.open.push(id); const row=rows.get(id); assert.ok(row);
        return {id,header:structuredClone(row.header),inheritedEventCount:row.inheritedEventCount,read:async (offset,length) => ({events:structuredClone(row.events.slice(offset,offset+length))}),close:async () => {calls.closed.push(id);}};
      },
    },
    attachments:{
      readImage:async ref => {assert.deepEqual(ref,imageRef);calls.images.push(ref.attachmentId);return {ref,data:image};},
      async *readFileStream(ref) {assert.deepEqual(ref,fileRef);calls.files.push(ref.attachmentId);yield file.subarray(0,2);yield file.subarray(2);},
    },
  };
  const nativeRecords=[];const nativeMessages=new Map();const nativeUploads=new Map();const invisibleChannels=new Set();
  const nativeIdentity=ref=>ref.fileId??ref.hash;
  const core={
    channels:{
      list:()=>structuredClone(nativeRecords),
      get:id=>structuredClone(nativeRecords.find(row=>row.id===id)),
      revision:id=>(nativeMessages.get(id)??[]).length,
      readHumanJournalPage:(id,{through,before,limit})=>{
        if(invisibleChannels.has(id))return undefined;
        const messages=nativeMessages.get(id)??[];const last=before===undefined?through:Math.min(through,before-1);const first=Math.max(1,last-Math.min(limit,2)+1);
        return {entries:messages.slice(first-1,last).map((message,index)=>({channelId:id,message:structuredClone(message),revision:first+index})),hasOlder:first>1,olderCursor:'opaque-cursor'};
      },
      attachmentReference:(id,messageId,identity)=>structuredClone((nativeMessages.get(id)??[]).find(message=>message.id===messageId)?.attachments?.find(ref=>nativeIdentity(ref)===identity)),
      humanSendStatus:(_id,messageId)=>({sourceEventId:`event-${messageId}`,state:'completed',replies:[]}),
    },
    attachments:{
      rootDir:path.join(dataRoot,'dsh-home/botharness/attachments'),
      current:ref=>structuredClone(nativeUploads.get(nativeIdentity(ref)).ref),
      contentVersion:ref=>hash(nativeUploads.get(nativeIdentity(ref)).data),
      download:async identity=>{calls.nativeDownloads.push(identity);const upload=nativeUploads.get(identity);return {ref:structuredClone(upload.ref),body:(async function*(){yield upload.data.subarray(0,2);yield upload.data.subarray(2);})()};},
    },
  };
  let fingerprint='stable-source-fingerprint';
  const adapter = {core:()=>core,memoryRoot:slug => {assert.equal(slug,'selected');return memoryRoot;},snapshot:async slug => ({bot:{slug},fingerprint,running:false,head:git(memoryRoot,'rev-parse','HEAD'),dependencies:{sessions:['root']}})};
  const source=await adapter.snapshot('selected');
  const args={ctx,adapter,dataRoot,jobId:randomUUID(),source};
  return {home,memoryRoot,dataRoot,args,rows,calls,file,image,reflogOnly,core,nativeRecords,nativeMessages,nativeUploads,invisibleChannels,setFingerprint:value=>{fingerprint=value;}};
}

test('archives Git refs and reflog objects, exact fork logs and only declared attachment references',async t => {
  const f=await fixture(t); const index=await fs.readFile(path.join(f.memoryRoot,'.git/index'));
  assert.ok(!git(f.memoryRoot,'rev-list','--all').includes(f.reflogOnly));
  const archive=await archiveSource(f.args);
  assert.equal(archive.complete,true); assert.deepEqual(archive.unknowns,[]);
  assert.deepEqual(archive.sessions.map(row=>row.id),['child','grandchild','root']);
  assert.deepEqual(f.calls.open.sort(),['child','grandchild','root']);
  assert.deepEqual(f.calls.closed.sort(),['child','grandchild','root']);
  assert.equal(f.calls.images.length,1);assert.equal(f.calls.files.length,1);
  for (const session of archive.sessions) {
    const actual=JSON.parse(await fs.readFile(path.join(archive.root,session.path),'utf8'));
    assert.deepEqual(actual,f.rows.get(session.id));
  }
  for (const attachment of archive.attachments) assert.deepEqual(await fs.readFile(path.join(archive.root,attachment.path)),attachment.kind==='file'?f.file:f.image);
  const restored=path.join(f.home,'restored.git');
  execFileSync('git',['clone','--mirror',path.join(archive.root,archive.git.bundle),restored],{stdio:'pipe'});
  assert.equal(git(restored,'cat-file','-t',f.reflogOnly),'commit');
  assert.deepEqual(await fs.readFile(path.join(f.memoryRoot,'.git/index')),index);
  const verified=await verifySourceArchive({...f.args,slug:'selected',sourceFingerprint:f.args.source.fingerprint,manifestSha256:archive.manifestSha256});
  assert.equal(verified.manifestSha256,archive.manifestSha256);
  const reused=await archiveSource(f.args); assert.equal(reused.manifestSha256,archive.manifestSha256);
});

test('live verification detects appended Session events even when Bot fingerprints are unchanged',async t => {
  const f=await fixture(t); const archive=await archiveSource(f.args);
  f.rows.get('root').events.push({seq:3,type:'user/message',data:{content:[{type:'text',text:'new content'}]}});
  await assert.rejects(verifySourceArchive({...f.args,slug:'selected',sourceFingerprint:f.args.source.fingerprint,manifestSha256:archive.manifestSha256}),/Session 日志已发生变化/);
});

test('live verification detects Git branch changes that do not alter the checked-out source',async t => {
  const f=await fixture(t); const archive=await archiveSource(f.args);
  git(f.memoryRoot,'branch','new-side-history',f.reflogOnly);
  await assert.rejects(verifySourceArchive({...f.args,slug:'selected',sourceFingerprint:f.args.source.fingerprint,manifestSha256:archive.manifestSha256}),/Git 历史已发生变化/);
});

test('tampered archive files are rejected without replacing evidence',async t => {
  const f=await fixture(t); const archive=await archiveSource(f.args);
  const attachment=archive.attachments[0]; const filename=path.join(archive.root,attachment.path);
  await fs.writeFile(filename,Buffer.alloc(attachment.size));
  await assert.rejects(verifySourceArchive({...f.args,slug:'selected',sourceFingerprint:f.args.source.fingerprint,manifestSha256:archive.manifestSha256}),/归档文件校验失败/);
  await assert.rejects(archiveSource(f.args),/归档文件校验失败/);
  assert.deepEqual(await fs.readFile(filename),Buffer.alloc(attachment.size));
});

test('capacity or source consistency failures keep sources and remove only their incomplete staging directory',async t => {
  const f=await fixture(t);
  await assert.rejects(archiveSource({...f.args,limits:{maxTotalBytes:100}}),/容量/);
  assert.equal(await fs.readFile(path.join(f.memoryRoot,'SOUL.md'),'utf8'),'# Synthetic source');
  const parent=path.join(f.dataRoot,'fusion-archives',f.args.jobId);
  assert.deepEqual(await fs.readdir(parent),[]);
  const original=f.args.adapter.snapshot;
  let reads=0;f.args.adapter.snapshot=async slug=>{const result=await original(slug);if(++reads>1)result.fingerprint='changed';return result;};
  await assert.rejects(archiveSource(f.args),/来源在归档期间发生变化/);
  assert.deepEqual(await fs.readdir(parent),[]);
});

test('production targets, linked archive directories and linked Git metadata are refused',async t => {
  const f=await fixture(t);
  await assert.rejects(archiveSource({...f.args,dataRoot:path.join(homedir(),'.dsh','should-never-create')}),/生产资料/);
  const linked=path.join(f.home,'linked');await fs.symlink(f.dataRoot,linked);
  await assert.rejects(archiveSource({...f.args,dataRoot:linked}),/符号链接/);
  const actual=path.join(f.home,'retained-git');await fs.rename(path.join(f.memoryRoot,'.git'),actual);await fs.symlink(actual,path.join(f.memoryRoot,'.git'));
  await assert.rejects(archiveSource(f.args),/独立的 Git/);
});

test('invalid event sequence and missing attachment services never produce a complete manifest',async t => {
  const f=await fixture(t); f.rows.get('root').events[1].seq=88;
  await assert.rejects(archiveSource(f.args),/事件序号/);
  assert.equal(f.calls.open.length,f.calls.closed.length);
  f.rows.get('root').events[1].seq=1; delete f.args.ctx.attachments;
  await assert.rejects(archiveSource(f.args),/附件服务不可用/);
  assert.equal(f.calls.open.length,f.calls.closed.length);
});

test('repeated images with different display names share the binary while both raw references remain intact',async t => {
  const f=await fixture(t);
  const first=f.rows.get('root').events[0].data.content[1].attachment;
  const second={...first,name:'a different original filename.png'};
  f.rows.get('root').events.push({seq:3,type:'user/message',data:{content:[{type:'image',attachment:second}]}});
  const archive=await archiveSource(f.args);
  assert.equal(f.calls.images.length,1);
  const root=archive.sessions.find(session=>session.id==='root');
  const stored=JSON.parse(await fs.readFile(path.join(archive.root,root.path),'utf8'));
  assert.deepEqual(stored.events[3].data.content[0].attachment,second);
});

test('the archive reads real DSH JSONL read handles and keeps the exact inherited fork boundary',async t => {
  const f=await fixture(t);
  const ctx=new Context();
  const plugin=ctx.plugin(jsonl,{root:path.join(f.dataRoot,'native-sessions'),compression:'none'});
  await plugin.await();
  try {
    const persistence=ctx.sessionPersistence;
    const rootId=randomUUID();const childId=randomUUID();
    const event={seq:0,time:1,type:'turn/start',data:{turn:1}};
    const parentHeader={version:4,id:rootId,createdAt:1,cwd:f.memoryRoot,isSeeded:false,delegationDepth:0};
    const childHeader={version:4,id:childId,createdAt:2,cwd:f.memoryRoot,isSeeded:true,parentSession:rootId,delegationDepth:0};
    const parent=await persistence.create(parentHeader);
    await parent.append([event]);await parent.flush();await parent.close();
    const child=await persistence.create(childHeader,{inheritedEventCount:1});
    const boundary={seq:1,time:2,type:'session/end-seed',data:{inherited:true}};
    const ownEvent={seq:2,time:3,type:'step/start',data:{turn:1,step:1}};
    await child.append([event,boundary,ownEvent]);await child.flush();await child.close();
    const adapter={...f.args.adapter,snapshot:async slug=>({...await f.args.adapter.snapshot(slug),dependencies:{sessions:[rootId]}})};
    const source=await adapter.snapshot('selected');
    const archive=await archiveSource({...f.args,ctx,adapter,source});
    assert.equal(archive.sessions.length,2);
    const saved=archive.sessions.find(session=>session.id===childId);
    const restored=JSON.parse(await fs.readFile(path.join(archive.root,saved.path),'utf8'));
    assert.deepEqual(restored,{header:childHeader,inheritedEventCount:1,events:[event,boundary,ownEvent]});
    await verifySourceArchive({...f.args,ctx,adapter,source,slug:'selected',manifestSha256:archive.manifestSha256});
  } finally {await plugin.dispose();}
});

test('native recovery metadata is prepared before freezing every source Git ref without rewriting documents or HEAD',async t => {
  const f=await fixture(t);const before=await fs.readFile(path.join(f.memoryRoot,'SOUL.md'));const head=git(f.memoryRoot,'rev-parse','HEAD');
  f.args.adapter.prepareRecovery=async ()=>{git(f.memoryRoot,'update-ref','refs/botharness/recovery/synthetic-baseline',head);};
  const archive=await archiveSource(f.args);
  assert.ok((await fs.readFile(path.join(archive.root,'git/refs.txt'),'utf8')).includes('refs/botharness/recovery/synthetic-baseline'));
  assert.equal(git(f.memoryRoot,'rev-parse','HEAD'),head);assert.deepEqual(await fs.readFile(path.join(f.memoryRoot,'SOUL.md')),before);
  await verifySourceArchive({...f.args,slug:'selected',manifestSha256:archive.manifestSha256});
});

test('the archived binary working-tree diff restores an uncommitted source change on top of the verified bundle',async t=>{
  const f=await fixture(t);const filename=path.join(f.memoryRoot,'tracked.bin');
  await fs.writeFile(filename,Buffer.from([0,1,2,3,255,128]));git(f.memoryRoot,'add','tracked.bin');git(f.memoryRoot,'-c','user.name=Fixture','-c','user.email=fixture@invalid.test','commit','-q','-m','binary baseline');
  const current=Buffer.from([0,7,8,9,254,129]);await fs.writeFile(filename,current);f.args.source=await f.args.adapter.snapshot('selected');
  const archive=await archiveSource(f.args);const restored=path.join(f.home,'working-tree-restore');
  execFileSync('git',['clone','-q',path.join(archive.root,archive.git.bundle),restored],{stdio:'pipe'});
  git(restored,'apply','--binary',path.join(archive.root,'git/working.diff'));
  assert.deepEqual(await fs.readFile(path.join(restored,'tracked.bin')),current);
  assert.deepEqual(await fs.readFile(filename),current);
});

function nativeFixture(f) {
  const data=Buffer.from('原生 UI 上传验收：青柠，FILE-592。\n');
  const ref={fileId:`file:${randomUUID()}`,name:'native-upload-fixture.txt',mime:'text/plain',size:data.length};
  f.nativeUploads.set(ref.fileId,{ref,data});
  f.nativeRecords.push({id:'dm-selected',type:'dm',name:'Synthetic DM',botSlug:'selected',members:['selected'],createdAt:'2026-01-01',updatedAt:'2026-01-01'});
  f.nativeMessages.set('dm-selected',[
    {id:'human-one',at:'2026-01-01',author:{kind:'human'},body:'Use the uploaded file',attachments:[ref]},
    {id:'human-two',at:'2026-01-02',author:{kind:'human'},body:'Opaque payload is not an attachment',opaque:{attachments:[{fileId:'file:never-read',name:'/private/secret',mime:'text/plain',size:123}]}},
    {id:'human-three',at:'2026-01-03',author:{kind:'human'},body:'Same upload, different message',attachments:[ref]},
  ]);
  f.nativeRecords.push({id:'group-not-visible',type:'group',name:'Private group',members:['selected','other'],createdAt:'2026-01-01',updatedAt:'2026-01-01'});
  f.invisibleChannels.add('group-not-visible');
  f.nativeRecords.push({id:'dm-unrelated',type:'dm',name:'Other bot',botSlug:'other',members:['other'],createdAt:'2026-01-01',updatedAt:'2026-01-01'});
  f.nativeMessages.set('dm-unrelated',[{id:'secret-message',author:{kind:'human'},body:'unrelated',attachments:[{fileId:'file:never-read',name:'unrelated-secret.txt',mime:'text/plain',size:123}]}]);
  return {data,ref};
}

test('native Bot UI uploads are bound to declared channel messages, copied exactly and kept distinct from DSH attachments',async t=>{
  const f=await fixture(t);const native=nativeFixture(f);
  const archive=await archiveSource(f.args);
  assert.equal(archive.serializationVersion,2);assert.equal(archive.attachments.length,2);assert.equal(archive.nativeBotUploads.length,1);
  const upload=archive.nativeBotUploads[0];
  assert.deepEqual(upload.ref,native.ref);assert.equal(upload.contentVersion,hash(native.data));assert.equal(upload.sha256,hash(native.data));
  assert.ok(upload.path.endsWith('/native-upload-fixture.txt'));assert.deepEqual(await fs.readFile(path.join(archive.root,upload.path)),native.data);
  assert.deepEqual(upload.associations.map(row=>[row.channelId,row.messageId,row.sourceEventId]),[['dm-selected','human-one','event-human-one'],['dm-selected','human-three','event-human-three']]);
  assert.deepEqual(upload.associatedBotSessionIds,['child','grandchild','root']);assert.match(upload.sessionAssociation,/不|未提供/);
  assert.deepEqual(f.calls.nativeDownloads,[native.ref.fileId]);
  const channel=archive.channels.find(row=>row.channelId==='dm-selected');
  assert.equal(channel.messageCount,3);
  const raw=await fs.readFile(path.join(archive.root,channel.path),'utf8');const value=JSON.parse(raw);
  assert.deepEqual(value.entries.map(row=>row.revision),[1,2,3]);assert.deepEqual(value.entries.map(row=>row.message),f.nativeMessages.get('dm-selected'));
  assert.ok(raw.includes('},\n{'));assert.equal(archive.channels.find(row=>row.channelId==='group-not-visible').visibility,'not-visible');
  assert.ok(!archive.channels.some(row=>row.channelId==='dm-unrelated'));
  const rawSession=await fs.readFile(path.join(archive.root,archive.sessions[0].path),'utf8');assert.ok(rawSession.includes('},\n{'));
  await verifySourceArchive({...f.args,slug:'selected',manifestSha256:archive.manifestSha256});
});

test('native upload content drift is detected even when Bot fingerprint, channel revision and file ID do not change',async t=>{
  const f=await fixture(t);const native=nativeFixture(f);const archive=await archiveSource(f.args);
  const changed=Buffer.from(native.data);changed[0]^=1;f.nativeUploads.get(native.ref.fileId).data=changed;
  await assert.rejects(verifySourceArchive({...f.args,slug:'selected',manifestSha256:archive.manifestSha256}),/原生频道或上传文件已发生变化/);
});

test('native channel edits and missing channel services prevent claiming a complete restorable source',async t=>{
  const f=await fixture(t);nativeFixture(f);const archive=await archiveSource(f.args);
  f.nativeMessages.get('dm-selected')[0].body='edited without incrementing the native placement revision';
  await assert.rejects(verifySourceArchive({...f.args,slug:'selected',manifestSha256:archive.manifestSha256}),/原生频道或上传文件已发生变化/);
  const fresh=await fixture(t);delete fresh.core.channels.readHumanJournalPage;
  await assert.rejects(archiveSource(fresh.args),/频道与上传归档服务不可用/);
});

test('legacy Session serialization is verified as written and legacy evidence refuses newly discovered native uploads',async t=>{
  const f=await fixture(t);const archive=await archiveSource(f.args);const manifestFile=path.join(archive.root,'manifest.json');const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  for(const session of manifest.sessions) {
    const filename=path.join(archive.root,session.path);const value=JSON.parse(await fs.readFile(filename,'utf8'));const bytes=Buffer.from(JSON.stringify(value)+'\n');
    await fs.writeFile(filename,bytes);Object.assign(session,{sha256:hash(bytes),size:bytes.length});Object.assign(manifest.files.find(file=>file.path===session.path),{sha256:hash(bytes),size:bytes.length});
  }
  delete manifest.serializationVersion;delete manifest.channels;delete manifest.nativeBotUploads;delete manifest.nativeChannelFingerprint;
  const bytes=Buffer.from(JSON.stringify(manifest)+'\n');await fs.writeFile(manifestFile,bytes);
  await verifySourceArchive({...f.args,slug:'selected',manifestSha256:hash(bytes)});
  nativeFixture(f);
  await assert.rejects(verifySourceArchive({...f.args,slug:'selected',manifestSha256:hash(bytes)}),/旧版档案未包含原生频道与上传文件/);
});

test('native uploads are capacity checked before hashing or download and opened streams close on metadata failure',async t=>{
  const large=await fixture(t);const original=nativeFixture(large);
  large.nativeMessages.set('dm-selected',[large.nativeMessages.get('dm-selected')[0]]);
  large.core.attachments.current=()=>({...original.ref,size:10001});
  large.core.attachments.contentVersion=()=>{throw new Error('oversized data must not be hashed');};
  await assert.rejects(archiveSource({...large.args,limits:{maxTotalBytes:10000}}),/原生 Bot 上传超过归档容量/);
  assert.deepEqual(large.calls.nativeDownloads,[]);
  const f=await fixture(t);const native=nativeFixture(f);let cancelled=false;
  f.core.attachments.download=async()=>({ref:{...native.ref,name:'changed-after-open.txt'},body:new ReadableStream({cancel(){cancelled=true;}})});
  await assert.rejects(archiveSource(f.args),/原生 Bot 上传在读取期间发生变化/);
  assert.equal(cancelled,true);
  assert.deepEqual(await fs.readdir(path.join(f.dataRoot,'fusion-archives',f.args.jobId)),[]);
  assert.equal(await fs.readFile(path.join(f.memoryRoot,'SOUL.md'),'utf8'),'# Synthetic source');
});
