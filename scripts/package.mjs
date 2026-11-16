import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.build-cache');
const release = path.join(root, 'release');
const NODE_VERSION = '26.8.1';
const NODE_ARCHIVE = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
const NODE_SHA256 = '6e577fd0d9db776db82306629e441a9dace416702622aebdd171c9dfaa41f4d2';
const NODE_ORIGIN = `https://nodejs.org/dist/v${NODE_VERSION}`;
const MINIMUM_MACOS = '15.0';

async function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (options.capture) {
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(`${path.basename(executable)} failed (${signal ?? code}): ${output.slice(-2000)}`)));
  });
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function officialNode() {
  const archive = path.join(cache, NODE_ARCHIVE);
  let verified = await sha256(archive).then((digest) => digest === NODE_SHA256, () => false);
  const checksum = await fetch(`${NODE_ORIGIN}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
  if (!checksum.ok) throw new Error(`Official Node checksum request failed: HTTP ${checksum.status}`);
  const checksumText = await checksum.text();
  const expected = checksumText.split('\n').find((line) => line.endsWith(`  ${NODE_ARCHIVE}`))?.split(/\s+/)[0];
  if (expected !== NODE_SHA256) throw new Error('Official Node checksum differs from this release recipe');
  await fs.writeFile(path.join(cache, `node-v${NODE_VERSION}-SHASUMS256.txt`), checksumText);
  if (!verified) {
    console.log(`Downloading official Node ${NODE_VERSION} for Apple silicon.`);
    const response = await fetch(`${NODE_ORIGIN}/${NODE_ARCHIVE}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Official Node download failed: HTTP ${response.status}`);
    const partial = `${archive}.${randomUUID()}.partial`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
      if (await sha256(partial) !== NODE_SHA256) throw new Error('Downloaded Node archive failed SHA-256 verification');
      await fs.rename(partial, archive);
      verified = true;
    } finally { await fs.rm(partial, { force: true }); }
  }
  const distribution = path.join(cache, `node-v${NODE_VERSION}-darwin-arm64`);
  if (!await fs.access(path.join(distribution, 'bin/node')).then(() => true, () => false)) {
    const staging = `${distribution}.${randomUUID()}`;
    await fs.mkdir(staging, { recursive: true });
    try {
      await command('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', staging]);
      await fs.rename(staging, distribution);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  const binary = path.join(distribution, 'bin/node');
  const version = await command(binary, ['--version'], { capture: true });
  if (version !== `v${NODE_VERSION}`) throw new Error('Unexpected Node runtime version');
  const linkage = await command('/usr/bin/otool', ['-L', binary], { capture: true });
  if (/\/opt\/homebrew|\/usr\/local|\/Cellar\//.test(linkage)) throw new Error('Bundled Node has nonportable Homebrew dynamic-library dependencies');
  return { distribution, binary, linkage, archiveSha256: NODE_SHA256, verified };
}

async function copyIfPresent(source, target) {
  if (await fs.access(source).then(() => true, () => false)) await fs.cp(source, target, { recursive: true, dereference: false });
}

export async function packageInstalledElectron(options, work) {
  const destination = path.join(options.out, `${options.name}-darwin-arm64`);
  const app = path.join(destination, `${options.name}.app`);
  await fs.mkdir(destination, { recursive: true });
  await command('/usr/bin/ditto', [path.join(root, 'node_modules/electron/dist/Electron.app'), app]);
  const contents = path.join(app, 'Contents');
  const readPlist = async filename => JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filename], { capture: true }));
  const writePlist = async (filename, value) => {
    const temporary = path.join(work, `plist-${randomUUID()}.json`);
    await fs.writeFile(temporary, JSON.stringify(value));
    try { await command('/usr/bin/plutil', ['-convert', 'xml1', '-o', filename, temporary]); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  const infoFile = path.join(contents, 'Info.plist'); const info = await readPlist(infoFile);
  if (info.CFBundleShortVersionString !== options.electronVersion) throw new Error('Installed Electron application version differs from the pinned release');
  const originalExecutable = info.CFBundleExecutable;
  await fs.rename(path.join(contents, 'MacOS', originalExecutable), path.join(contents, 'MacOS', options.executableName));
  Object.assign(info, {
    CFBundleName: options.name, CFBundleDisplayName: options.name, CFBundleExecutable: options.executableName,
    CFBundleIdentifier: options.appBundleId, CFBundleShortVersionString: options.appVersion, CFBundleVersion: options.buildVersion,
    LSMinimumSystemVersion: MINIMUM_MACOS, LSApplicationCategoryType: options.appCategoryType,
    NSRequiresAquaSystemAppearance: false, ...options.usageDescription,
  });
  delete info.ElectronAsarIntegrity;
  await writePlist(infoFile, info);
  const frameworks = path.join(contents, 'Frameworks');
  for (const filename of await fs.readdir(frameworks)) {
    if (!/^Electron Helper(?: \([^)]*\)| (?:EH|NP))?\.app$/.test(filename)) continue;
    const helper = path.join(frameworks, filename); const helperInfoFile = path.join(helper, 'Contents/Info.plist');
    const helperInfo = await readPlist(helperInfoFile);
    const oldName = filename.slice(0, -4); const name = oldName.replace(/^Electron/, options.name);
    const executable = helperInfo.CFBundleExecutable ?? oldName;
    await fs.rename(path.join(helper, 'Contents/MacOS', executable), path.join(helper, 'Contents/MacOS', name));
    const legacySuffix = oldName.match(/ (EH|NP)$/)?.[1];
    Object.assign(helperInfo, { CFBundleName: name, CFBundleDisplayName: name, CFBundleExecutable: name,
      CFBundleIdentifier: `${options.appBundleId}.helper${legacySuffix ? `.${legacySuffix}` : ''}`,
      CFBundleShortVersionString: options.appVersion, CFBundleVersion: options.buildVersion, LSMinimumSystemVersion: MINIMUM_MACOS });
    await writePlist(helperInfoFile, helperInfo);
    await fs.rename(helper, path.join(frameworks, `${name}.app`));
  }
  const resources = path.join(contents, 'Resources');
  for (const filename of ['default_app', 'default_app.asar']) await fs.rm(path.join(resources, filename), { recursive: true, force: true });
  await command('/usr/bin/ditto', [options.dir, path.join(resources, 'app')]);
  for (const resource of options.extraResource) await command('/usr/bin/ditto', [resource, path.join(resources, path.basename(resource))]);
  return [destination];
}

async function packageFolders(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    const location = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scope of await fs.readdir(location, { withFileTypes: true })) if (scope.isDirectory()) found.push(path.join(location, scope.name));
    } else if (entry.isDirectory()) found.push(location);
  }
  return found;
}

async function applyOptionalExclusions(appSource) {
  const exclusions = [];
  const queue = await packageFolders(path.join(appSource, 'node_modules'));
  while (queue.length) {
    const folder = queue.shift();
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); } catch { continue; }
    if (manifest.name === '@tencent-connect/qqbot-connector') {
      exclusions.push({ name: manifest.name, version: manifest.version, declaredLicense: manifest.license, reason: 'No redistribution license declared; QQ/IM integration is disabled and outside this client build.' });
      await fs.rm(folder, { recursive: true, force: true });
      continue;
    }
    if (!manifest.license && !manifest.licenses || String(manifest.license).toUpperCase() === 'UNLICENSED') {
      throw new Error(`A production dependency requires license review: ${manifest.name}@${manifest.version}`);
    }
    queue.push(...await packageFolders(path.join(folder, 'node_modules')));
  }
  return exclusions;
}

async function standardLicenseText(name, url) {
  const filename = path.join(cache, 'license-texts', `${name}.txt`);
  if (!await fs.access(filename).then(() => true, () => false)) {
    const candidates = [url, `https://raw.githubusercontent.com/spdx/license-list-data/main/text/${name}-or-later.txt`];
    let saved = false;
    for (const source of candidates) {
      try {
        const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) continue;
        const contents = await response.text();
        if (!contents.includes('GNU') || !contents.includes('LICENSE') || !/Version 3, 29 June 2007/i.test(contents)) continue;
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, contents);
        await fs.writeFile(`${filename}.source.json`, JSON.stringify({ canonicalSource: url, retrievedSource: source, sha256: await sha256(filename) }, null, 2) + '\n');
        saved = true; break;
      } catch {}
    }
    if (!saved) throw new Error(`Required license text could not be retrieved from GNU/SPDX: ${name}`);
  }
  return filename;
}

async function collectLicenses(appSource, node) {
  const licenses = path.join(appSource, 'third-party-licenses');
  await fs.mkdir(licenses, { recursive: true });
  const packages = [];
  const queue = await packageFolders(path.join(appSource, 'node_modules'));
  const seen = new Set();
  while (queue.length) {
    const folder = queue.shift();
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); } catch { continue; }
    queue.push(...await packageFolders(path.join(folder, 'node_modules')));
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = path.join(licenses, key.replaceAll('/', '__'));
    const entries = await fs.readdir(folder);
    const files = entries.filter((name) => /^(?:licen[cs]e|copying|notice|copyright|third.party.notices)(?:[._-].*)?$/i.test(name));
    await fs.mkdir(target, { recursive: true });
    const copied = [];
    for (const name of files) {
      const source = path.join(folder, name);
      if (!(await fs.stat(source)).isFile()) continue;
      await fs.copyFile(source, path.join(target, name)); copied.push(name);
    }
    for (const name of ['licenses', 'LICENSES', 'sources']) {
      if (!entries.includes(name)) continue;
      const source = path.join(folder, name);
      if ((await fs.stat(source)).isDirectory()) { await fs.cp(source, path.join(target, name), { recursive: true, dereference: true }); copied.push(`${name}/`); }
    }
    if (!copied.length || /(?:LGPL|MPL)/.test(String(manifest.license))) {
      for (const name of entries.filter((name) => /^readme(?:[._-].*)?$/i.test(name))) {
        if (!(await fs.stat(path.join(folder, name))).isFile()) continue;
        await fs.copyFile(path.join(folder, name), path.join(target, name)); copied.push(name);
      }
    }
    if (manifest.name === '@img/sharp-libvips-darwin-arm64') {
      const versions = JSON.parse(await fs.readFile(path.join(folder, 'versions.json'), 'utf8'));
      await fs.copyFile(path.join(folder, 'versions.json'), path.join(target, 'versions.json')); copied.push('versions.json');
      for (const [name, url] of [['LGPL-3.0', 'https://www.gnu.org/licenses/lgpl-3.0.txt'], ['GPL-3.0', 'https://www.gnu.org/licenses/gpl-3.0.txt']]) {
        const textFile = await standardLicenseText(name, url);
        await fs.copyFile(textFile, path.join(target, `${name}.txt`)); copied.push(`${name}.txt`);
        await copyIfPresent(`${textFile}.source.json`, path.join(target, `${name}.txt.source.json`));
      }
      const sourceInfo = { project: 'sharp-libvips', packageVersion: manifest.version, buildSources: `https://github.com/lovell/sharp-libvips/tree/v${manifest.version}`, libvipsVersion: versions.vips, libvipsSource: `https://github.com/libvips/libvips/releases/tag/v${versions.vips}`, upstreamLicenseTable: 'README.md', componentVersions: 'versions.json', binaryModified: false };
      await fs.writeFile(path.join(target, 'source-information.json'), JSON.stringify(sourceInfo, null, 2) + '\n'); copied.push('source-information.json');
    }
    const info = { name: manifest.name, version: manifest.version, license: manifest.license ?? manifest.licenses ?? 'See package license files', repository: manifest.repository, homepage: manifest.homepage, licenseFiles: copied };
    packages.push(info);
    await fs.writeFile(path.join(target, 'package-license.json'), JSON.stringify(info, null, 2) + '\n');
  }
  await fs.mkdir(path.join(licenses, 'Node.js'), { recursive: true });
  await fs.copyFile(path.join(node.distribution, 'LICENSE'), path.join(licenses, 'Node.js/LICENSE'));
  await fs.mkdir(path.join(licenses, 'Electron'), { recursive: true });
  for (const filename of ['LICENSE', 'LICENSES.chromium.html']) await copyIfPresent(path.join(root, 'node_modules/electron/dist', filename), path.join(licenses, 'Electron', filename));
  packages.sort((left, right) => left.name.localeCompare(right.name));
  await fs.writeFile(path.join(licenses, 'manifest.json'), JSON.stringify({ node: NODE_VERSION, electron: '45.3.3', packages }, null, 2) + '\n');
  return packages.length;
}

async function assertCleanPayload(directory) {
  let fileCount = 0;
  let bytes = 0;
  const visit = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const location = path.join(folder, entry.name);
      if (['.runtime', '.evidence', '.git', '.build-cache', '.credentials.yaml'].includes(entry.name) || /^\.env(?:$|\.)/.test(entry.name) || /\.(?:pem|key)$/i.test(entry.name)) throw new Error(`Private/development material found in release payload: ${path.relative(directory, location)}`);
      if (entry.isDirectory()) await visit(location);
      else if (entry.isFile()) { fileCount++; bytes += (await fs.stat(location)).size; }
      else if (entry.isSymbolicLink()) {
        const resolved = await fs.realpath(location);
        if (!resolved.startsWith(directory + path.sep)) throw new Error(`Release dependency links outside the payload: ${path.relative(directory, location)}`);
      }
    }
  };
  await visit(directory);
  return { fileCount, bytes };
}

async function sourceFingerprints(directory) {
  const fingerprints = {};
  const visit = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) fingerprints[path.relative(directory, filename)] = await sha256(filename);
    }
  };
  for (const folder of ['electron', 'packages/fusion', 'docs']) await visit(path.join(directory, folder));
  fingerprints['README.md'] = await sha256(path.join(directory, 'README.md'));
  fingerprints['scripts/runtime-profile.mjs'] = await sha256(path.join(directory, 'scripts/runtime-profile.mjs'));
  return fingerprints;
}

async function assertSourceFingerprints(fingerprints, appDirectory, lockSha256) {
  const mismatches = [];
  for (const [relative, expected] of Object.entries(fingerprints)) {
    const source = path.join(root, relative);
    if (await sha256(path.join(appDirectory, relative)) !== expected || await sha256(source) !== expected) mismatches.push(relative);
  }
  if (await sha256(path.join(root, 'package-lock.json')) !== lockSha256) mismatches.push('package-lock.json');
  if (mismatches.length) throw new Error(`Source changed while packaging; previous valid release retained: ${mismatches.join(', ')}`);
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This release recipe builds macOS Apple silicon only');
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(release, { recursive: true });
  const sourceManifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const work = path.join(cache, `package-${randomUUID()}`);
  const appSource = path.join(work, 'source');
  const product = path.join(release, `DSH Forge-${sourceManifest.version}-mac-arm64`);
  const dmg = path.join(release, `DSH-Forge-${sourceManifest.version}-mac-arm64.dmg`);
  const receiptFile = path.join(release, 'release-receipt.json');
  let oldReceipt;
  try { oldReceipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); } catch {}
  if (await fs.access(product).then(() => true, () => false) && (oldReceipt?.owner !== 'dsh-forge-packager' || oldReceipt.projectRoot !== root)) throw new Error('Release output already exists without a matching generated-artifact receipt');
  await fs.mkdir(appSource, { recursive: true });
  try {
    await command(process.execPath, [path.join(root, 'scripts/build.mjs')]);
    const node = await officialNode();
    console.log('Staging application source and production dependencies.');
    for (const filename of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await fs.copyFile(path.join(root, filename), path.join(appSource, filename));
    const sourceLockSha256 = await sha256(path.join(appSource, 'package-lock.json'));
    await fs.cp(path.join(root, 'electron'), path.join(appSource, 'electron'), { recursive: true });
    await fs.mkdir(path.join(appSource, 'scripts'));
    await fs.copyFile(path.join(root, 'scripts/runtime-profile.mjs'), path.join(appSource, 'scripts/runtime-profile.mjs'));
    await fs.cp(path.join(root, 'packages/fusion'), path.join(appSource, 'packages/fusion'), { recursive: true });
    await fs.cp(path.join(root, 'docs'), path.join(appSource, 'docs'), { recursive: true });
    // Preserve the source documentation layout so README's relative links work.
    await fs.copyFile(path.join(root, 'README.md'), path.join(appSource, 'README.md'));
    const npmPath = process.env.npm_execpath ?? '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';
    await command(process.execPath, [npmPath, 'ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: appSource });
    const payloadManifest = { ...sourceManifest, scripts: {} }; delete payloadManifest.devDependencies;
    await fs.writeFile(path.join(appSource, 'package.json'), JSON.stringify(payloadManifest, null, 2) + '\n');
    await fs.rm(path.join(appSource, 'package-lock.json'));
    const optionalExclusions = await applyOptionalExclusions(appSource);
    await assertCleanPayload(appSource);
    const licenseCount = await collectLicenses(appSource, node);
    const payload = await assertCleanPayload(appSource);
    const fingerprints = await sourceFingerprints(appSource);
    console.log(`Payload validated: ${payload.fileCount} files, ${Math.round(payload.bytes / 1024 / 1024)} MiB, ${licenseCount} dependency license records.`);
    const nodeResource = path.join(work, 'node');
    await fs.mkdir(path.join(nodeResource, 'bin'), { recursive: true });
    await fs.copyFile(node.binary, path.join(nodeResource, 'bin/node')); await fs.chmod(path.join(nodeResource, 'bin/node'), 0o755);
    await fs.copyFile(path.join(node.distribution, 'LICENSE'), path.join(nodeResource, 'LICENSE'));
    await fs.writeFile(path.join(nodeResource, 'provenance.json'), JSON.stringify({ version: NODE_VERSION, archive: NODE_ARCHIVE, source: NODE_ORIGIN, sha256: NODE_SHA256 }, null, 2) + '\n');
    console.log('Packaging the Mac desktop application.');
    const outputs = await packageInstalledElectron({
      dir: appSource, out: path.join(work, 'packed'), name: 'DSH Forge', executableName: 'DSH Forge',
      appBundleId: 'app.dshforge.desktop', appVersion: sourceManifest.version, buildVersion: sourceManifest.version,
      platform: 'darwin', arch: 'arm64', electronVersion: '45.3.3',
      asar: false, prune: false, overwrite: true, extraResource: [nodeResource],
      appCategoryType: 'public.app-category.productivity', darwinDarkModeSupport: true,
      usageDescription: { NSDocumentsFolderUsageDescription: 'DSH Forge uses folders you select for robot tasks and saved files.' },
    }, work);
    const candidate = path.join(outputs[0], 'DSH Forge.app');
    await command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', candidate]);
    const signature = await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', candidate], { capture: true });
    const nodeBinary = path.join(candidate, 'Contents/Resources/node/bin/node');
    const packagedNodeVersion = await command(nodeBinary, ['--version'], { capture: true });
    const architecture = await command('/usr/bin/file', [path.join(candidate, 'Contents/MacOS/DSH Forge'), nodeBinary], { capture: true });
    if (packagedNodeVersion !== `v${NODE_VERSION}` || !architecture.includes('arm64')) throw new Error('Packaged executable architecture/runtime validation failed');
    const clean = await assertCleanPayload(path.join(candidate, 'Contents/Resources/app'));
    await assertSourceFingerprints(fingerprints, path.join(candidate, 'Contents/Resources/app'), sourceLockSha256);
    const nextProduct = `${product}.${randomUUID()}.building`;
    await fs.mkdir(nextProduct);
    await fs.rename(candidate, path.join(nextProduct, 'DSH Forge.app'));
    await fs.symlink('/Applications', path.join(nextProduct, 'Applications'));
    const installText = `DSH Forge ${sourceManifest.version} — Mac Apple silicon / macOS ${MINIMUM_MACOS} 或更高版本\n\n安装：将 DSH Forge.app 拖入 Applications，或从本目录直接打开。\n首次启动会建立本应用自己的机器人资料目录；原 DSH 与 Grok Bot 不会被替换。\n已内置 Node ${NODE_VERSION}，运行不要求 Homebrew 或预装 Node。Git 记忆使用系统 git；新 Mac 尚未安装它时，需按系统提示安装 Command Line Tools。\n本构建使用本地 ad-hoc 签名，未使用 Apple Developer ID、未公证。若系统阻止打开，请在“系统设置 → 隐私与安全性”中为你确认来源的本构建选择“仍要打开”。\n模型调用需要你自己的有效配置、网络和对应服务额度；本安装包不包含个人密钥或机器人资料。\n第三方许可在应用的 Contents/Resources/app/third-party-licenses。\n卸载程序不会自动删除用户自己的机器人资料。\n`;
    await fs.writeFile(path.join(nextProduct, '安装说明.txt'), installText);
    await fs.writeFile(path.join(nextProduct, '安装说明.md'), `# DSH Forge 安装说明\n\n[打开详细使用说明](./使用说明.md)\n\n${installText}`);
    await fs.copyFile(path.join(appSource, 'docs/usage.md'), path.join(nextProduct, '使用说明.md'));
    const dmgCandidate = path.join(work, 'DSH-Forge.dmg');
    console.log('Creating and verifying the disk image.');
    await command('/usr/bin/hdiutil', ['create', '-volname', 'DSH Forge', '-srcfolder', nextProduct, '-format', 'UDZO', '-imagekey', 'zlib-level=6', dmgCandidate]);
    await command('/usr/bin/hdiutil', ['verify', dmgCandidate]);
    const receipt = {
      owner: 'dsh-forge-packager', formatVersion: 1, projectRoot: root, version: sourceManifest.version,
      builtAt: new Date().toISOString(), platform: 'darwin', arch: 'arm64', electronVersion: '45.3.3', nodeVersion: NODE_VERSION,
      minimumMacOS: MINIMUM_MACOS, sourceFiles: fingerprints, sourceLockSha256, systemGitRequiredForGitMemory: true,
      nodeArchiveSha256: NODE_SHA256, nodeDynamicLibraries: node.linkage, signing: 'ad-hoc', notarized: false,
      signatureVerification: signature, architecture, payload: clean, licensePackages: licenseCount,
      app: path.join(product, 'DSH Forge.app'), dmg, dmgSha256: await sha256(dmgCandidate), dmgBytes: (await fs.stat(dmgCandidate)).size,
      privateDataIncluded: false, developerDependenciesInstalled: false, optionalExclusions,
    };
    // Only replace this build recipe's own earlier generated outputs after the
    // complete new app and DMG have passed their validations.
    await assertSourceFingerprints(fingerprints, path.join(nextProduct, 'DSH Forge.app/Contents/Resources/app'), sourceLockSha256);
    if (oldReceipt?.owner === 'dsh-forge-packager' && oldReceipt.projectRoot === root) {
      await fs.rm(product, { recursive: true, force: true }); await fs.rm(dmg, { force: true });
    }
    await fs.rename(nextProduct, product); await fs.rename(dmgCandidate, dmg);
    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    await fs.writeFile(path.join(release, '安装说明.txt'), installText);
    await fs.writeFile(path.join(release, '安装说明.md'), `# DSH Forge 安装说明\n\n[打开详细使用说明](./使用说明.md)\n\n${installText}`);
    await fs.copyFile(path.join(appSource, 'docs/usage.md'), path.join(release, '使用说明.md'));
    console.log(JSON.stringify({ app: receipt.app, dmg, dmgMiB: Math.round(receipt.dmgBytes / 1024 / 1024), signing: receipt.signing, node: packagedNodeVersion, licenses: licenseCount }));
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
