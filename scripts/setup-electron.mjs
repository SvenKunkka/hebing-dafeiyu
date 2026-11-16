import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { downloadArtifact } from '@electron/get';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此构建流程当前仅支持 Apple Silicon macOS');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.devDependencies.electron;
const electronRoot = path.join(root,'node_modules/electron');
const target = path.join(electronRoot,'dist');
const executable = 'Electron.app/Contents/MacOS/Electron';
const installed = await fs.readFile(path.join(target,'version'),'utf8').catch(()=>undefined);
if (installed?.trim() === version && await fs.access(path.join(target,executable)).then(()=>true,()=>false)) {
  await fs.writeFile(path.join(electronRoot,'path.txt'), executable);
  console.log(`Electron ${version} 已可用`);
} else {
  const zip = await downloadArtifact({version,artifactName:'electron',platform:'darwin',arch:'arm64'});
  const cache = path.join(root,'.build-cache'); await fs.mkdir(cache,{recursive:true});
  const staging = await fs.mkdtemp(path.join(cache,'electron-'));
  try {
    await exec('/usr/bin/ditto',['-x','-k',zip,staging],{timeout:120000});
    const {stdout} = await exec('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(staging,'Electron.app/Contents/Info.plist')]);
    if (stdout.trim() !== version) throw new Error('Electron 包版本校验失败');
    await fs.rm(target,{recursive:true,force:true}); await fs.rename(staging,target);
    await fs.writeFile(path.join(electronRoot,'path.txt'), executable);
    console.log(`已校验并安装 Electron ${version}`);
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}
