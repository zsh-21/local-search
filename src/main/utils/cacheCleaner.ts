import fs from 'node:fs/promises';
import path from 'node:path';
import { fileIndex, FILE_INDEX_PATH, FILE_INDEX_META_PATH } from '../file/indexService';
import { recentIndex } from '../file/watcher';
import { clearIconCaches } from '../icon/iconService';
import { getSearchWindow, getSettingsWindow } from '../window/windowManager';
import {
  getAppIconCachePath,
  getDeviceIdPath,
  getFileIndexTmpPath,
  getHistoryPath,
  getHistoryStatsPath,
  getInstalledAppsCachePath,
  getSettingsPath,
  getSettingsWindowConfigPath,
  getUserDataRoot,
  getWindowConfigPath,
} from '../constants/storagePaths';
import { IPC_EVENT_RESET_SEARCH } from '../../shared/ipc/channels';

const HISTORY_PATH = getHistoryPath();
const HISTORY_STATS_PATH = getHistoryStatsPath();
const INSTALLED_APPS_CACHE_PATH = getInstalledAppsCachePath();
const APP_ICON_CACHE_PATH = getAppIconCachePath();

export async function clearLocalCacheAll() {
  try {
    recentIndex.clear();
    await clearIconCaches();
    await fileIndex.reset();

    await fs.rm(getWindowConfigPath(), { force: true }).catch(() => {});
    await fs.rm(getSettingsWindowConfigPath(), { force: true }).catch(() => {});
    await fs.rm(getSettingsPath(), { force: true }).catch(() => {});
    await fs.rm(getDeviceIdPath(), { force: true }).catch(() => {});

    await fs.rm(FILE_INDEX_PATH, { force: true }).catch(() => {});
    await fs.rm(getFileIndexTmpPath(), { force: true }).catch(() => {});
    await fs.rm(FILE_INDEX_META_PATH, { force: true }).catch(() => {});

    // 分片索引按文件名模式清理，不依赖固定最大分片数
    const userDataRoot = getUserDataRoot();
    const entries = await fs.readdir(userDataRoot).catch(() => [] as string[]);
    const shardFileRe = /^file-index-\d+\.txt(\.(tmp|snapshot|snapshot\.tmp|delta))?$/i;
    for (const name of entries) {
      if (!shardFileRe.test(name)) continue;
      await fs.rm(path.join(userDataRoot, name), { force: true }).catch(() => {});
    }

    await fs.rm(HISTORY_PATH, { force: true }).catch(() => {});
    await fs.rm(HISTORY_STATS_PATH, { force: true }).catch(() => {});
    await fs.rm(INSTALLED_APPS_CACHE_PATH, { force: true }).catch(() => {});
    await fs.rm(APP_ICON_CACHE_PATH, { force: true }).catch(() => {});

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
      getSearchWindow()?.webContents.send(IPC_EVENT_RESET_SEARCH);
      getSettingsWindow()?.webContents.send(IPC_EVENT_RESET_SEARCH);
    } catch {}
  } catch {}
}
