import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { prepareRuntime, selectModelPatches, selectModelCredentials, validateDataRoot } from '../scripts/runtime-profile.mjs';
import { parseReadyUrl, redactRuntimeLog, startRuntime } from '../electron/runtime.mjs';

test('model inheritance only keeps model settings and never evaluates expressions or copies inline secrets', () => {
  const rows = selectModelPatches([[
    { id: 'tool-bash', config: { command: 'do not copy' } },
    { id: 'llm-pi-ai', config: { providers: { route: { apiKeyEnv: 'FORGE_TEST_KEY', api: 'openai-responses', baseURL: 'https://example.test/v1', headers: { Authorization: 'private' }, apiKey: 'private', models: [{ id: 'example' }] } } } },
    { id: 'llm-deepseek', config: { thinking: 'enabled', apiKey: 'private', requestHeaders: { private: 'private' }, baseURL: { __forgeUnevaluatedExpression: true } } },
  ]]);
  assert.deepEqual(rows.map((row) => row.id), ['llm-pi-ai', 'llm-deepseek']);
  assert.deepEqual(rows[0].config.providers.route, { apiKeyEnv: 'FORGE_TEST_KEY', api: 'openai-responses', baseURL: 'https://example.test/v1', models: [{ id: 'example' }] });
  assert.deepEqual(rows[1].config, { thinking: 'enabled' });
  assert.ok(!JSON.stringify(rows).includes('private'));
});

test('production roots, their ancestors and symbolic redirects are refused', async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'forge-path-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'); await fs.mkdir(project);
  for (const target of [homedir(), path.join(homedir(), '.dsh'), path.join(homedir(), '.dsh', 'forge'), path.join(homedir(), '.botharness'), '/', project]) {
    await assert.rejects(validateDataRoot(project, target), /dedicated directory/);
  }
  const redirect = path.join(dir, 'redirect'); await fs.symlink(path.join(homedir(), '.dsh'), redirect);
  await assert.rejects(validateDataRoot(project, redirect), /dedicated directory/);
  const isolated = await validateDataRoot(project, path.join(project, '.runtime/dev'));
  assert.ok(isolated.endsWith(path.join('.runtime', 'dev')));
});

test('credential snapshots keep configured model refs and grants but exclude browser and IM identities', () => {
  const synthetic = { version: 1, refs: { DEEPSEEK_API_KEY: 'model-key', ROUTE_KEY: 'route-key', SLACK_BOT_TOKEN: 'im-secret' }, records: {
    'client-connection/browser-session': { kind: 'grant', payload: { secret: 'browser-secret' } },
    'botharness-im/slack': { kind: 'grant', payload: { secret: 'im-secret' } },
    'llm-pi-ai/custom': { kind: 'api-key', key: 'model-key' },
    'llm-pi-ai/unused': { kind: 'api-key', key: 'unused-key' },
    'deepseek-account-platform/default': { kind: 'grant', payload: { token: 'model-grant' } },
  } };
  const selected = selectModelCredentials(synthetic, [{ id: 'llm-pi-ai', config: { providers: { custom: { apiKeyEnv: 'ROUTE_KEY' } } } }]);
  assert.deepEqual(Object.keys(selected.refs).sort(), ['DEEPSEEK_API_KEY', 'ROUTE_KEY']);
  assert.deepEqual(Object.keys(selected.records).sort(), ['deepseek-account-platform/default', 'llm-pi-ai/custom']);
  assert.ok(!JSON.stringify(selected).includes('browser-secret'));
  assert.ok(!JSON.stringify(selected).includes('im-secret'));
  assert.ok(!JSON.stringify(selected).includes('unused-key'));
});

test('ready URLs must belong to a token-authenticated loopback runtime and logs redact tokens', () => {
  const line = 'dsh web: http://127.0.0.1:32100/?token=local-test-token';
  const parsed = parseReadyUrl(line);
  assert.equal(parsed.origin, 'http://127.0.0.1:32100');
  assert.equal(new URL(parsed.url).searchParams.get('token'), 'local-test-token');
  for (const candidate of ['dsh web: http://example.com:32100/?token=a', 'dsh web: http://127.0.0.1:32100/', 'http://127.0.0.1:32100/?token=a', 'dsh web: http://user:pass@127.0.0.1:32100/?token=a']) assert.equal(parseReadyUrl(candidate), null);
  assert.ok(!redactRuntimeLog(`${line} Bearer abcdefgh sk-privateexample`).includes('local-test-token'));
  assert.ok(!redactRuntimeLog(`${line} Bearer abcdefgh sk-privateexample`).includes('abcdefgh'));
});

test('private profile preparation copies credentials once and leaves production models and unrelated integrations untouched', async (t) => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const base = await fs.mkdtemp(path.join(tmpdir(), 'forge-profile-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceHome = path.join(base, 'source-home');
  await fs.mkdir(path.join(sourceHome, 'profiles/desktop'), { recursive: true });
  const sourceCredential = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-test-value\n  SLACK_BOT_TOKEN: synthetic-im-value\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: synthetic-browser-value\n';
  await fs.writeFile(path.join(sourceHome, '.credentials.yaml'), sourceCredential, { mode: 0o600 });
  await fs.writeFile(path.join(sourceHome, 'profiles/desktop/cordis.patch.yml'), '- id: llm-deepseek\n  config:\n    thinking: enabled\n- id: tool-bash\n  config:\n    unsafe: do-not-copy\n');
  const dataRoot = path.join(base, 'runtime');
  const prepared = await prepareRuntime({ projectRoot, dataRoot, inheritModelConfig: { sourceHome } });
  assert.equal(await fs.readFile(path.join(sourceHome, '.credentials.yaml'), 'utf8'), sourceCredential);
  const target = path.join(prepared.dshHome, '.credentials.yaml');
  const privateCredentials = await fs.readFile(target, 'utf8');
  assert.match(privateCredentials, /synthetic-test-value/);
  assert.ok(!privateCredentials.includes('synthetic-im-value'));
  assert.ok(!privateCredentials.includes('synthetic-browser-value'));
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  const manifest = JSON.parse(await fs.readFile(path.join(prepared.profileDir, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'deepseekbot', '@dsh-forge/fusion']);
  const patch = await fs.readFile(path.join(prepared.profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /thinking: enabled/); assert.match(patch, /botharness-computer/); assert.ok(!patch.includes('do-not-copy'));
  await fs.writeFile(target, 'private-runtime-edit', { mode: 0o600 });
  await prepareRuntime({ projectRoot, dataRoot, inheritModelConfig: { sourceHome } });
  assert.equal(await fs.readFile(target, 'utf8'), 'private-runtime-edit');
  assert.equal(await fs.readFile(path.join(sourceHome, '.credentials.yaml'), 'utf8'), sourceCredential);
});

test('legacy private snapshots are filtered once without rewriting their original source', async (t) => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const base = await fs.mkdtemp(path.join(tmpdir(), 'forge-legacy-credentials-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sourceHome = path.join(base, 'source-home'); await fs.mkdir(sourceHome);
  const source = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-model\n  SLACK_BOT_TOKEN: synthetic-im\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      token: synthetic-browser\n';
  await fs.writeFile(path.join(sourceHome, '.credentials.yaml'), source, { mode: 0o600 });
  const dataRoot = path.join(base, 'runtime');
  const prepared = await prepareRuntime({ projectRoot, dataRoot, inheritModelConfig: { sourceHome } });
  await fs.writeFile(path.join(prepared.dshHome, '.credentials.yaml'), source, { mode: 0o600 });
  await fs.writeFile(path.join(dataRoot, 'model-inheritance.json'), JSON.stringify({ credentialsCopied: true, modelEntries: [], skippedFiles: 0 }), { mode: 0o600 });
  const migrated = await prepareRuntime({ projectRoot, dataRoot, inheritModelConfig: { sourceHome } });
  const snapshot = await fs.readFile(path.join(prepared.dshHome, '.credentials.yaml'), 'utf8');
  assert.equal(migrated.modelInheritance.credentialsPolicyVersion, 2);
  assert.match(snapshot, /synthetic-model/);
  assert.ok(!snapshot.includes('synthetic-im'));
  assert.ok(!snapshot.includes('synthetic-browser'));
  assert.equal(await fs.readFile(path.join(sourceHome, '.credentials.yaml'), 'utf8'), source);
});

test('runtime manager owns one exact child, retains no token in metadata/logs, and stops idempotently', async (t) => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const base = await fs.mkdtemp(path.join(tmpdir(), 'forge-manager-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const fakeNode = path.join(base, 'fake-node');
  await fs.writeFile(fakeNode, `#!${process.execPath}\nconsole.log('dsh web: http://127.0.0.1:32100/?token=synthetic-only-secret'); setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));\n`, { mode: 0o700 });
  const logs = [];
  const options = { projectRoot, dataRoot: path.join(base, 'runtime'), nodePath: fakeNode, inheritModelConfig: false, onLog: (line) => logs.push(line), startupTimeoutMs: 5000 };
  const [first, second] = await Promise.all([startRuntime(options), startRuntime(options)]);
  t.after(() => first.stop());
  assert.equal(first.pid, second.pid);
  assert.equal(first.origin, 'http://127.0.0.1:32100');
  const metadata = await fs.readFile(path.join(first.dataRoot, 'runtime.json'), 'utf8');
  assert.equal(JSON.parse(metadata).state, 'ready');
  assert.ok(!metadata.includes('synthetic-only-secret'));
  assert.ok(!logs.join('\n').includes('synthetic-only-secret'));
  await Promise.all([first.stop(), first.stop()]);
  await assert.rejects(fs.access(path.join(first.dataRoot, 'manager.lock.json')));
  assert.equal(JSON.parse(await fs.readFile(path.join(first.dataRoot, 'runtime.json'), 'utf8')).state, 'stopped');
});

test('cancelling startup terminates its exact child and releases its lock before returning', async (t) => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const base = await fs.mkdtemp(path.join(tmpdir(), 'forge-abort-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const fakeNode = path.join(base, 'fake-node');
  await fs.writeFile(fakeNode, `#!${process.execPath}\nsetInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));\n`, { mode: 0o700 });
  const dataRoot = path.join(base, 'runtime');
  const controller = new AbortController();
  const pending = startRuntime({ projectRoot, dataRoot, nodePath: fakeNode, inheritModelConfig: false, signal: controller.signal, startupTimeoutMs: 10000 });
  const timer = setInterval(async () => {
    try { const metadata = JSON.parse(await fs.readFile(path.join(dataRoot, 'runtime.json'), 'utf8')); if (metadata.pid) controller.abort(); } catch {}
  }, 10);
  t.after(() => clearInterval(timer));
  await assert.rejects(pending, { name: 'AbortError' });
  clearInterval(timer);
  await assert.rejects(fs.access(path.join(dataRoot, 'manager.lock.json')));
  const metadata = JSON.parse(await fs.readFile(path.join(dataRoot, 'runtime.json'), 'utf8'));
  assert.equal(metadata.state, 'failed');
  assert.throws(() => process.kill(metadata.pid, 0), { code: 'ESRCH' });
});
