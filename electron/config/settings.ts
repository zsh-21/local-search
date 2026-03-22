import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getSettingsPath, getSettingsWindowConfigPath, getWindowConfigPath } from '../constants/storagePaths';
import type { AppSettings, ResultActionButtonId } from '../../shared/settingsTypes';
export type { AppSettings, ResultActionButtonId } from '../../shared/settingsTypes';
import {
  BASE_SEARCH_TYPE_IDS,
  DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT,
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

// 落盘文件路径已抽离：便于统一维护“配置/缓存/索引/历史”等文件落盘位置
export const CONFIG_PATH = getWindowConfigPath();
export const SETTINGS_PATH = getSettingsPath();
export const SETTINGS_WINDOW_CONFIG_PATH = getSettingsWindowConfigPath();

// 默认值已抽离到单独文件：便于集中调整主进程侧默认行为
export { DEFAULT_SEARCH_SHORTCUT, DEFAULT_SETTINGS_SHORTCUT, DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT, DEFAULT_RESULT_ACTION_BUTTONS };

// 搜索排序配置归一化：保证权重/参数/类型优先级在安全范围内并兼容旧配置
function normalizeSearchRanking(raw: any): AppSettings['searchRanking'] {
  const clamp = (v: any, min: number, max: number, fallback: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const normalizeWeights = (v: any) => {
    const fallback = DEFAULT_SETTINGS.searchRanking.signalWeights;
    const match = clamp(v?.match, 0, 1000, fallback.match);
    const frequency = clamp(v?.frequency, 0, 1000, fallback.frequency);
    const recency = clamp(v?.recency, 0, 1000, fallback.recency);
    const fileMtime = clamp(v?.fileMtime, 0, 1000, fallback.fileMtime);
    const sum = match + frequency + recency + fileMtime;
    if (!Number.isFinite(sum) || sum <= 0) return { ...fallback };
    return {
      match: Number(((match / sum) * 100).toFixed(4)),
      frequency: Number(((frequency / sum) * 100).toFixed(4)),
      recency: Number(((recency / sum) * 100).toFixed(4)),
      fileMtime: Number(((fileMtime / sum) * 100).toFixed(4)),
    };
  };
  const normalizeTypePriority = (v: any) => {
    const fallback = DEFAULT_SETTINGS.searchRanking.typePriority;
    const one = (key: keyof typeof fallback) => Math.round(clamp(v?.[key], 1, 10, fallback[key]));
    return {
      app: one('app'),
      command: one('command'),
      settings: one('settings'),
      file: one('file'),
      folder: one('folder'),
      image: one('image'),
      video: one('video'),
      web: one('web'),
      plugin: one('plugin'),
    };
  };

  const fallback = DEFAULT_SETTINGS.searchRanking;
  return {
    signalWeights: normalizeWeights(raw?.signalWeights),
    frecency: {
      decayFactor: clamp(raw?.frecency?.decayFactor, 0.0001, 1, fallback.frecency.decayFactor),
      frequencyWeight: clamp(raw?.frecency?.frequencyWeight, 0, 10, fallback.frecency.frequencyWeight),
    },
    typePriority: normalizeTypePriority(raw?.typePriority),
  };
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
      // 主题值归一化：仅接受当前保留的 7 套主题；已下线主题统一回落到 dark。
      const legacyThemeMap: Record<string, AppSettings['theme']> = {
        voltage: 'oxide',
        chrome: 'dark',
        terminal: 'dark',
        alloy: 'dark',
        signal: 'dark',
      };
      // 主进程与渲染进程保持同一迁移策略，避免两端出现主题不一致。
      const normalizedThemeCandidate =
        typeof raw?.theme === 'string' ? (legacyThemeMap[raw.theme] ?? raw.theme) : DEFAULT_SETTINGS.theme;
      const allowedThemes: AppSettings['theme'][] = [
        'dark',
        'vector',
        'noir',
        'oxide',
        'mac',
        'blueprint',
        'paper',
      ];
      const theme: AppSettings['theme'] = allowedThemes.includes(normalizedThemeCandidate as AppSettings['theme'])
        ? (normalizedThemeCandidate as AppSettings['theme'])
        : 'dark';
      const uiFontFamily =
        typeof raw?.uiFontFamily === 'string' && raw.uiFontFamily.trim()
          ? raw.uiFontFamily.trim().slice(0, 300)
          : DEFAULT_SETTINGS.uiFontFamily;
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
      const searchRanking = normalizeSearchRanking(raw?.searchRanking);

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
        acceptSelectedResultShortcut: (() => {
          const v =
            typeof raw?.acceptSelectedResultShortcut === 'string' && raw.acceptSelectedResultShortcut.trim()
              ? raw.acceptSelectedResultShortcut.trim()
              : DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT;
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
        // 结果路径默认显示：配置缺失时回落到默认值，避免 Boolean(undefined) 误判
        showResultPath: typeof raw?.showResultPath === 'boolean' ? raw.showResultPath : DEFAULT_SETTINGS.showResultPath,
        enableHistory: raw?.enableHistory !== false,
        backgroundImagePath,
        backgroundImageOpacity,
        customAvatarPath,
        resultActionButtons,
        searchWindowInitialWidth,
        searchWindowMaxHeight,
        searchDisplayLimit,
        searchRanking,
        compactMode: raw?.compactMode === true,
        preferredFileExtensions,
      };
    }
  } catch {}
  // 读盘失败/配置不存在时：回落到主进程侧默认设置（返回新对象避免污染全局默认）
  return {
    ...DEFAULT_SETTINGS,
    customSearchTypes: [],
    searchTypeOrder: [...DEFAULT_SETTINGS.searchTypeOrder],
    disabledSearchTypeIds: [],
    ignoredPaths: [],
    resultActionButtons: [...DEFAULT_SETTINGS.resultActionButtons],
    searchRanking: {
      signalWeights: { ...DEFAULT_SETTINGS.searchRanking.signalWeights },
      frecency: { ...DEFAULT_SETTINGS.searchRanking.frecency },
      typePriority: { ...DEFAULT_SETTINGS.searchRanking.typePriority },
    },
    preferredFileExtensions: [...DEFAULT_SETTINGS.preferredFileExtensions],
  };
}

export function saveSettings(settings: AppSettings) {
  try {
    // 保存时也做一次排序配置归一化，保证磁盘数据可直接用于评分计算
    const normalized: AppSettings = {
      ...settings,
      searchRanking: normalizeSearchRanking((settings as any)?.searchRanking),
    };
    writeFileSync(SETTINGS_PATH, JSON.stringify(normalized));
  } catch {}
}

