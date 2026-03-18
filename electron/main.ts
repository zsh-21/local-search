import { app, globalShortcut, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSettings } from './config/settings';
import { fileIndex, loadFileIndexMeta, saveFileIndexMeta, FILE_INDEX_VERSION } from './file/indexService';
import { SystemDetector } from './file/systemDetector';
import { getFileIndexStatsPath } from './constants/storagePaths';
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
import { getInstalledAppsCache, loadInstalledApps } from './apps/installedApps';
import { ensureStartMenuShortcutIndex } from './win/startMenuShortcutIndex';
import { registerIpcHandlers } from './ipc/ipcHandlers';
import { ensureWindowsAppContextMenu } from './win/contextMenu';
import { handleAddToQuickListArgv } from './app/quickList';
import { clearIconCaches, prewarmInstalledAppIcons } from './icon/iconService';
import { loadPersistedAppIconCache } from './icon/iconCache';
import { primeBootstrapState, setBootstrapIndexStatus } from './app/bootstrapState';

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');

let resourceGuardTimer: ReturnType<typeof setInterval> | null = null;
let resourceGuardInFlight = false;
let indexStatsTimer: ReturnType<typeof setInterval> | null = null;
let indexStatsInFlight = false;
let lastIndexStatsSignature = '';
let lastIndexingState = false;

function buildDriveSignature(drives: Array<{ mountPoint?: string }>) {
  const list = drives
    .map((d) => String(d?.mountPoint || '').trim())
    .filter(Boolean)
    .map((d) => d.toUpperCase())
    .sort();
  return list.join('|');
}

function startIndexStatsWriter() {
  if (indexStatsTimer) {
    clearInterval(indexStatsTimer);
    indexStatsTimer = null;
  }
  const statsPath = getFileIndexStatsPath();
  indexStatsTimer = setInterval(() => {
    if (indexStatsInFlight) return;
    indexStatsInFlight = true;
    void (async () => {
      try {
        const [stats, status] = await Promise.all([fileIndex.getDriveStats(), fileIndex.getStatus()]);
        const signature = JSON.stringify({
          totalCount: stats.totalCount,
          drives: stats.drives,
          isIndexing: status.isIndexing,
        });
        if (signature !== lastIndexStatsSignature) {
          const payload = {
            updatedAt: new Date().toISOString(),
            isIndexing: status.isIndexing,
            totalCount: stats.totalCount,
            drives: stats.drives,
          };
          await fs.mkdir(path.dirname(statsPath), { recursive: true }).catch(() => {});
          await fs.writeFile(statsPath, JSON.stringify(payload, null, 2), 'utf-8');
          lastIndexStatsSignature = signature;
        }
        if (lastIndexingState && !status.isIndexing) {
          const driveSummary = Array.isArray(stats.drives)
            ? stats.drives.map((d) => `${d.drive}=${d.count}`).join(', ')
            : '';
          console.log(`[index] complete total=${stats.totalCount} drives=${driveSummary}`);
        }
        lastIndexingState = status.isIndexing;
      } catch {
      } finally {
        indexStatsInFlight = false;
      }
    })();
  }, 2000);
}

function stopIndexStatsWriter() {
  if (!indexStatsTimer) return;
  clearInterval(indexStatsTimer);
  indexStatsTimer = null;
}

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
    // 启动即回填持久化的 app 图标缓存，保证搜索链路优先走缓存命中
    loadPersistedAppIconCache();
    const initialSettings = loadSettings();
    // 启动预热：在窗口真正可见前先把设置与历史快照准备好，面板打开直接使用。
    await primeBootstrapState(initialSettings);
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
    // 应用列表加载后异步预热图标缓存，减少“首次搜索才抓图标”的冷启动成本
    setTimeout(() => {
      const apps = getInstalledAppsCache();
      void prewarmInstalledAppIcons(apps, { maxCount: 320, concurrency: 3 });
    }, 2000);
    // 延后再做一次补充预热，覆盖启动后动态刷新到的新应用列表
    setTimeout(() => {
      const apps = getInstalledAppsCache();
      void prewarmInstalledAppIcons(apps, { maxCount: 480, concurrency: 2 });
    }, 12000);
    void ensureWindowsAppContextMenu();
    try {
      handleAddToQuickListArgv(process.argv);
    } catch {}
    void startUserDirectoryWatchers();
    startResourceGuard();
    startIndexStatsWriter();
    app.setLoginItemSettings({ openAtLogin: initialSettings.autoStart, openAsHidden: true, path: app.getPath('exe') });

    setTimeout(() => void ensureStartMenuShortcutIndex(), 0);
    void (async () => {
      try {
        const currentAppVersion = app.getVersion();
        // 索引持久化策略：
        // - 只加载本地缓存（可秒级可用），不再触发“全盘重建/扫描”
        // - 运行期的新增/删除/改动由 watcher 增量更新并落盘
        const cacheLoaded = await fileIndex.loadCache();
        const meta = loadFileIndexMeta();
        const systemInfo = await SystemDetector.getInstance().detect();
        const driveSignature = buildDriveSignature(systemInfo?.drives || []);
        const shouldRebuild =
          !meta ||
          meta.version !== FILE_INDEX_VERSION ||
          meta.appVersion !== currentAppVersion ||
          meta.driveSignature !== driveSignature;
        setBootstrapIndexStatus({ hasCache: cacheLoaded, isIndexing: shouldRebuild || !cacheLoaded });
        if (shouldRebuild) {
          saveFileIndexMeta({ version: FILE_INDEX_VERSION, appVersion: currentAppVersion, driveSignature });
          void fileIndex.rebuild();
        } else if (!cacheLoaded) {
          void fileIndex.buildIfEmpty();
        }
      } catch {}
    })();
  });
}

app.on('will-quit', () => {
  stopResourceGuard();
  stopIndexStatsWriter();
  globalShortcut.unregisterAll();
  closeAllWatchers();
});
