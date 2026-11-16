import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveFiles } from '../packages/fusion/host/archive-files.mjs';
import { digest } from '../packages/fusion/host/merge.mjs';

test('the new Bot can retrieve exact raw source sessions, binaries and history from its own knowledge directory',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-archive-files-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'sessions'));mkdirSync(join(root,'git'));
  const session=Buffer.from('{"header":{"id":"source"},"events":[{"seq":7,"text":"蓝松果73"}]}\n');const binary=Buffer.from([0,255,1,128]);
  writeFileSync(join(root,'sessions','original.json'),session);writeFileSync(join(root,'git','history.bundle'),binary);writeFileSync(join(root,'manifest.json'),'{}');
  const manifest={root,slug:'a',sessions:[{id:'source'}],attachments:[],files:[{path:'sessions/original.json',size:session.length,sha256:digest(session)},{path:'git/history.bundle',size:binary.length,sha256:digest(binary)}]};
  const job={id:'00000000-0000-0000-0000-000000000000',files:[{path:'SOUL.md',encoding:'utf8',content:'x'.repeat(4999)},{path:'MEMORY.md',encoding:'utf8',content:'Known fact'}]};
  const files=archiveFiles(job,[manifest]);
  assert.equal(files.find(f=>f.path.endsWith('/sessions/original.json')).content,session.toString('utf8'));
  assert.deepEqual(Buffer.from(files.find(f=>f.path.endsWith('/git/history.bundle')).content,'base64'),binary);
  const standing=files.find(f=>f.path==='SOUL.md');assert.ok(standing.content.length<5000);assert.ok(files.find(f=>f.path===standing.standingArchive.path).content.includes('x'.repeat(4999)));
  assert.match(files.find(f=>f.path==='MEMORY.md').content,/INDEX.md/);
  assert.equal(new Set(files.map(f=>f.path)).size,files.length);
});

test('tampering and oversized archives are refused before native import',t=>{
  const root=mkdtempSync(join(tmpdir(),'forge-archive-files-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'changed.txt'),'changed');writeFileSync(join(root,'manifest.json'),'{}');
  const job={id:'00000000-0000-0000-0000-000000000000',files:[]};
  const base={root,slug:'a',sessions:[],attachments:[],files:[{path:'changed.txt',size:7,sha256:digest('original')}]};
  assert.throws(()=>archiveFiles(job,[base]),/复制期间发生变化/);
  assert.throws(()=>archiveFiles(job,[{...base,files:[{path:'huge.bin',size:101*1024*1024}]}]),/100 MiB/);
});
