import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// 确保在开发环境下修正 userData 路径
if (!app.isPackaged) {
  const baseUserData = app.getPath('userData');
  // 避免重复追加
  if (!baseUserData.endsWith('dev')) {
    app.setPath('userData', path.join(baseUserData, 'dev'));
  }
}

export const CONFIG_PATH = path.join(app.getPath('userData'), 'window-config.json');
export const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
export const SETTINGS_WINDOW_CONFIG_PATH = path.join(app.getPath('userData'), 'settings-window-config.json');

export type ResultActionButtonId = 'openFolder' | 'copyPath' | 'deleteHistory' | 'runAsAdmin';

export interface AppSettings {
  autoStart: boolean;
  searchShortcut: string;
  settingsShortcut: string;
  theme: 'dark' | 'light';
  historyLimit: number;
  defaultSearchTypeId: string;
  customSearchTypes: string[];
  searchTypeOrder: string[];
  disabledSearchTypeIds: string[];
  ignoredPaths: string[];
  keepStateOnClose: boolean;
  showResultPath: boolean;
  enableHistory: boolean;
  accentColor: string;
  enableEffect: boolean;
  effectType: 'particles' | 'warp' | 'waves';
  backgroundImagePath: string;
  backgroundImageOpacity: number;
  // 自定义头像：本地图片路径；渲染侧通过 get-image-data-url 转为可展示的 dataUrl
  customAvatarPath: string;
  resultActionButtons: ResultActionButtonId[];

  // 搜索窗口尺寸：初始宽高（最小/最大限制由系统内部固定）
  searchWindowInitialWidth: number;
  searchWindowMaxHeight: number;

  compactMode: boolean;
}

export const DEFAULT_SEARCH_SHORTCUT = 'Alt+T';
export const DEFAULT_SETTINGS_SHORTCUT = 'Alt+Shift+T';
export const DEFAULT_THEME: AppSettings['theme'] = 'dark';
export const DEFAULT_HISTORY_LIMIT = 5;
export const DEFAULT_SEARCH_TYPE_ID = 'all';
export const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ['openFolder', 'copyPath', 'deleteHistory'];
export const DEFAULT_SEARCH_WINDOW_INITIAL_WIDTH = 720;
export const DEFAULT_SEARCH_WINDOW_MAX_HEIGHT = 760;

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
      const effectType = raw?.effectType === 'warp' ? 'warp' : raw?.effectType === 'waves' ? 'waves' : 'particles';
      const backgroundImagePath = typeof raw?.backgroundImagePath === 'string' ? raw.backgroundImagePath.trim() : '';
      const customAvatarPath = typeof raw?.customAvatarPath === 'string' ? raw.customAvatarPath.trim() : '';
      const backgroundImageOpacityRaw = typeof raw?.backgroundImageOpacity === 'number' ? raw.backgroundImageOpacity : 0.25;
      const backgroundImageOpacity = Number.isFinite(backgroundImageOpacityRaw)
        ? Math.min(1, Math.max(0, backgroundImageOpacityRaw))
        : 0.25;
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
          : DEFAULT_SEARCH_TYPE_ID;

      const baseTypeIds = ['all', 'app', 'file', 'folder', 'image', 'video', 'settings'];
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

      const searchWindowInitialWidth = clampInt(raw?.searchWindowInitialWidth, DEFAULT_SEARCH_WINDOW_INITIAL_WIDTH, 450, 1000);
      const rawMaxHeight = raw?.searchWindowMaxHeight ?? raw?.searchWindowInitialHeight;
      const searchWindowMaxHeight = clampInt(rawMaxHeight, DEFAULT_SEARCH_WINDOW_MAX_HEIGHT, 200, 10000);

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
        historyLimit:
          typeof raw?.historyLimit === 'number' && Number.isFinite(raw.historyLimit)
            ? Math.min(50, Math.max(0, Math.floor(raw.historyLimit)))
            : DEFAULT_HISTORY_LIMIT,
        defaultSearchTypeId: safeDefaultSearchTypeId,
        customSearchTypes,
        searchTypeOrder,
        disabledSearchTypeIds,
        ignoredPaths,
        keepStateOnClose: Boolean(raw?.keepStateOnClose),
        // 结果路径默认显示：当用户未显式配置时，默认开启
        showResultPath: typeof raw?.showResultPath === 'boolean' ? raw.showResultPath : true,
        enableHistory: raw?.enableHistory !== false,
        accentColor: typeof raw?.accentColor === 'string' ? raw.accentColor : '#38bdf8',
        enableEffect: Boolean(raw?.enableEffect),
        effectType,
        backgroundImagePath,
        backgroundImageOpacity,
        customAvatarPath,
        resultActionButtons,
        searchWindowInitialWidth,
        searchWindowMaxHeight,
        compactMode: raw?.compactMode === true,
      };
    }
  } catch {}
  return {
    autoStart: false,
    searchShortcut: DEFAULT_SEARCH_SHORTCUT,
    settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
    theme: DEFAULT_THEME,
    historyLimit: DEFAULT_HISTORY_LIMIT,
    defaultSearchTypeId: DEFAULT_SEARCH_TYPE_ID,
    customSearchTypes: [],
    searchTypeOrder: ['all', 'app', 'file', 'folder', 'image', 'video', 'settings'],
    disabledSearchTypeIds: [],
    ignoredPaths: [],
    keepStateOnClose: false,
    // 默认显示路径：便于区分同名文件
    showResultPath: true,
    enableHistory: true,
    accentColor: '#38bdf8',
    enableEffect: false,
    effectType: 'particles',
    backgroundImagePath: '',
    backgroundImageOpacity: 0.25,
    customAvatarPath: '',
    resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
    searchWindowInitialWidth: DEFAULT_SEARCH_WINDOW_INITIAL_WIDTH,
    searchWindowMaxHeight: DEFAULT_SEARCH_WINDOW_MAX_HEIGHT,
    compactMode: false,
  };
}

export function saveSettings(settings: AppSettings) {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
  } catch {}
}
