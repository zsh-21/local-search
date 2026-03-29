import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AppItem, AppSettings, DEFAULT_SETTINGS, ResultActionButtonId, SearchTypeOption } from "./appTypes";
import { BASE_SEARCH_TYPE_IDS, FS_BACKUP_SETTINGS_KEY } from "./constants/initialValues";
import { useStoredMembership } from "./membership";
import {
  IPC_EVENT_SETTINGS_UPDATED,
  IPC_GET_APP_BOOTSTRAP_STATE,
  IPC_SAVE_SETTINGS,
} from "../shared/ipc/channels";
import { normalizeSettingsCore } from "../shared/utils/settingsNormalizeCore";

// 设置存储与衍生：规范化、会员降级、类型列表生成、主题应用、与主进程同步
export function normalizeSettings(s: unknown): AppSettings {
  return normalizeSettingsCore(s, { includeDarkWinTheme: true });
}

// 备份配置的存储 Key 已抽离：便于统一调整 localStorage 的命名与迁移策略
const BACKUP_SETTINGS_KEY = FS_BACKUP_SETTINGS_KEY;

export type AppBootstrapState = {
  settings: AppSettings;
  history: AppItem[];
};

let bootstrapStateCache: AppBootstrapState = {
  settings: DEFAULT_SETTINGS,
  history: [],
};
let bootstrapStatePromise: Promise<AppBootstrapState> | null = null;
let bootstrapStateLoaded = false;

// renderer 启动阶段统一复用这份快照 Promise，避免搜索页/设置页各自重复拉取初始化数据。
export function loadBootstrapState(): Promise<AppBootstrapState> {
  if (bootstrapStateLoaded) return Promise.resolve(bootstrapStateCache);
  if (bootstrapStatePromise) return bootstrapStatePromise;
  bootstrapStatePromise = window.ipcRenderer
    ?.invoke(IPC_GET_APP_BOOTSTRAP_STATE)
    .then((raw: unknown) => {
      const state = (raw && typeof raw === "object" ? raw : {}) as {
        settings?: unknown;
        history?: unknown;
      };
      const next: AppBootstrapState = {
        settings: normalizeSettings(state.settings),
        history: Array.isArray(state.history) ? state.history : [],
      };
      bootstrapStateCache = next;
      bootstrapStateLoaded = true;
      return next;
    })
    .catch(() => {
      bootstrapStateLoaded = true;
      return bootstrapStateCache;
    }) ?? Promise.resolve(bootstrapStateCache);
  return bootstrapStatePromise;
}

export function getBootstrapHistoryCache() {
  return bootstrapStateCache.history;
}

export function setBootstrapHistoryCache(history: AppItem[]) {
  bootstrapStateCache = {
    ...bootstrapStateCache,
    history: Array.isArray(history) ? history : [],
  };
}

function getBackupSettings(): Partial<AppSettings> | null {
  try {
    const raw = localStorage.getItem(BACKUP_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveBackupSettings(settings: Partial<AppSettings>) {
  try {
    localStorage.setItem(BACKUP_SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

function clearBackupSettings() {
  localStorage.removeItem(BACKUP_SETTINGS_KEY);
}

// 会员限制：非会员时强制回退高级配置，避免 UI 展示与权限不一致
export function applyMembershipRestrictionsToSettings(settings: AppSettings, isMember: boolean): AppSettings {
  if (isMember) return settings;

  return normalizeSettings({
    ...settings,
    defaultSearchTypeId: DEFAULT_SETTINGS.defaultSearchTypeId,
    customSearchTypes: [],
    searchTypeOrder: DEFAULT_SETTINGS.searchTypeOrder,
    // 非会员不允许自定义背景图：统一回落到默认背景。
    backgroundImagePath: DEFAULT_SETTINGS.backgroundImagePath,
    backgroundImageOpacity: DEFAULT_SETTINGS.backgroundImageOpacity,
    resultActionButtons: DEFAULT_SETTINGS.resultActionButtons,
  });
}

export function getSearchTypeOptions(customTypes: string[], order: string[] | undefined): SearchTypeOption[] {
  const base: SearchTypeOption[] = [
    { id: "all", label: "所有类型" },
    // “应用”类型：仅展示已安装应用（不混入文件/文件夹），用于快速找程序
    { id: "app", label: "应用" },
    { id: "file", label: "文档" },
    { id: "folder", label: "文件夹" },
    { id: "image", label: "图片" },
    { id: "video", label: "视频" },
    { id: "settings", label: "设置" },
  ];
  const custom: SearchTypeOption[] = (customTypes || []).map((ext) => ({
    id: `ext:${ext}`,
    label: `${ext.replace(".", "").toUpperCase()} 文件`,
  }));
  const all = [...base, ...custom];
  const byId = new Map(all.map((x) => [x.id, x]));
  const allowedIds = new Set(all.map((x) => x.id));
  const seen = new Set<string>();
  const out: SearchTypeOption[] = [];

  const raw = Array.isArray(order) ? order : [];
  for (const id of raw) {
    if (!allowedIds.has(id)) continue;
    if (seen.has(id)) continue;
    const opt = byId.get(id);
    if (!opt) continue;
    seen.add(id);
    out.push(opt);
  }
  for (const opt of all) {
    if (seen.has(opt.id)) continue;
    seen.add(opt.id);
    out.push(opt);
  }
  return out;
}

function normalizeKey(key: string) {
  if (!key) return "";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  return key;
}

export function toAccelerator(e: React.KeyboardEvent) {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  const mainKey = normalizeKey(e.key);
  if (!mainKey) return "";
  if (["Control", "Alt", "Shift", "Meta"].includes(mainKey)) return "";

  parts.push(mainKey);
  return parts.join("+");
}

export function useSettings() {
  const [baseSettings, setBaseSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const isMember = useStoredMembership();

  useLayoutEffect(() => {
    if (isMember) {
      const backup = getBackupSettings();
      if (backup) {
        setBaseSettings((prev) => {
          const next = {
            ...prev,
            defaultSearchTypeId: backup.defaultSearchTypeId ?? prev.defaultSearchTypeId,
            customSearchTypes: backup.customSearchTypes ?? prev.customSearchTypes,
            searchTypeOrder: backup.searchTypeOrder ?? prev.searchTypeOrder,
            backgroundImagePath: backup.backgroundImagePath ?? prev.backgroundImagePath,
            backgroundImageOpacity: backup.backgroundImageOpacity ?? prev.backgroundImageOpacity,
            resultActionButtons: backup.resultActionButtons ?? prev.resultActionButtons,
          };
          window.ipcRenderer?.invoke(IPC_SAVE_SETTINGS, next);
          return next;
        });
        clearBackupSettings();
      }
    } else {
      setBaseSettings((prev) => {
        const arrEq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
        const hasCustomSettings =
          prev.defaultSearchTypeId !== DEFAULT_SETTINGS.defaultSearchTypeId ||
          (prev.customSearchTypes && prev.customSearchTypes.length > 0) ||
          prev.backgroundImagePath !== DEFAULT_SETTINGS.backgroundImagePath ||
          prev.backgroundImageOpacity !== DEFAULT_SETTINGS.backgroundImageOpacity ||
          !arrEq(prev.resultActionButtons || [], DEFAULT_SETTINGS.resultActionButtons || []);

        if (hasCustomSettings) {
          saveBackupSettings({
            defaultSearchTypeId: prev.defaultSearchTypeId,
            customSearchTypes: prev.customSearchTypes,
            searchTypeOrder: prev.searchTypeOrder,
            backgroundImagePath: prev.backgroundImagePath,
            backgroundImageOpacity: prev.backgroundImageOpacity,
            resultActionButtons: prev.resultActionButtons,
          });

          const reset = {
            ...prev,
            defaultSearchTypeId: DEFAULT_SETTINGS.defaultSearchTypeId,
            customSearchTypes: [],
            searchTypeOrder: DEFAULT_SETTINGS.searchTypeOrder,
            backgroundImagePath: DEFAULT_SETTINGS.backgroundImagePath,
            backgroundImageOpacity: DEFAULT_SETTINGS.backgroundImageOpacity,
            resultActionButtons: DEFAULT_SETTINGS.resultActionButtons,
          };
          window.ipcRenderer?.invoke(IPC_SAVE_SETTINGS, reset);
          return reset;
        }
        return prev;
      });
    }
  }, [isMember]);

  const settings = useMemo(
    () => applyMembershipRestrictionsToSettings(baseSettings, isMember),
    [baseSettings, isMember],
  );

  useEffect(() => {
    let mounted = true;
    loadBootstrapState()
      .then((snapshot) => {
        if (!mounted) return;
        setBaseSettings(snapshot.settings);
        setLoaded(true);
      })
      .catch(() => {
        if (!mounted) return;
        setLoaded(true);
      });

    const handler = (_event: unknown, next: AppSettings) => {
      const normalized = normalizeSettings(next);
      bootstrapStateCache = {
        ...bootstrapStateCache,
        settings: normalized,
      };
      setBaseSettings(normalized);
      setLoaded(true);
    };
    window.ipcRenderer?.on<[AppSettings]>(IPC_EVENT_SETTINGS_UPDATED, handler);

    return () => {
      mounted = false;
      window.ipcRenderer?.off<[AppSettings]>(IPC_EVENT_SETTINGS_UPDATED, handler);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--fs-font-sans", settings.uiFontFamily || DEFAULT_SETTINGS.uiFontFamily);
  }, [settings]);

  return { settings, loaded };
}


