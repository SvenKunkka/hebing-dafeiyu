import { app, BrowserWindow, dialog, shell } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startRuntime } from './runtime.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
app.setName('DSH Forge');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  let runtime;
  let stopping = false;
  let quitting = false;
  let startupPromise;
  const startupController = new AbortController();
  const html = (title, body) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>DSH Forge</title><style>body{background:#f6f8fc;color:#1e293b;font:15px system-ui;margin:0;display:grid;place-content:center;min-height:100vh}main{max-width:520px;padding:36px}h1{font-size:30px;letter-spacing:-.8px}p{line-height:1.8;color:#53617b}.brand{color:#405cd9;font-weight:700}</style><main><div class="brand">DSH Forge</div><h1>${title}</h1><p>${body}</p></main>`)}`;
  function makeWindow() {
    window = new BrowserWindow({ width: 1380, height: 900, minWidth: 480, minHeight: 620, title: 'DSH Forge', backgroundColor: '#f6f8fc', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
    window.on('page-title-updated', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (runtime && new URL(url).origin !== runtime.origin) {
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });
    window.loadURL(html('正在准备机器人工作台', '启动独立的机器人运行环境。你的现有 DSH 资料会保留在原位置。'));
    window.on('closed', () => { window = undefined; });
  }
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    startupController.abort(new Error("应用已关闭"));
    Promise.resolve(startupPromise).catch(() => {}).then(() => runtime?.stop()).finally(() => { quitting = true; app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.whenReady().then(async () => {
    makeWindow();
    const dataRoot = process.env.DSH_FORGE_APP_DATA ?? join(app.getPath('userData'), 'workspace');
    const bundledNode = join(process.resourcesPath, 'node', 'bin', 'node');
    const nodePath = existsSync(bundledNode) ? bundledNode : '/opt/homebrew/bin/node';
    try {
      startupPromise = startRuntime({ projectRoot, dataRoot, nodePath, signal: startupController.signal, onLog: line => { if (process.env.DSH_FORGE_DEBUG === '1') process.stdout.write(`${line}\n`); } });
      runtime = await startupPromise;
      if (!window || stopping) { await runtime.stop(); return; }
      await window.loadURL(runtime.url);
      window.setTitle('DSH Forge');
    } catch (error) {
      const safeMessage = String(error.message).replace(/[?&]token=[^\s"<>]+/g, '?token=[hidden]').replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]);
      if (window) await window.loadURL(html('运行环境暂未启动', `${safeMessage}<br>请重新打开应用重试。资料不会因启动失败被清理。`));
      else dialog.showErrorBox('DSH Forge 未启动', safeMessage);
    }
  });
}
