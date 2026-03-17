import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getSettingsPath, getSettingsWindowConfigPath, getWindowConfigPath } from '../constants/storagePaths';
import type { AppSettings, ResultActionButtonId } from '../../shared/settingsTypes';
export type { AppSettings, ResultActionButtonId } from '../../shared/settingsTypes';
import {
  BASE_SEARCH_TYPE_IDS,
  DEFAULT_RESULT_ACTION_BUTTONS,
  DEFAULT_SEARCH_SHORTCUT,
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_SHORTCUT,
} from '../constants/initialValues';

// 确保在开发环境下修正 userData 路径
if (!app.isPackaged) {
  const baseUserData = app.getPath('userData');
  // 避免重复追加
  if (!baseUserData.endsWith('dev')) {
    app.setPath('userData', path.join(baseUserData, 'dev'));
  }
}

// 落盘文件路径已抽离：便于你统一维护“配置/缓存/索引/历史”等文件的落盘位置
export const CONFIG_PATH = getWindowConfigPath();
export const SETTINGS_PATH = getSettingsPath();
export const SETTINGS_WINDOW_CONFIG_PATH = getSettingsWindowConfigPath();

// 默认值已抽离到单独文件：便于你集中调整主进程侧默认行为
export { DEFAULT_SEARCH_SHORTCUT, DEFAULT_SETTINGS_SHORTCUT, DEFAULT_RESULT_ACTION_BUTTONS };

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
      const theme = raw?.theme === 'light' ? 'light' : 'dark';
      const uiFontFamily =
        typeof raw?.uiFontFamily === 'string' && raw.uiFontFamily.trim()
          ? raw.uiFontFamily.trim().slice(0, 300)
          : DEFAULT_SETTINGS.uiFontFamily;
      const effectType = raw?.effectType === 'warp' ? 'warp' : raw?.effectType === 'waves' ? 'waves' : 'particles';
      const backgroundImagePath =
        typeof raw?.backgroundImagePath === 'string' ? raw.backgroundImagePath.trim() : DEFAULT_SETTINGS.backgroundImagePath;
      const customAvatarPath =
        typeof raw?.customAvatarPath === 'string' ? raw.customAvatarPath.trim() : DEFAULT_SETTINGS.customAvatarPath;
      const backgroundImageOpacityRaw =
        typeof raw?.backgroundImageOpacity === 'number' ? raw.backgroundImageOpacity : DEFAULT_SETTINGS.backgroundImageOpacity;
      const backgroundImageOpacity = Number.isFinite(backgroundImageOpacityRaw)
        ? Math.min(1, Math.max(0, backgroundImageOpacityRaw))
        : DEFAULT_SETTINGS.backgroundImageOpacity;
      const legacyShortcut =
        typeof raw?.shortcut === 'string' && raw.shortcut.trim() ? raw.shortcut.trim() : undefined;
      const customSearchTypes: string[] = Array.isArray(raw?.customSearchTypes)
        ? Array.from(
            new Set<string>(
              raw.customSearchTypes
                .map((x: any) => (typeof x === 'string' ? x.trim() : ''))
                .map((x: string) => x.toLowerCase())
                .filter((x: string) => /^\.[a-z0-9]{1,10}$/i.test(x))
            )
          )
        : [];

      const defaultSearchTypeIdRaw = typeof raw?.defaultSearchTypeId === 'string' ? raw.defaultSearchTypeId.trim() : '';
      const defaultSearchTypeId =
        defaultSearchTypeIdRaw === 'all' ||
        defaultSearchTypeIdRaw === 'app' ||
        defaultSearchTypeIdRaw === 'file' ||
        defaultSearchTypeIdRaw === 'folder' ||
        defaultSearchTypeIdRaw === 'image' ||
        defaultSearchTypeIdRaw === 'video' ||
        defaultSearchTypeIdRaw === 'settings' ||
        (defaultSearchTypeIdRaw.startsWith('ext:') &&
          /^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
          customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
          ? defaultSearchTypeIdRaw
          : DEFAULT_SETTINGS.defaultSearchTypeId;

      const baseTypeIds = [...BASE_SEARCH_TYPE_IDS];
      const customTypeIds = customSearchTypes.map((ext) => `ext:${ext}`);
      const allowedTypeIds = new Set<string>([...baseTypeIds, ...customTypeIds]);
      const rawOrder: string[] = Array.isArray(raw?.searchTypeOrder)
        ? raw.searchTypeOrder
            .map((x: any) => (typeof x === 'string' ? x.trim() : ''))
            .filter((x: string) => x)
        : [];
      const searchTypeOrder: string[] = [];
      for (const id of rawOrder) {
        if (!allowedTypeIds.has(id)) continue;
        if (searchTypeOrder.includes(id)) continue;
        searchTypeOrder.push(id);
      }
      for (const id of [...baseTypeIds, ...customTypeIds]) {
        if (!searchTypeOrder.includes(id)) searchTypeOrder.push(id);
      }

      const rawDisabledTypeIds: string[] = Array.isArray(raw?.disabledSearchTypeIds)
        ? raw.disabledSearchTypeIds.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
        : [];
      const disabledSearchTypeIds: string[] = [];
      const disabledSeen = new Set<string>();
      for (const id of rawDisabledTypeIds) {
        if (!allowedTypeIds.has(id)) continue;
        if (id === 'all') continue;
        if (disabledSeen.has(id)) continue;
        disabledSeen.add(id);
        disabledSearchTypeIds.push(id);
      }
      const safeDefaultSearchTypeId = disabledSearchTypeIds.includes(defaultSearchTypeId) ? 'all' : defaultSearchTypeId;

      // 结果右侧按钮配置：过滤非法值、去重并限制最多三项
      const allowedActionIds = new Set<ResultActionButtonId>(['openFolder', 'copyPath', 'deleteHistory', 'runAsAdmin']);
      const rawActionButtons: string[] = Array.isArray(raw?.resultActionButtons)
        ? raw.resultActionButtons.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
        : [];
      const resultActionButtons: ResultActionButtonId[] = [];
      for (const id of rawActionButtons) {
        if (!allowedActionIds.has(id as ResultActionButtonId)) continue;
        if (resultActionButtons.includes(id as ResultActionButtonId)) continue;
        resultActionButtons.push(id as ResultActionButtonId);
        if (resultActionButtons.length >= 3) break;
      }
      if (resultActionButtons.length === 0) resultActionButtons.push(...DEFAULT_RESULT_ACTION_BUTTONS);

      const ignoredPathsRaw: string[] = Array.isArray(raw?.ignoredPaths)
        ? raw.ignoredPaths.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
        : [];
      const ignoredPaths: string[] = [];
      const ignoredSeen = new Set<string>();
      for (const p of ignoredPathsRaw) {
        const norm = p.replace(/\//g, '\\').replace(/\\+/g, '\\').trim().replace(/[\\]+$/g, '').toLowerCase();
        if (!norm) continue;
        if (ignoredSeen.has(norm)) continue;
        ignoredSeen.add(norm);
        ignoredPaths.push(p);
      }

      const clampInt = (v: any, fallback: number, min: number, max: number) => {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, Math.round(n)));
      };

      const searchWindowInitialWidth = clampInt(
        raw?.searchWindowInitialWidth,
        DEFAULT_SETTINGS.searchWindowInitialWidth,
        450,
        1000
      );
      const rawMaxHeight = raw?.searchWindowMaxHeight ?? raw?.searchWindowInitialHeight;
      const searchWindowMaxHeight = clampInt(rawMaxHeight, DEFAULT_SETTINGS.searchWindowMaxHeight, 200, 10000);
      const searchDisplayLimit = clampInt(raw?.searchDisplayLimit, DEFAULT_SETTINGS.searchDisplayLimit, 20, 100);
      const preferredFileExtensions = (() => {
        const rawList = Array.isArray(raw?.preferredFileExtensions) ? raw.preferredFileExtensions : DEFAULT_SETTINGS.preferredFileExtensions;
        const out: string[] = [];
        const seen = new Set<string>();
        for (const it of rawList) {
          const s = typeof it === 'string' ? it.trim().toLowerCase() : '';
          if (!s) continue;
          const v = s.startsWith('.') ? s : `.${s}`;
          if (v.length < 2 || v.length > 12) continue;
          if (seen.has(v)) continue;
          seen.add(v);
          out.push(v);
          if (out.length >= 80) break;
        }
        return out.length > 0 ? out : DEFAULT_SETTINGS.preferredFileExtensions;
      })();

      return {
        autoStart: Boolean(raw?.autoStart),
        searchShortcut: (() => {
          const v =
            typeof raw?.searchShortcut === 'string' && raw.searchShortcut.trim()
              ? raw.searchShortcut.trim()
              : legacyShortcut || DEFAULT_SEARCH_SHORTCUT;
          return v.replace(/CommandOrControl/g, 'Ctrl').trim();
        })(),
        settingsShortcut: (() => {
          const v =
            typeof raw?.settingsShortcut === 'string' && raw.settingsShortcut.trim()
              ? raw.settingsShortcut.trim()
              : DEFAULT_SETTINGS_SHORTCUT;
          return v.replace(/CommandOrControl/g, 'Ctrl').trim();
        })(),
        theme,
        uiFontFamily,
        historyLimit:
          typeof raw?.historyLimit === 'number' && Number.isFinite(raw.historyLimit)
            ? Math.min(50, Math.max(0, Math.floor(raw.historyLimit)))
            : DEFAULT_SETTINGS.historyLimit,
        defaultSearchTypeId: safeDefaultSearchTypeId,
        customSearchTypes,
        searchTypeOrder,
        disabledSearchTypeIds,
        ignoredPaths,
        keepStateOnClose: Boolean(raw?.keepStateOnClose),
        // 结果路径默认显示：当用户未显式配置时，默认开启
        showResultPath: typeof raw?.showResultPath === 'boolean' ? raw.showResultPath : DEFAULT_SETTINGS.showResultPath,
        enableHistory: raw?.enableHistory !== false,
        accentColor: typeof raw?.accentColor === 'string' ? raw.accentColor : DEFAULT_SETTINGS.accentColor,
        enableEffect: Boolean(raw?.enableEffect),
        effectType,
        backgroundImagePath,
        backgroundImageOpacity,
        customAvatarPath,
        resultActionButtons,
        searchWindowInitialWidth,
        searchWindowMaxHeight,
        searchDisplayLimit,
        compactMode: raw?.compactMode === true,
        preferredFileExtensions,
      };
    }
  } catch {}
  // 读盘失败/配置不存在时：回落到主进程侧默认设置（返回新对象避免被外部误改影响全局默认）
  return {
    ...DEFAULT_SETTINGS,
    customSearchTypes: [],
    searchTypeOrder: [...DEFAULT_SETTINGS.searchTypeOrder],
    disabledSearchTypeIds: [],
    ignoredPaths: [],
    resultActionButtons: [...DEFAULT_SETTINGS.resultActionButtons],
    preferredFileExtensions: [...DEFAULT_SETTINGS.preferredFileExtensions],
  };
}

export function saveSettings(settings: AppSettings) {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
  } catch {}
}
