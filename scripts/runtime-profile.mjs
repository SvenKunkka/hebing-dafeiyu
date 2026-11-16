import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RUNTIME_OWNER = 'dsh-forge';
export const RUNTIME_PROFILE = 'forge';
export const REQUIRED_BUNDLES = Object.freeze([
  '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'deepseekbot', '@dsh-forge/fusion',
]);

const MODEL_IDS = new Set(['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-default-model']);
const MODEL_FIELDS = new Set([
  'apiKeyEnv', 'baseURL', 'models', 'modelOverrides', 'providers', 'thinking', 'provider', 'model',
  'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'streamIdleTimeoutMs',
  'maxRequestFilesBytes', 'maxInlineRequestImageBytes', 'maxImagesPerRequest',
  'imageOffloadByteQuantum', 'inlineImageOffloadByteQuantum', 'imageOffloadCountQuantum',
  'filesApiTimeoutMs', 'fileExpiresAfterSeconds', 'fileRefreshMarginSeconds',
  'fileQuotaCleanupBatch', 'retryPolicy', 'modelsTimeoutMs', 'modelsMaxAgeMs',
]);
const OMIT = Symbol('omit');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonical(candidate) {
  try { return await fs.realpath(candidate); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    return path.join(await canonical(parent), path.basename(candidate));
  }
}

export async function validateDataRoot(projectRoot, dataRoot) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new Error('projectRoot must be an absolute path');
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new Error('dataRoot must be an absolute path');
  const root = await canonical(path.resolve(dataRoot));
  const home = await canonical(homedir());
  const project = await canonical(path.resolve(projectRoot));
  const forbidden = [path.join(home, '.dsh'), path.join(home, '.botharness'), '/Applications'];
  if (root === path.parse(root).root || root === home || root === project || forbidden.some((entry) => inside(entry, root) || inside(root, entry))) {
    throw new Error('Runtime data must use a dedicated directory outside existing DSH and BotHarness data');
  }
  return root;
}

async function assertRegularTarget(filename) {
  try {
    const current = await fs.lstat(filename);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('Refusing to replace an unsafe runtime file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function writePrivateJson(filename, value) {
  await assertRegularTarget(filename);
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, filename);
  } finally { await fs.rm(temp, { force: true }); }
}

async function mkdirPrivate(directory) {
  if (await canonical(directory) !== path.resolve(directory)) throw new Error('Runtime directory must not redirect through symbolic links');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await fs.realpath(directory);
  if (resolved !== path.resolve(directory)) throw new Error('Runtime directory must not redirect through symbolic links');
}

async function ownDataRoot(dataRoot) {
  await mkdirPrivate(dataRoot);
  const marker = path.join(dataRoot, '.dsh-forge-runtime.json');
  try {
    await assertRegularTarget(marker);
    const existing = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (existing.owner !== RUNTIME_OWNER || existing.formatVersion !== 1) throw new Error('Runtime directory belongs to another application');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const entries = await fs.readdir(dataRoot);
    if (entries.length !== 0) throw new Error('Runtime directory is not empty and has no DSH Forge ownership marker');
    await writePrivateJson(marker, { owner: RUNTIME_OWNER, formatVersion: 1 });
  }
  await fs.chmod(dataRoot, 0o700);
}

async function refuseActiveManager(dataRoot) {
  const filename = path.join(dataRoot, 'manager.lock.json');
  try {
    await assertRegularTarget(filename);
    const record = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (record.owner !== RUNTIME_OWNER || !Number.isSafeInteger(record.managerPid) || record.managerPid <= 0) throw new Error('Runtime manager ownership cannot be established');
    try { process.kill(record.managerPid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    throw new Error('Stop the active Forge runtime before preparing its private profile');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function resolveRuntimeDependencies(projectRoot, { allowDevelopmentFallback = false } = {}) {
  const require = createRequire(path.join(projectRoot, 'package.json'));
  let cliManifest;
  let botManifest;
  let dependencySource = 'project';
  try {
    cliManifest = require.resolve('@deepseek-ai/dsh/package.json');
    botManifest = require.resolve('deepseekbot/package.json');
  } catch (error) {
    if (!allowDevelopmentFallback) throw new Error('Bundled DSH and DeepSeekBot dependencies are missing; complete the application installation', { cause: error });
    cliManifest = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json';
    botManifest = path.join(homedir(), '.dsh/profiles/desktop/node_modules/deepseekbot/package.json');
    dependencySource = 'development-fallback';
  }
  const cli = JSON.parse(await fs.readFile(cliManifest, 'utf8'));
  const bot = JSON.parse(await fs.readFile(botManifest, 'utf8'));
  if (cli.version !== '0.2.1-rc.3' || bot.version !== '1.4.1') throw new Error('Installed runtime versions do not match DSH Forge compatibility requirements');
  const fusionRoot = path.join(projectRoot, 'packages/fusion');
  const fusion = JSON.parse(await fs.readFile(path.join(fusionRoot, 'package.json'), 'utf8'));
  if (fusion.name !== '@dsh-forge/fusion' || !fusion.dsh?.bundle?.patch) throw new Error('Fusion plugin manifest is missing its DSH bundle declaration');
  return {
    cliPath: path.join(path.dirname(cliManifest), 'lib/bin.js'),
    cliRoot: path.dirname(cliManifest), botRoot: path.dirname(botManifest), fusionRoot,
    dependencySource, runtimeVersion: cli.version, botVersion: bot.version,
  };
}

// Read YAML as data only. In particular, an existing !!js tag is never evaluated.
function cleanModelValue(value, key = '') {
  if (/^(?:__proto__|prototype|constructor|headers|authorization|apiKey|token|password|secret)$/i.test(key)) return OMIT;
  if (value && typeof value === 'object' && value.__forgeUnevaluatedExpression === true) return OMIT;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((item) => cleanModelValue(item)).filter((item) => item !== OMIT);
  if (!value || typeof value !== 'object') return OMIT;
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    const cleaned = cleanModelValue(item, name);
    if (cleaned !== OMIT) result[name] = cleaned;
  }
  return result;
}

export function selectModelPatches(patches) {
  const selected = new Map();
  function merge(previous, incoming) {
    if (!previous || typeof previous !== 'object' || Array.isArray(previous) || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
    const output = { ...previous };
    for (const [key, value] of Object.entries(incoming)) output[key] = merge(output[key], value);
    return output;
  }
  function visit(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      visit(row.insert);
      if (!MODEL_IDS.has(row.id) || !row.config || typeof row.config !== 'object') continue;
      const config = {};
      for (const [key, value] of Object.entries(row.config)) {
        if (!MODEL_FIELDS.has(key)) continue;
        const cleaned = cleanModelValue(value, key);
        if (cleaned !== OMIT) config[key] = cleaned;
      }
      if (Object.keys(config).length) selected.set(row.id, { id: row.id, config: merge(selected.get(row.id)?.config, config) });
    }
  }
  for (const layer of patches) visit(layer);
  return [...selected.values()];
}

export function selectModelCredentials(document, patches) {
  const refs = new Set(['DEEPSEEK_API_KEY']);
  const records = new Set(['deepseek-account-platform/default']);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv)) refs.add(value.apiKeyEnv);
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
  };
  for (const patch of patches) {
    visit(patch.config);
    if (patch.id === 'llm-pi-ai') for (const provider of Object.keys(patch.config?.providers ?? {})) {
      if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(provider)) records.add(`llm-pi-ai/${provider}`);
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Model credential document has an unsupported structure');
  // DSH also recognizes an older flat refs-only document on first startup.
  const source = document.version === undefined && Object.values(document).every((value) => typeof value === 'string')
    ? { version: 1, refs: document } : document;
  if (source.version !== 1) throw new Error('Model credential document has an unsupported version');
  const result = { version: 1, refs: {}, records: {} };
  for (const ref of refs) {
    const value = source.refs?.[ref];
    if (typeof value === 'string' && value.length > 0) result.refs[ref] = value;
  }
  for (const key of records) {
    const record = source.records?.[key];
    if (!record || typeof record !== 'object' || !['grant', 'api-key'].includes(record.kind)) continue;
    const value = { kind: record.kind };
    if (record.kind === 'grant' && record.payload !== undefined) value.payload = JSON.parse(JSON.stringify(record.payload));
    else if (record.kind === 'api-key') {
      if (typeof record.key === 'string' && record.key.length) value.key = record.key;
      if (record.env && typeof record.env === 'object') value.env = Object.fromEntries(Object.entries(record.env).filter(([name, item]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof item === 'string'));
    }
    result.records[key] = value;
  }
  return result;
}

async function inheritModels({ sourceHome, dshHome, require, profilePatch }) {
  const yaml = require('js-yaml');
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: () => ({ __forgeUnevaluatedExpression: true }),
  });
  const schema = yaml.DEFAULT_SCHEMA.extend([expression]);
  const layers = [];
  let skippedFiles = 0;
  // DSH applies the home patch after its profile patch.
  for (const filename of [path.join(sourceHome, 'profiles/desktop/cordis.patch.yml'), path.join(sourceHome, 'cordis.patch.yml'), profilePatch]) {
    try {
      const info = await fs.stat(filename);
      if (info.size > 2 * 1024 * 1024) { skippedFiles++; continue; }
      layers.push(yaml.load(await fs.readFile(filename, 'utf8'), { schema }));
    } catch (error) {
      if (error.code !== 'ENOENT') skippedFiles++;
    }
  }
  const patches = selectModelPatches(layers);
  let credentialsCopied = false;
  let credentialRefs = 0;
  let credentialRecords = 0;
  const destination = path.join(dshHome, '.credentials.yaml');
  await assertRegularTarget(destination);
  try {
    let text;
    try { text = await fs.readFile(destination, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; text = await fs.readFile(path.join(sourceHome, '.credentials.yaml'), 'utf8'); }
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Credential document exceeds the model snapshot size bound');
    let selected;
    try { selected = selectModelCredentials(yaml.load(text, { schema: yaml.JSON_SCHEMA }), patches); }
    catch { throw new Error('Cannot read model credentials safely; configure model access in the private Forge runtime'); }
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, yaml.dump(selected, { noRefs: true, lineWidth: 120 }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, destination);
    } finally { await fs.rm(temp, { force: true }); }
    credentialsCopied = true;
    credentialRefs = Object.keys(selected.refs).length;
    credentialRecords = Object.keys(selected.records).length;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot create the filtered private model credential snapshot'); }
  return { patches, credentialsCopied, skippedFiles, credentialRefs, credentialRecords };
}

async function dependencyLink(profileDir, name, target) {
  const location = path.join(profileDir, 'node_modules', name);
  if (await canonical(path.dirname(location)) !== path.resolve(path.dirname(location))) throw new Error('Runtime dependency directory must not redirect through symbolic links');
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.lstat(location);
    if (!existing.isSymbolicLink()) throw new Error(`Runtime dependency ${name} is not an application-managed link`);
    if (path.resolve(path.dirname(location), await fs.readlink(location)) === path.resolve(target)) return;
    await fs.unlink(location);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.symlink(target, location, 'dir');
}

export async function prepareRuntime({ projectRoot, dataRoot, inheritModelConfig = true, allowDevelopmentFallback = false }) {
  const root = await validateDataRoot(projectRoot, dataRoot);
  await ownDataRoot(root);
  await refuseActiveManager(root);
  const dependencies = await resolveRuntimeDependencies(projectRoot, { allowDevelopmentFallback });
  const dshHome = path.join(root, 'dsh-home');
  const profileDir = path.join(dshHome, 'profiles', RUNTIME_PROFILE);
  await mkdirPrivate(profileDir);
  const marker = path.join(root, 'model-inheritance.json');
  let modelInheritance = { credentialsCopied: false, modelEntries: [], skippedFiles: 0, credentialsPolicyVersion: 2, modelSelectionVersion: 1 };
  let modelPatches = [];
  let existingInheritance = false;
  try {
    await assertRegularTarget(marker);
    modelInheritance = JSON.parse(await fs.readFile(marker, 'utf8'));
    existingInheritance = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if ((!existingInheritance && inheritModelConfig) || (existingInheritance && (modelInheritance.credentialsPolicyVersion !== 2 || modelInheritance.modelSelectionVersion !== 1))) {
      const sourceHome = typeof inheritModelConfig === 'object' && inheritModelConfig.sourceHome
        ? path.resolve(inheritModelConfig.sourceHome) : path.join(homedir(), '.dsh');
      if (inside(root, await canonical(sourceHome))) throw new Error('Model configuration source must be outside the Forge runtime');
      const inherited = await inheritModels({ sourceHome, dshHome, require: createRequire(path.join(dependencies.cliRoot, 'package.json')), profilePatch: path.join(profileDir, 'cordis.patch.yml') });
      modelPatches = inherited.patches;
      modelInheritance = { credentialsCopied: inherited.credentialsCopied, modelEntries: modelPatches.map((row) => row.id), skippedFiles: inherited.skippedFiles, credentialRefs: inherited.credentialRefs, credentialRecords: inherited.credentialRecords, credentialsPolicyVersion: 2, modelSelectionVersion: 1 };
  }
  const manifestPath = path.join(profileDir, 'package.json');
  let manifest = { name: 'dsh-forge-runtime-profile', private: true, dependencies: {} };
  try {
    await assertRegularTarget(manifestPath);
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  manifest.dsh ??= {};
  manifest.dsh.profile ??= {};
  manifest.dsh.profile.bundles = [...new Set([...REQUIRED_BUNDLES, ...(manifest.dsh.profile.bundles ?? [])])];
  manifest.dependencies = { ...manifest.dependencies, deepseekbot: '1.4.1', '@dsh-forge/fusion': `file:${dependencies.fusionRoot}` };
  await writePrivateJson(manifestPath, manifest);
  await dependencyLink(profileDir, 'deepseekbot', dependencies.botRoot);
  await dependencyLink(profileDir, '@dsh-forge/fusion', dependencies.fusionRoot);
  const profilePatch = path.join(profileDir, 'cordis.patch.yml');
  const yaml = createRequire(path.join(dependencies.cliRoot, 'package.json'))('js-yaml');
  try {
    await assertRegularTarget(profilePatch);
    await fs.access(profilePatch);
    const defaultModel = modelPatches.find((row) => row.id === 'agent-default-model');
    if (defaultModel) {
      const text = await fs.readFile(profilePatch, 'utf8');
      // Keep any default selection saved by this client; otherwise inherit only
      // the user's selected provider/model, never unrelated profile patches.
      if (!/(?:^|\n)\s*-\s*id:\s*["']?agent-default-model["']?\s*(?:\n|$)/.test(text)) {
        await fs.appendFile(profilePatch, `${text.endsWith('\n') ? '' : '\n'}${yaml.dump([defaultModel], { noRefs: true, lineWidth: 120 })}`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const patches = [
      ...modelPatches,
      // These optional integrations must not touch existing browser, computer or IM data.
      { id: 'xmanrui-dsh-im', disabled: true },
      { id: 'botharness-browser', disabled: true },
      { id: 'botharness-computer', disabled: true },
    ];
    await fs.writeFile(profilePatch, yaml.dump(patches, { noRefs: true, lineWidth: 120 }), { flag: 'wx', mode: 0o600 });
  }
  await writePrivateJson(marker, modelInheritance);
  const sharedAgents = path.join(homedir(), '.agents', 'AGENTS.md');
  // Rules can be inherited explicitly without copying unrelated profile/tool configuration.
  const globalRules = path.join(dshHome, 'AGENTS.md');
  try {
    await assertRegularTarget(globalRules);
    await fs.copyFile(path.join(homedir(), '.dsh', 'AGENTS.md'), globalRules, constants.COPYFILE_EXCL);
    await fs.chmod(globalRules, 0o600);
  } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  return {
    projectRoot: path.resolve(projectRoot), dataRoot: root, dshHome, profileName: RUNTIME_PROFILE,
    profileDir, ...dependencies, modelInheritance, sharedAgentsRulesAvailable: await fs.access(sharedAgents).then(() => true, () => false),
  };
}
