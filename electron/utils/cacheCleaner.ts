import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileIndex, FILE_INDEX_PATH, FILE_INDEX_META_PATH } from '../file/indexService';
import { recentIndex } from '../file/watcher';
import { clearIconCaches } from '../icon/iconService';
import { getSearchWindow, getSettingsWindow } from '../window/windowManager';

const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
const HISTORY_STATS_PATH = path.join(app.getPath('userData'), 'history-stats.json');
const INSTALLED_APPS_CACHE_PATH = path.join(app.getPath('userData'), 'installed-apps.json');

export async function clearLocalCacheButKeepAccountAndSettings() {
  // 清理“缓存与索引”，但保留：登录账户（渲染进程 localStorage）与设置/窗口布局（settings.json/window-config.json）
  // 目标：用户执行 clear:cache 后，下次呼出面板会自动重建索引，并且不会丢失登录态与配置
  try {
    recentIndex.clear();
    await clearIconCaches();
    // 索引复位放到 Worker 线程执行：避免主线程残留状态影响后续重建
    await fileIndex.reset();

    await fs.rm(FILE_INDEX_PATH, { force: true }).catch(() => {});
    await fs.rm(`${FILE_INDEX_PATH}.tmp`, { force: true }).catch(() => {});
    await fs.rm(FILE_INDEX_META_PATH, { force: true }).catch(() => {});
    await fs.rm(HISTORY_PATH, { force: true }).catch(() => {});
    await fs.rm(HISTORY_STATS_PATH, { force: true }).catch(() => {});
    await fs.rm(INSTALLED_APPS_CACHE_PATH, { force: true }).catch(() => {});

    try {
      getSearchWindow()?.webContents.send('reset-search');
      getSettingsWindow()?.webContents.send('reset-search');
    } catch {}
  } catch {}
}
