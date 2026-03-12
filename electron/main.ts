import { app, globalShortcut, BrowserWindow } from 'electron';
import path from 'node:path';
import { loadSettings } from './config/settings';
import { fileIndex, loadFileIndexMeta, saveFileIndexMeta, clearFileIndexCacheOnDisk, FILE_INDEX_VERSION } from './file/indexService';
import { startUserDirectoryWatchers, closeAllWatchers, trimRecentIndex } from './file/watcher';
import {
  createWindow,
  openSearchWindow,
  toggleSearchWindow,
  showSettingsWindow,
  handleQuickItemPicked,
  registerShortcutsForSettings,
  closeAllWindows,
} from './window/windowManager';
import { ensureTray, getDefaultTrayIconPath } from './app/tray';
import { loadInstalledApps } from './apps/installedApps';
import { ensureStartMenuShortcutIndex } from './win/startMenuShortcutIndex';
import { registerIpcHandlers } from './ipc/ipcHandlers';
import { ensureWindowsAppContextMenu } from './win/contextMenu';
import { handleAddToQuickListArgv } from './app/quickList';
import { clearIconCaches } from './icon/iconService';

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');

let resourceGuardTimer: ReturnType<typeof setInterval> | null = null;
let resourceGuardInFlight = false;

function startResourceGuard() {
  if (resourceGuardTimer) {
    clearInterval(resourceGuardTimer);
    resourceGuardTimer = null;
  }
  resourceGuardTimer = setInterval(() => {
    if (resourceGuardInFlight) return;
    resourceGuardInFlight = true;
    void (async () => {
      try {
        const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
        if (rssMb >= 800) {
          await clearIconCaches();
          trimRecentIndex(4000);
          const status = await fileIndex.getStatus();
          if (status.isIndexing) {
            await fileIndex.abortRebuild();
            fileIndex.pauseIndexingFor(30_000);
          }
          return;
        }
        if (rssMb >= 600) {
          await clearIconCaches();
          trimRecentIndex(8000);
          fileIndex.pauseIndexingFor(10_000);
        }
      } catch {}
      finally {
        resourceGuardInFlight = false;
      }
    })();
  }, 60 * 1000);
}

function stopResourceGuard() {
  if (!resourceGuardTimer) return;
  clearInterval(resourceGuardTimer);
  resourceGuardTimer = null;
}

// 注册 IPC 处理函数
registerIpcHandlers();

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    closeAllWindows();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (Array.isArray(argv) && handleAddToQuickListArgv(argv)) return;
    openSearchWindow();
  });

  app.whenReady().then(async () => {
    const initialSettings = loadSettings();
    // 初始化时同步设置忽略规则（主进程缓存 + Worker 内索引规则）
    await fileIndex.setIgnoredPaths(initialSettings.ignoredPaths, initialSettings.preferredFileExtensions);
    createWindow();
    ensureTray({
      getIconPath: getDefaultTrayIconPath,
      toggleSearchWindow,
      showSettingsWindow,
      onAddQuickItemPath: handleQuickItemPicked,
    });
    registerShortcutsForSettings({
      searchShortcut: initialSettings.searchShortcut,
      settingsShortcut: initialSettings.settingsShortcut,
    });
    loadInstalledApps();
    void ensureWindowsAppContextMenu();
    try {
      handleAddToQuickListArgv(process.argv);
    } catch {}
    void startUserDirectoryWatchers();
    startResourceGuard();
    app.setLoginItemSettings({ openAtLogin: initialSettings.autoStart, openAsHidden: true, path: app.getPath('exe') });

    setTimeout(() => void ensureStartMenuShortcutIndex(), 0);
    void (async () => {
      try {
        const currentAppVersion = app.getVersion();
        const metaBefore = loadFileIndexMeta();
        const shouldRebuildBecauseUpdated =
          Boolean(metaBefore) && (typeof metaBefore?.appVersion !== 'string' || metaBefore.appVersion !== currentAppVersion);
        if (shouldRebuildBecauseUpdated) {
          await fileIndex.abortRebuild();
          await fileIndex.reset();
          await clearFileIndexCacheOnDisk();
        }

        await fileIndex.loadCache();
        const meta = loadFileIndexMeta();
        if (!meta || meta.version !== FILE_INDEX_VERSION || shouldRebuildBecauseUpdated) {
          // 版本不一致时需要彻底复位再重建：避免旧索引残留影响结果
          await fileIndex.reset();
          await fileIndex.rebuild();
          saveFileIndexMeta({ version: FILE_INDEX_VERSION, appVersion: currentAppVersion });
        } else {
          await fileIndex.buildIfEmpty();
        }
      } catch {}
    })();
  });
}

app.on('will-quit', () => {
  stopResourceGuard();
  globalShortcut.unregisterAll();
  closeAllWatchers();
});
