import fs from 'node:fs/promises';
import path from 'node:path';
import { fileIndex, FILE_INDEX_PATH, FILE_INDEX_META_PATH } from '../file/indexService';
import { recentIndex } from '../file/watcher';
import { clearIconCaches } from '../icon/iconService';
import { getSearchWindow, getSettingsWindow } from '../window/windowManager';
import { FILE_INDEX_WORKER_MAX } from '../constants/initialValues';
import {
  getDeviceIdPath,
  getFileIndexShardPath,
  getFileIndexShardTmpPath,
  getFileIndexTmpPath,
  getHistoryPath,
  getHistoryStatsPath,
  getInstalledAppsCachePath,
  getSettingsPath,
  getSettingsWindowConfigPath,
  getUserDataRoot,
  getWindowConfigPath,
} from '../constants/storagePaths';

// 清理目标路径已抽离：便于你统一管理“缓存/索引/历史”等落盘文件位置
const HISTORY_PATH = getHistoryPath();
const HISTORY_STATS_PATH = getHistoryStatsPath();
const INSTALLED_APPS_CACHE_PATH = getInstalledAppsCachePath();

export async function clearLocalCacheAll() {
  // 清理“所有配置 + 所有索引 + 所有缓存”：用于一键恢复到“全新安装”的状态
  // 注意：渲染进程 localStorage 等 Chromium 存储也位于 userData 下，这里尽量做 best-effort 清理（部分文件可能被占用）
  try {
    recentIndex.clear();
    await clearIconCaches();
    // 索引复位放到 Worker 线程执行：避免主线程残留状态影响后续重建
    await fileIndex.reset();

    // 1) 应用自身的配置/缓存/索引文件（userData 根目录下的 JSON/TXT）
    await fs.rm(getWindowConfigPath(), { force: true }).catch(() => {});
    await fs.rm(getSettingsWindowConfigPath(), { force: true }).catch(() => {});
    await fs.rm(getSettingsPath(), { force: true }).catch(() => {});
    await fs.rm(getDeviceIdPath(), { force: true }).catch(() => {});

    await fs.rm(FILE_INDEX_PATH, { force: true }).catch(() => {});
    await fs.rm(getFileIndexTmpPath(), { force: true }).catch(() => {});
    await fs.rm(FILE_INDEX_META_PATH, { force: true }).catch(() => {});
    // 分片索引文件也需要一并清理：否则会残留旧分片索引导致“清缓存后依然命中旧结果”
    for (let i = 0; i < FILE_INDEX_WORKER_MAX; i++) {
      await fs.rm(getFileIndexShardPath(i), { force: true }).catch(() => {});
      await fs.rm(getFileIndexShardTmpPath(i), { force: true }).catch(() => {});
    }
    await fs.rm(HISTORY_PATH, { force: true }).catch(() => {});
    await fs.rm(HISTORY_STATS_PATH, { force: true }).catch(() => {});
    await fs.rm(INSTALLED_APPS_CACHE_PATH, { force: true }).catch(() => {});

    // 2) Chromium 存储（同样位于 userData 下）：用于彻底清空登录态/localStorage/缓存等
    // 说明：这些目录/文件可能被当前进程占用，删除失败时忽略，下一次退出后再执行即可清干净
    const userDataRoot = getUserDataRoot();
    const chromiumEntries = [
      'Local Storage',
      'Session Storage',
      'IndexedDB',
      'WebStorage',
      'Cache',
      'Code Cache',
      'GPUCache',
      'DawnCache',
      'Network',
      'Cookies',
      'Cookies-journal',
      'Preferences',
      'Preferences-journal',
      'QuotaManager',
      'QuotaManager-journal',
    ];
    for (const name of chromiumEntries) {
      await fs.rm(path.join(userDataRoot, name), { recursive: true, force: true }).catch(() => {});
    }

    try {
      getSearchWindow()?.webContents.send('reset-search');
      getSettingsWindow()?.webContents.send('reset-search');
    } catch {}
  } catch {}
}
