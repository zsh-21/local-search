import { app, globalShortcut, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadSettings } from './config/settings';
import {
  fileIndex,
  type FileIndexCacheLoadReport,
  getWorkerCount,
  loadFileIndexMeta,
  saveFileIndexMeta,
  FILE_INDEX_LAYOUT_VERSION,
  FILE_INDEX_VERSION,
  clearFileIndexCacheOnDisk,
} from './file/indexService';
import { getFileIndexStatsPath } from './constants/storagePaths';
import {
  closeAllWatchers,
  getWatcherBacklogSize,
  reconcileRecentIndex,
  startUserDirectoryWatchers,
  trimRecentIndex,
} from './file/watcher';
import {
  INDEX_STATS_REFRESH_COOLDOWN_INTERVAL_MS,
  INDEX_STATS_REFRESH_COOLDOWN_WINDOW_MS,
  INDEX_STATS_REFRESH_FAILSAFE_INTERVAL_MS,
  INDEX_STATS_REFRESH_IDLE_INTERVAL_MS,
  INDEX_STATS_REFRESH_INDEXING_INTERVAL_MS,
  INDEX_STATS_REFRESH_MIN_STAY_MS,
  WATCH_BACKLOG_RECONCILE_THRESHOLD,
} from './constants/initialValues';
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
import { clearPersistedIconStore, restoreIconManifest } from './icon/iconCache';
import { primeBootstrapState, setBootstrapIndexStatus } from './app/bootstrapState';
import { SafeTimeoutRegistry } from './utils/safeTimeoutRegistry';
import { IPC_EVENT_INDEX_MANUAL_REFRESH_DONE } from '../shared/ipc/channels';
process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');
/** 资源守护定时器句柄 */ let resourceGuardTimer: ReturnType<typeof setInterval> | null = null;
/** 资源守护任务并发锁 */ let resourceGuardInFlight = false;
/** 主进程超时定时器注册器 */ const timeoutRegistry = new SafeTimeoutRegistry();
/** 索引状态写盘任务的定时器键 */ const INDEX_STATS_TIMER_KEY = 'index-stats-writer';
/** 索引状态写盘并发锁 */ let indexStatsInFlight = false;
/** 索引状态写盘是否启用 */ let indexStatsWriterActive = false;
/** 索引状态写盘运行代次 */ let indexStatsWriterRunId = 0;
/** 最近一次写盘签名 */ let lastIndexStatsSignature = '';
/** 上一轮是否处于索引中 */ let lastIndexingState = false;
/** 最近一次索引开始时间 */ let lastIndexingStartedAt = 0;
/** 当前生效的索引状态轮询间隔 */ let lastIndexStatsDelayMs = INDEX_STATS_REFRESH_INDEXING_INTERVAL_MS;
/** 最近一次切换轮询间隔时间 */ let lastIndexStatsDelaySwitchedAt = 0;
/** 最近一次完成日志签名 */ let lastIndexCompleteSignature = '';
/** 最近一次完成日志时间 */ let lastIndexCompleteAt = 0;
/** 启动索引流程是否进行中 */ let startupIndexBootstrapInFlight = false;
/** 启动索引流程是否已结束 */ let startupIndexBootstrapFinished = false;
/** 启动索引初始化任务仅允许运行一次，避免重复触发重建 */
let startupIndexBootstrapPromise: Promise<void> | null = null;
/** 托盘初始化最大等待时间 */ const TRAY_WARMUP_TIMEOUT_MS = 3000;
/** 首轮图标预热超时 */ const ICON_FIRST_ROUND_TIMEOUT_MS = 1200;
/** 首轮图标预热数量上限 */ const ICON_FIRST_ROUND_MAX_COUNT = 180;
/** 首轮图标预热线程并发 */ const ICON_FIRST_ROUND_CONCURRENCY = 2;
/** 索引完成日志去重窗口 */ const INDEX_COMPLETE_DEDUP_WINDOW_MS = 60_000;
/** 手动刷新补偿扫描预算 */ const INDEX_MANUAL_RECONCILE_BUDGET_MS = 700;
function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
/** 索引状态快照结构：用于写盘、日志和手动刷新回传 */
type IndexStatsSnapshot = {
  isIndexing: boolean;
  progress: number;
  totalCount: number;
  drives: Array<{ drive: string; count: number }>;
};
/** 托盘手动刷新结果结构：用于日志与渲染层广播 */
type ManualRefreshSummary = IndexStatsSnapshot & {
  updatedAt: string;
  durationMs: number;
  backlogSize: number;
  reconcileTriggered: boolean;
  errors: string[];
};
/** 启动阶段缓存报告兜底值：用于 loadCache 异常时保持后续流程可判定 */
function createFallbackCacheLoadReport(workerCount: number): FileIndexCacheLoadReport {
  return { workerCount, totalShards: workerCount, activeShardCount: 0, loadedShardCount: 0, loadedActiveShardCount: 0, perShardLoaded: Array.from({ length: workerCount }, () => false), perShardHasRoots: Array.from({ length: workerCount }, () => false), missingActiveShardIndices: [], hasAnyCache: false, isPartial: false };
}
/** 根据当前索引状态与异常状态计算目标轮询间隔 */
function resolveIndexStatsTargetDelayMs(isIndexing: boolean, hasError: boolean) {
  if (hasError) return INDEX_STATS_REFRESH_FAILSAFE_INTERVAL_MS;
  if (isIndexing) return INDEX_STATS_REFRESH_INDEXING_INTERVAL_MS;
  if (Date.now() - lastIndexCompleteAt <= INDEX_STATS_REFRESH_COOLDOWN_WINDOW_MS) {
    return INDEX_STATS_REFRESH_COOLDOWN_INTERVAL_MS;
  }
  return INDEX_STATS_REFRESH_IDLE_INTERVAL_MS;
}
/** 轮询间隔防抖：避免“索引中/空闲/失败”频繁切换导致调度抖动 */
function resolveStableIndexStatsDelayMs(targetDelayMs: number) {
  if (targetDelayMs === lastIndexStatsDelayMs) return targetDelayMs;
  const now = Date.now();
  if (
    lastIndexStatsDelaySwitchedAt > 0 &&
    now - lastIndexStatsDelaySwitchedAt < INDEX_STATS_REFRESH_MIN_STAY_MS
  ) {
    return lastIndexStatsDelayMs;
  }
  lastIndexStatsDelayMs = targetDelayMs;
  lastIndexStatsDelaySwitchedAt = now;
  return targetDelayMs;
}
/** 调度下一轮索引状态刷新 */
function scheduleNextIndexStatsTick(runId: number, delayMs: number) {
  if (!indexStatsWriterActive || runId !== indexStatsWriterRunId) return;
  const nextDelayMs = Math.max(200, Math.floor(Number(delayMs) || 0));
  timeoutRegistry.schedule(INDEX_STATS_TIMER_KEY, nextDelayMs, () => {
    if (!indexStatsWriterActive || runId !== indexStatsWriterRunId) return;
    void runIndexStatsTick(runId);
  });
}
/** 拉取索引状态并写入状态文件，同时处理“索引完成”边沿日志 */
async function collectAndPersistIndexStats(forceWrite = false): Promise<IndexStatsSnapshot> {
  /** 索引状态写盘文件路径 */ const statsPath = getFileIndexStatsPath();
  /** 并行拉取盘符统计与索引状态 */ const [stats, status] = await Promise.all([fileIndex.getDriveStats(), fileIndex.getStatus()]);
  /** 原始进度值 */ const progressRaw = Number(status?.progress);
  /** 归一化后的进度值 */ const progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(1, progressRaw)) : 0;
  /** 当前是否处于索引中 */ const isIndexing = Boolean(status?.isIndexing);
  /** 盘符统计明细 */ const drives = Array.isArray(stats?.drives) ? stats.drives : [];
  /** 当前索引总量 */ const totalCount = Number(stats?.totalCount) || 0;
  /** 本轮状态签名 */ const signature = JSON.stringify({
    totalCount,
    drives,
    isIndexing,
    progress,
  });
  /** 状态变化或强制刷新时才写盘，减少磁盘写入频率 */
  if (forceWrite || signature !== lastIndexStatsSignature) {
    /** 持久化状态载荷 */ const payload = {
      updatedAt: new Date().toISOString(),
      isIndexing,
      progress,
      totalCount,
      drives,
    };
    await fs.mkdir(path.dirname(statsPath), { recursive: true }).catch(() => {});
    await fs.writeFile(statsPath, JSON.stringify(payload, null, 2), 'utf-8');
    lastIndexStatsSignature = signature;
  }
  /** 记录索引开始时间，供完成日志打印耗时 */
  if (!lastIndexingState && isIndexing) {
    lastIndexingStartedAt = Date.now();
  }
  /** 处理索引完成边沿日志，并追加耗时字段 */
  if (lastIndexingState && !isIndexing) {
    /** 盘符汇总字符串 */ const driveSummary = drives.map((d) => `${d.drive}=${d.count}`).join(', ');
    /** 本次完成态去重签名 */ const completionSignature = `${totalCount}|${driveSummary}`;
    /** 当前时间戳 */ const now = Date.now();
    /** 完成日志去重判断 */ const deduped =
      completionSignature === lastIndexCompleteSignature &&
      now - lastIndexCompleteAt < INDEX_COMPLETE_DEDUP_WINDOW_MS;
    if (!deduped) {
      /** 完成阶段标签 */ const phase =
        startupIndexBootstrapInFlight || !startupIndexBootstrapFinished
          ? 'startup-bootstrap'
          : 'runtime';
      /** 本轮索引耗时 */ const elapsedMs =
        lastIndexingStartedAt > 0 ? Math.max(0, now - lastIndexingStartedAt) : 0;
      console.log(
        `[index] complete phase=${phase} total=${totalCount} drives=${driveSummary} elapsedMs=${elapsedMs}`,
      );
      lastIndexCompleteSignature = completionSignature;
      lastIndexCompleteAt = now;
    }
    lastIndexingStartedAt = 0;
  }
  lastIndexingState = isIndexing;
  return { isIndexing, progress, totalCount, drives };
}
/** 向所有窗口广播手动刷新完成事件 */
function broadcastManualRefresh(summary: ManualRefreshSummary) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC_EVENT_INDEX_MANUAL_REFRESH_DONE, summary);
    } catch {}
  }
}
/** 执行一次手动刷新：更新 watcher、落盘索引状态并按需补偿扫描 */
async function handleManualRefreshFromTray() {
  /** 手动刷新开始时间 */ const startedAt = Date.now();
  /** 刷新过程错误集合 */ const errors: string[] = [];
  /** 当前 watcher 队列积压量 */ let backlogSize = 0;
  /** 是否触发补偿扫描 */ let reconcileTriggered = false;
  /** 立即刷新盘符与 watcher 绑定关系 */
  await startUserDirectoryWatchers().catch((err) => {
    /** watcher 刷新错误信息 */ const msg = err instanceof Error ? err.message : 'watcher-refresh-failed';
    errors.push(msg);
  });
  /** backlog 偏高时执行一次轻量补偿扫描，避免短时风暴后索引长期滞后 */
  try {
    backlogSize = getWatcherBacklogSize();
    if (backlogSize >= WATCH_BACKLOG_RECONCILE_THRESHOLD) {
      reconcileTriggered = true;
      await reconcileRecentIndex(INDEX_MANUAL_RECONCILE_BUDGET_MS);
    }
  } catch (err) {
    /** 补偿扫描错误信息 */ const msg = err instanceof Error ? err.message : 'reconcile-failed';
    errors.push(msg);
  }
  /** 刷新后的索引状态快照 */ let snapshot: IndexStatsSnapshot = { isIndexing: false, progress: 1, totalCount: 0, drives: [] };
  try {
    snapshot = await collectAndPersistIndexStats(true);
  } catch (err) {
    /** 索引状态刷新错误信息 */ const msg = err instanceof Error ? err.message : 'index-stats-refresh-failed';
    errors.push(msg);
  }
  /** 本次手动刷新结果摘要 */ const summary: ManualRefreshSummary = {
    ...snapshot,
    updatedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    backlogSize,
    reconcileTriggered,
    errors,
  };
  broadcastManualRefresh(summary);
  console.log(
    `[index] manual-refresh durationMs=${summary.durationMs} backlog=${summary.backlogSize} reconcile=${summary.reconcileTriggered} errors=${summary.errors.length}`,
  );
}
/** 执行一轮索引状态刷新，并按状态自适应调度下一轮 */
async function runIndexStatsTick(runId: number) {
  if (!indexStatsWriterActive || runId !== indexStatsWriterRunId) return;
  if (indexStatsInFlight) {
    scheduleNextIndexStatsTick(runId, lastIndexStatsDelayMs);
    return;
  }
  indexStatsInFlight = true;
  /** 本轮是否发生错误 */ let hasError = false;
  /** 本轮是否仍处于索引中 */ let isIndexing = false;
  try {
    /** 本轮拉取到的状态快照 */ const snapshot = await collectAndPersistIndexStats(false);
    isIndexing = snapshot.isIndexing;
  } catch {
    hasError = true;
  } finally {
    indexStatsInFlight = false;
  }
  /** 目标轮询间隔 */ const targetDelayMs = resolveIndexStatsTargetDelayMs(isIndexing, hasError);
  /** 防抖后的稳定轮询间隔 */ const stableDelayMs = resolveStableIndexStatsDelayMs(targetDelayMs);
  scheduleNextIndexStatsTick(runId, stableDelayMs);
}
/** 启动索引状态写盘器（动态轮询 + 防重复调度） */
function startIndexStatsWriter() {
  stopIndexStatsWriter();
  indexStatsWriterActive = true;
  indexStatsWriterRunId += 1;
  lastIndexStatsDelayMs = INDEX_STATS_REFRESH_INDEXING_INTERVAL_MS;
  lastIndexStatsDelaySwitchedAt = Date.now();
  void runIndexStatsTick(indexStatsWriterRunId);
}
/** 停止索引状态写盘器并清理定时任务 */
function stopIndexStatsWriter() {
  indexStatsWriterActive = false;
  indexStatsWriterRunId += 1;
  timeoutRegistry.cancel(INDEX_STATS_TIMER_KEY);
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
/** 注册主进程 IPC 处理器 */
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
    /** 启动即恢复图标缓存，优先提升首轮搜索命中速度 */
    const metaBeforeStartup = loadFileIndexMeta();
    const needLayoutMigration =
      !metaBeforeStartup ||
      metaBeforeStartup.version !== FILE_INDEX_VERSION ||
      metaBeforeStartup.layoutVersion !== FILE_INDEX_LAYOUT_VERSION;
    if (needLayoutMigration) {
      await clearFileIndexCacheOnDisk().catch(() => {});
      await clearPersistedIconStore().catch(() => {});
    }
    restoreIconManifest();
    const initialSettings = loadSettings();
    /** 预创建并隐藏搜索窗口，减少首次唤起白屏 */
    createWindow();
    /** 先读取应用缓存并异步刷新系统应用列表 */
    loadInstalledApps();
    /** 尽早建立开始菜单快捷方式索引 */
    setTimeout(() => void ensureStartMenuShortcutIndex(), 0);
    /** 核心预热任务：设置、历史快照、索引缓存与首轮图标预热 */
    const bootstrapWarmupPromise = primeBootstrapState(initialSettings).catch(() => undefined);
    /** 索引缓存加载任务：用于后续统一判定是否重建 */
    const indexCacheLoadPromise = fileIndex
      .setIgnoredPaths(initialSettings.ignoredPaths, initialSettings.preferredFileExtensions)
      .then(() => fileIndex.loadCache())
      .catch(() => createFallbackCacheLoadReport(getWorkerCount()));
    const runStartupIndexBootstrapOnce = () => {
      /** 启动索引流程使用 single-flight，避免重复触发全量初始化 */
      if (startupIndexBootstrapPromise) return startupIndexBootstrapPromise;
      startupIndexBootstrapPromise = (async () => {
        startupIndexBootstrapInFlight = true;
        try {
          /** 复用启动阶段缓存加载任务，固定顺序为 loadCache -> 判定 -> rebuild/buildIfEmpty */
          const cacheReport = await indexCacheLoadPromise;
          const cacheLoaded = cacheReport.loadedActiveShardCount > 0;
          const meta = loadFileIndexMeta();
          const shouldRebuild =
            !meta ||
            meta.version !== FILE_INDEX_VERSION ||
            meta.layoutVersion !== FILE_INDEX_LAYOUT_VERSION;
          const metaWorkerCount =
            typeof meta?.workerCount === 'number' && Number.isFinite(meta.workerCount)
              ? Math.max(1, Math.floor(meta.workerCount))
              : null;
          const workerCountMismatched =
            metaWorkerCount === null || metaWorkerCount !== cacheReport.workerCount;
          const missingShardCount = cacheReport.missingActiveShardIndices.length;
          const shouldRepairMissingShards =
            !shouldRebuild && cacheReport.isPartial && !workerCountMismatched && missingShardCount > 0;
          const shouldRepairByFullRebuild =
            !shouldRebuild && cacheReport.hasAnyCache && workerCountMismatched;
          const shouldBuildIfEmpty = !shouldRebuild && !cacheReport.hasAnyCache;
          const persistMeta = () =>
            saveFileIndexMeta({
              version: FILE_INDEX_VERSION,
              layoutVersion: FILE_INDEX_LAYOUT_VERSION,
              workerCount: cacheReport.workerCount,
            });
          const repairPlan = shouldRebuild
            ? 'startup-rebuild'
            : shouldBuildIfEmpty
              ? 'build-if-empty'
              : shouldRepairByFullRebuild
                ? 'repair-full-rebuild'
                : shouldRepairMissingShards
                  ? 'repair-missing-shards'
                  : 'none';
          setBootstrapIndexStatus({
            hasCache: cacheLoaded,
            isIndexing:
              shouldRebuild || shouldBuildIfEmpty || shouldRepairByFullRebuild || shouldRepairMissingShards,
          });
          console.log(
            `[index] startup-cache cacheHealth=${cacheReport.loadedActiveShardCount}/${cacheReport.activeShardCount} ` +
              `workerCount=${cacheReport.workerCount} metaWorkerCount=${metaWorkerCount ?? 'unknown'} ` +
              `missingActive=${missingShardCount} repairPlan=${repairPlan}`,
          );
          if (shouldRebuild) {
            persistMeta();
            await fileIndex.rebuild();
            return;
          }
          if (shouldBuildIfEmpty) {
            await fileIndex.buildIfEmpty();
            persistMeta();
            return;
          }
          if (shouldRepairByFullRebuild) {
            await fileIndex.rebuild();
            persistMeta();
            return;
          }
          if (shouldRepairMissingShards) {
            await fileIndex.rebuildShards(cacheReport.missingActiveShardIndices);
            persistMeta();
            return;
          }
          if (metaWorkerCount === null && meta) {
            saveFileIndexMeta({
              version: meta.version,
              layoutVersion: meta.layoutVersion,
              workerCount: cacheReport.workerCount,
            });
          }
        } catch {}
        finally {
          startupIndexBootstrapInFlight = false;
          startupIndexBootstrapFinished = true;
        }
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
    /** 托盘与快捷键在核心预热完成后注册，3 秒超时兜底 */
    await Promise.race([coreWarmupPromise, sleep(TRAY_WARMUP_TIMEOUT_MS)]);
    ensureTray({
      getIconPath: getDefaultTrayIconPath,
      toggleSearchWindow,
      showSettingsWindow,
      onAddQuickItemPath: handleQuickItemPicked,
      onManualRefresh: () => handleManualRefreshFromTray(),
    });
    registerShortcutsForSettings({
      searchShortcut: initialSettings.searchShortcut,
      settingsShortcut: initialSettings.settingsShortcut,
    });
    /** 保留后续两轮图标补热，覆盖启动后动态刷新到的新应用 */
    setTimeout(() => {
      const apps = getInstalledAppsCache();
      void prewarmInstalledAppIcons(apps, { maxCount: 320, concurrency: 3 }).catch(() => undefined);
    }, 2000);
    setTimeout(() => {
      const apps = getInstalledAppsCache();
      void prewarmInstalledAppIcons(apps, { maxCount: 480, concurrency: 2 }).catch(() => undefined);
    }, 12000);
    void ensureWindowsAppContextMenu();
    try {
      handleAddToQuickListArgv(process.argv);
    } catch {}
    void startUserDirectoryWatchers().catch(() => undefined);
    startResourceGuard();
    startIndexStatsWriter();
    app.setLoginItemSettings({ openAtLogin: initialSettings.autoStart, openAsHidden: true, path: app.getPath('exe') });
    /** 面板显示等流程不再重复触发全量索引初始化 */
    void runStartupIndexBootstrapOnce();
  });
}
app.on('will-quit', () => {
  stopResourceGuard();
  stopIndexStatsWriter();
  const lingeringTimeoutCount = timeoutRegistry.getActiveCount();
  if (lingeringTimeoutCount > 0) {
    console.log(`[timer] pending-timeouts-before-exit=${lingeringTimeoutCount}`);
  }
  timeoutRegistry.cancelAll();
  globalShortcut.unregisterAll();
  closeAllWatchers();
});
