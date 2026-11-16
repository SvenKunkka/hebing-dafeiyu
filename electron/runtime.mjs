import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareRuntime, validateDataRoot, writePrivateJson } from '../scripts/runtime-profile.mjs';
import { homedir } from 'node:os';

export { prepareRuntime } from '../scripts/runtime-profile.mjs';

const ownedRuntimes = new Map();

export function redactRuntimeLog(value) {
  return String(value)
    .replace(/([?&](?:token|key|secret|password)=)[^\s&#]+/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api.?key|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 1800);
}

export function parseReadyUrl(line) {
  if (!line.startsWith('dsh web: http://')) return null;
  let url;
  try { url = new URL(line.slice('dsh web: '.length).trim()); } catch { return null; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !url.searchParams.get('token')) return null;
  if (Number(url.port) < 1 || Number(url.port) > 65535) return null;
  return { url: url.href, origin: url.origin };
}

async function acquireLock(dataRoot) {
  const filename = path.join(dataRoot, 'manager.lock.json');
  const nonce = randomUUID();
  const record = { owner: 'dsh-forge', managerPid: process.pid, nonce };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(filename, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (current.nonce === nonce) await fs.unlink(filename);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe runtime lock file');
      let current;
      try { current = JSON.parse(await fs.readFile(filename, 'utf8')); } catch { throw new Error('Runtime lock is invalid; inspect the private runtime directory'); }
      if (current.owner !== 'dsh-forge' || !Number.isSafeInteger(current.managerPid) || current.managerPid <= 0) throw new Error('Runtime lock belongs to an unknown owner');
      try { process.kill(current.managerPid, 0); }
      catch (failure) {
        if (failure.code === 'ESRCH') {
          // The parent may have crashed while its runtime kept writing the same DB.
          // Never launch a second writer merely because the manager PID is gone.
          let prior;
          try { prior = JSON.parse(await fs.readFile(path.join(dataRoot, 'runtime.json'), 'utf8')); }
          catch (readError) { if (readError.code !== 'ENOENT') throw new Error('Cannot establish whether the prior runtime has stopped'); }
          if (prior?.owner === 'dsh-forge' && ['starting', 'ready'].includes(prior.state) && Number.isSafeInteger(prior.pid) && prior.pid > 0) {
            try { process.kill(prior.pid, 0); }
            catch (runtimeError) {
              if (runtimeError.code !== 'ESRCH') throw runtimeError;
              prior = undefined;
            }
            if (prior) throw new Error('The previous Forge runtime may still be running; close it before reopening this data directory');
          }
          await fs.unlink(filename); continue;
        }
        throw failure;
      }
      throw new Error('This Forge data directory already has a running runtime manager');
    }
  }
  throw new Error('Unable to acquire the private runtime lock');
}

function closed(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function abortError() {
  const error = new Error('Private DSH runtime startup was cancelled');
  error.name = 'AbortError';
  return error;
}

async function stopChild(child, graceMs = 5500) {
  if (closed(child)) return;
  await new Promise((resolve) => {
    let hardTimeout;
    const finish = () => { clearTimeout(timer); clearTimeout(hardTimeout); resolve(); };
    child.once('exit', finish);
    const timer = setTimeout(() => {
      if (!closed(child)) child.kill('SIGKILL');
      hardTimeout = setTimeout(finish, 1500);
    }, graceMs);
    child.kill('SIGTERM');
    if (closed(child)) finish();
  });
}

async function launch(options) {
  const { projectRoot, nodePath, onLog = () => {}, startupTimeoutMs = 120000 } = options;
  if (options.signal?.aborted) throw abortError();
  const prepared = await prepareRuntime(options);
  if (options.signal?.aborted) throw abortError();
  const releaseLock = await acquireLock(prepared.dataRoot);
  const statusPath = path.join(prepared.dataRoot, 'runtime.json');
  let child;
  let stopTask;
  let exitObserved = false;
  let ready = false;
  let origin;
  let statusWrite = Promise.resolve();
  const status = (state, extra = {}) => {
    const record = {
      owner: 'dsh-forge', formatVersion: 1, state, pid: child?.pid ?? null,
      origin: origin ?? null, profile: prepared.profileName, dshHome: prepared.dshHome,
      runtimeVersion: prepared.runtimeVersion, botVersion: prepared.botVersion,
      dependencySource: prepared.dependencySource, updatedAt: new Date().toISOString(), ...extra,
    };
    statusWrite = statusWrite.catch(() => {}).then(() => writePrivateJson(statusPath, record));
    return statusWrite;
  };
  const log = (line) => { try { onLog(redactRuntimeLog(line)); } catch { /* UI log sinks cannot own the process lifetime. */ } };
  try {
    if (options.signal?.aborted) throw abortError();
    const executable = nodePath ?? process.env.DSH_FORGE_NODE_PATH ?? (process.versions.electron ? '/opt/homebrew/bin/node' : process.execPath);
    if (!path.isAbsolute(executable)) throw new Error('The Node runtime executable must use an absolute path');
    await fs.access(executable);
    await status('starting');
    child = spawn(executable, [prepared.cliPath, '--profile', prepared.profileName, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: projectRoot,
      env: {
        ...process.env, DSH_HOME: prepared.dshHome, DSH_TELEMETRY_DISABLED: '1',
        PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
        DSH_PRODUCT_ANALYTICS_ENABLED: 'false',
        DSH_FORGE_DATA_ROOT: prepared.dataRoot,
        DSH_FORGE_HOME: prepared.dshHome,
        DSH_FORGE_SOURCE_HOME: typeof options.inheritModelConfig === 'object' && options.inheritModelConfig.sourceHome
          ? path.resolve(options.inheritModelConfig.sourceHome) : path.join(homedir(), '.dsh'),
        // Electron-as-Node is an explicit carrier choice made by the packager.
        ...(process.versions.electron && executable === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    log('Starting the private DSH runtime.');
    const waitForReady = new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const diagnostics = [];
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => settle(abortError());
      const timeout = setTimeout(() => settle(new Error('The private DSH runtime did not become ready before the startup deadline')), startupTimeoutMs);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const diagnostic = (line) => {
        if (!line.trim()) return;
        diagnostics.push(redactRuntimeLog(line));
        if (diagnostics.length > 8) diagnostics.shift();
      };
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 256 * 1024) stdout = stdout.slice(-128 * 1024);
        let newline;
        while ((newline = stdout.indexOf('\n')) !== -1) {
          const line = stdout.slice(0, newline).replace(/\r$/, ''); stdout = stdout.slice(newline + 1);
          const parsed = parseReadyUrl(line);
          if (parsed && !ready) { ready = true; origin = parsed.origin; settle(null, parsed); }
          else if (!ready && /(?:error|fail|cannot|warn|@dsh-forge\/fusion|forge-fusion)/i.test(line) && !/(?:credential|api.?key|grant|authorization|password|secret)/i.test(line)) log(`Startup diagnostic: ${line}`);
          // Raw child output may contain user content and is never forwarded to the UI.
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024);
        let newline;
        while ((newline = stderr.indexOf('\n')) !== -1) {
          const line = stderr.slice(0, newline); diagnostic(line); stderr = stderr.slice(newline + 1);
          if (!ready && /(?:error|fail|cannot|warn|@dsh-forge\/fusion|forge-fusion)/i.test(line) && !/(?:credential|api.?key|grant|authorization|password|secret)/i.test(line)) log(`Startup diagnostic: ${line}`);
        }
      });
      child.once('error', (error) => { settle(new Error(`The private DSH runtime could not start: ${redactRuntimeLog(error.message)}`)); });
      child.once('exit', (code, signal) => {
        exitObserved = true; clearTimeout(timeout);
        void status('stopped', { exitCode: code, signal }).catch(() => {});
        void releaseLock().catch(() => {});
        ownedRuntimes.delete(prepared.dataRoot);
        log(`Private DSH runtime stopped (${signal ?? code ?? 'unknown'}).`);
        if (!ready) {
          diagnostic(stderr);
          settle(new Error(`The private DSH runtime exited before readiness (${signal ?? code ?? 'unknown'}). ${diagnostics.join('\n')}`));
        }
      });
    });
    void waitForReady.catch(() => {});
    await status('starting');
    const result = await waitForReady;
    if (options.signal?.aborted) throw abortError();
    if (closed(child)) throw new Error('The private DSH runtime exited during startup readiness');
    await status('ready');
    if (options.signal?.aborted) throw abortError();
    if (closed(child)) throw new Error('The private DSH runtime exited during startup readiness');
    log(`Private DSH runtime ready at ${result.origin}.`);
    return {
      ...result, pid: child.pid, dataRoot: prepared.dataRoot, dshHome: prepared.dshHome,
      stop() {
        stopTask ??= (async () => {
          await stopChild(child);
          await status('stopped');
          await releaseLock();
          ownedRuntimes.delete(prepared.dataRoot);
        })();
        return stopTask;
      },
    };
  } catch (error) {
    if (child) await stopChild(child);
    await status('failed', { error: redactRuntimeLog(error.message) }).catch(() => {});
    await releaseLock();
    throw error;
  }
}

export async function startRuntime(options) {
  if (options.signal?.aborted) throw abortError();
  const key = await validateDataRoot(options.projectRoot, options.dataRoot);
  if (ownedRuntimes.has(key)) return ownedRuntimes.get(key);
  const pending = launch(options).catch((error) => { ownedRuntimes.delete(key); throw error; });
  ownedRuntimes.set(key, pending);
  return pending;
}
