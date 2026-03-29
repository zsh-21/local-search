import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getSettingsPath, getSettingsWindowConfigPath, getWindowConfigPath } from '../constants/storagePaths';
import type { AppSettings, ResultActionButtonId } from '../../shared/types/settingsTypes';
export type { AppSettings, ResultActionButtonId } from '../../shared/types/settingsTypes';
import {
  BASE_SEARCH_TYPE_IDS,
  DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT,
  DEFAULT_RESULT_ACTION_BUTTONS,
  DEFAULT_SEARCH_SHORTCUT,
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_SHORTCUT,
} from '../constants/initialValues';
import { normalizeSearchRankingConfig, normalizeSettingsCore } from '../../shared/utils/settingsNormalizeCore';

// 确保在开发环境下修正 userData 路径
if (!app.isPackaged) {
  const baseUserData = app.getPath('userData');
  // 避免重复追加
  if (!baseUserData.endsWith('dev')) {
    app.setPath('userData', path.join(baseUserData, 'dev'));
  }
}

// 落盘文件路径已抽离：便于统一维护“配置/缓存/索引/历史”等文件落盘位置
export const CONFIG_PATH = getWindowConfigPath();
export const SETTINGS_PATH = getSettingsPath();
export const SETTINGS_WINDOW_CONFIG_PATH = getSettingsWindowConfigPath();

// 默认值已抽离到单独文件：便于集中调整主进程侧默认行为
export { DEFAULT_SEARCH_SHORTCUT, DEFAULT_SETTINGS_SHORTCUT, DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT, DEFAULT_RESULT_ACTION_BUTTONS };

// 搜索排序配置归一化：保证权重/参数/类型优先级在安全范围内并兼容旧配置
function normalizeSearchRanking(raw: unknown): AppSettings['searchRanking'] {
  return normalizeSearchRankingConfig(raw);
}

export function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {}
  return null;
}

export function saveConfig(bounds: Electron.Rectangle) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ bounds }));
  } catch {}
}

export function loadSettingsWindowConfig() {
  try {
    if (existsSync(SETTINGS_WINDOW_CONFIG_PATH)) return JSON.parse(readFileSync(SETTINGS_WINDOW_CONFIG_PATH, 'utf-8'));
  } catch {}
  return null;
}

export function saveSettingsWindowConfig(bounds: Electron.Rectangle) {
  try {
    writeFileSync(SETTINGS_WINDOW_CONFIG_PATH, JSON.stringify({ bounds }));
  } catch {}
}

export function loadSettings(): AppSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
      return normalizeSettingsCore(raw, { includeDarkWinTheme: false });
    }
  } catch {}
  return normalizeSettingsCore(DEFAULT_SETTINGS, { includeDarkWinTheme: false });
}

export function saveSettings(settings: AppSettings) {
  try {
    // 保存时也做一次排序配置归一化，保证磁盘数据可直接用于评分计算
    const normalized: AppSettings = {
      ...settings,
      searchRanking: normalizeSearchRanking(settings.searchRanking),
    };
    writeFileSync(SETTINGS_PATH, JSON.stringify(normalized));
  } catch {}
}




