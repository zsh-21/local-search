import fs from 'node:fs/promises';
import { fileIndex, FILE_INDEX_PATH, FILE_INDEX_META_PATH } from '../file/indexService';
import { recentIndex } from '../file/watcher';
import { clearIconCaches } from '../icon/iconService';
import { getSearchWindow, getSettingsWindow } from '../window/windowManager';
import { FILE_INDEX_WORKER_MAX } from '../constants/initialValues';
import {
  getFileIndexShardPath,
  getFileIndexShardTmpPath,
  getFileIndexTmpPath,
  getHistoryPath,
  getHistoryStatsPath,
  getInstalledAppsCachePath,
} from '../constants/storagePaths';

// 清理目标路径已抽离：便于你统一管理“缓存/索引/历史”等落盘文件位置
const HISTORY_PATH = getHistoryPath();
const HISTORY_STATS_PATH = getHistoryStatsPath();
const INSTALLED_APPS_CACHE_PATH = getInstalledAppsCachePath();

export async function clearLocalCacheButKeepAccountAndSettings() {
  // 清理“缓存与索引”，但保留：登录账户（渲染进程 localStorage）与设置/窗口布局（settings.json/window-config.json）
  // 目标：用户执行 clear:cache 后，下次呼出面板会自动重建索引，并且不会丢失登录态与配置
  try {
    recentIndex.clear();
    await clearIconCaches();
    // 索引复位放到 Worker 线程执行：避免主线程残留状态影响后续重建
    await fileIndex.reset();

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

    try {
      getSearchWindow()?.webContents.send('reset-search');
      getSettingsWindow()?.webContents.send('reset-search');
    } catch {}
  } catch {}
}
