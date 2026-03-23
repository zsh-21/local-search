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
// 启动索引初始化任务只允许执行一次，避免重复触发导致多次重建。
let startupIndexBootstrapPromise: Promise<void> | null = null;
const TRAY_WARMUP_TIMEOUT_MS = 3000;
const ICON_FIRST_ROUND_TIMEOUT_MS = 1200;
const ICON_FIRST_ROUND_MAX_COUNT = 180;
const ICON_FIRST_ROUND_CONCURRENCY = 2;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

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

// 注册 IPC 处理函数。
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
    // 启动即恢复持久化图标缓存，优先提升首轮搜索命中速度。
    loadPersistedAppIconCache();
    const initialSettings = loadSettings();

    // 隐藏创建搜索窗口，提前完成渲染资源预热，避免托盘出现后首次呼出卡顿。
    createWindow();
    // 先读取应用缓存并异步刷新系统应用列表，为图标预热准备候选数据。
    loadInstalledApps();
    // 尽早建立开始菜单快捷方式索引，提升应用图标解析命中率。
    setTimeout(() => void ensureStartMenuShortcutIndex(), 0);

    // 核心预热任务：设置/历史快照、索引缓存、首轮图标补热（图标补热仅预算内阻塞托盘）。
    const bootstrapWarmupPromise = primeBootstrapState(initialSettings).catch(() => undefined);
    // 索引忽略规则与缓存加载串联执行，既保证顺序正确，也能纳入 3 秒托盘兜底预算。
    const indexCacheLoadPromise = fileIndex
      .setIgnoredPaths(initialSettings.ignoredPaths, initialSettings.preferredFileExtensions)
      .then(() => fileIndex.loadCache())
      .catch(() => false);
    const runStartupIndexBootstrapOnce = () => {
      // 启动索引流程使用 single-flight 守卫：同一启动周期内最多触发一次完整初始化链路。
      if (startupIndexBootstrapPromise) return startupIndexBootstrapPromise;
      startupIndexBootstrapPromise = (async () => {
        try {
          const currentAppVersion = app.getVersion();
          // 复用启动阶段缓存加载任务，保证顺序固定为 loadCache -> 判定 -> rebuild/buildIfEmpty。
          const cacheLoaded = await indexCacheLoadPromise;
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
            await fileIndex.rebuild();
            return;
          }
          if (!cacheLoaded) {
            await fileIndex.buildIfEmpty();
          }
        } catch {}
      })();
      return startupIndexBootstrapPromise;
    };
    const firstRoundIconPrewarmPromise = prewarmInstalledAppIcons(getInstalledAppsCache(), {
      maxCount: ICON_FIRST_ROUND_MAX_COUNT,
      concurrency: ICON_FIRST_ROUND_CONCURRENCY,
    }).catch(() => undefined);

    const coreWarmupPromise = Promise.all([
      bootstrapWarmupPromise,
      indexCacheLoadPromise.then(() => undefined),
      Promise.race([firstRoundIconPrewarmPromise, sleep(ICON_FIRST_ROUND_TIMEOUT_MS)]),
    ]);

    // 托盘/快捷键在核心预热完成后注册；若预热过慢，3 秒后兜底放行。
    await Promise.race([coreWarmupPromise, sleep(TRAY_WARMUP_TIMEOUT_MS)]);
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

    // 保留后续两轮补热，覆盖启动后动态刷新到的新应用列表。
    setTimeout(() => {
      const apps = getInstalledAppsCache();
      void prewarmInstalledAppIcons(apps, { maxCount: 320, concurrency: 3 });
    }, 2000);
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

    // 面板显示或其他流程不会重复触发全量索引初始化：统一收口到启动期单例任务。
    void runStartupIndexBootstrapOnce();
  });
}

app.on('will-quit', () => {
  stopResourceGuard();
  stopIndexStatsWriter();
  globalShortcut.unregisterAll();
  closeAllWatchers();
});
