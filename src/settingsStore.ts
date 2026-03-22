import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AppItem, AppSettings, DEFAULT_SETTINGS, ResultActionButtonId, SearchTypeOption } from "./appTypes";
import { BASE_SEARCH_TYPE_IDS, FS_BACKUP_SETTINGS_KEY } from "./constants/initialValues";
import { useStoredMembership } from "./membership";

// 搜索排序配置归一化：保证渲染侧草稿和主进程一致，避免权重失真
function normalizeSearchRanking(raw: any): AppSettings["searchRanking"] {
  const clamp = (v: any, min: number, max: number, fallback: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
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
      app: one("app"),
      command: one("command"),
      settings: one("settings"),
      file: one("file"),
      folder: one("folder"),
      image: one("image"),
      video: one("video"),
      web: one("web"),
      plugin: one("plugin"),
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

// 设置存储与衍生：规范化、会员降级、类型列表生成、主题应用、与主进程同步
export function normalizeSettings(s: any): AppSettings {
  // 主题值归一化：仅接受当前保留的 7 套主题；已下线主题统一回落到 dark，避免出现无效值。
  const legacyThemeMap: Record<string, AppSettings["theme"]> = {
    voltage: "oxide",
    chrome: "dark",
    terminal: "dark",
    alloy: "dark",
    signal: "dark",
  };
  // 先做历史主题映射，再做白名单校验，保证旧配置能平滑升级。
  const normalizedThemeCandidate =
    typeof s?.theme === "string" ? (legacyThemeMap[s.theme] ?? s.theme) : DEFAULT_SETTINGS.theme;
  const allowedThemes: AppSettings["theme"][] = [
    "dark",
    "vector",
    "noir",
    "oxide",
    "mac",
    "blueprint",
    "paper",
  ];
  const theme: AppSettings["theme"] = allowedThemes.includes(normalizedThemeCandidate as AppSettings["theme"])
    ? (normalizedThemeCandidate as AppSettings["theme"])
    : DEFAULT_SETTINGS.theme;
  const uiFontFamily =
    typeof s?.uiFontFamily === "string" && s.uiFontFamily.trim()
      ? s.uiFontFamily.trim().slice(0, 300)
      : DEFAULT_SETTINGS.uiFontFamily;
  const normalizeWinShortcut = (v: string) => v.replace(/CommandOrControl/g, "Ctrl").trim();
  const searchShortcut = normalizeWinShortcut(
    typeof s?.searchShortcut === "string" && s.searchShortcut.trim()
      ? s.searchShortcut.trim()
      : DEFAULT_SETTINGS.searchShortcut,
  );
  const settingsShortcut = normalizeWinShortcut(
    typeof s?.settingsShortcut === "string" && s.settingsShortcut.trim()
      ? s.settingsShortcut.trim()
      : DEFAULT_SETTINGS.settingsShortcut,
  );
  const acceptSelectedResultShortcut = normalizeWinShortcut(
    typeof s?.acceptSelectedResultShortcut === "string" && s.acceptSelectedResultShortcut.trim()
      ? s.acceptSelectedResultShortcut.trim()
      : DEFAULT_SETTINGS.acceptSelectedResultShortcut,
  );

  const customSearchTypes: string[] = Array.isArray(s?.customSearchTypes)
    ? Array.from(
        new Set(
          s.customSearchTypes
            .map((x: any) => (typeof x === "string" ? x.trim() : ""))
            .map((x: string) => x.toLowerCase())
            .filter((x: string) => /^\.[a-z0-9]{1,10}$/i.test(x)),
        ),
      )
    : [];

  const defaultSearchTypeIdRaw =
    typeof s?.defaultSearchTypeId === "string" && s.defaultSearchTypeId.trim()
      ? s.defaultSearchTypeId.trim()
      : "all";
  const defaultSearchTypeId =
    defaultSearchTypeIdRaw === "all" ||
    defaultSearchTypeIdRaw === "app" ||
    defaultSearchTypeIdRaw === "file" ||
    defaultSearchTypeIdRaw === "folder" ||
    defaultSearchTypeIdRaw === "image" ||
    defaultSearchTypeIdRaw === "video" ||
    defaultSearchTypeIdRaw === "settings" ||
    (defaultSearchTypeIdRaw.startsWith("ext:") &&
      /^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
      customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
      ? defaultSearchTypeIdRaw
      : "all";

  // 规范化搜索类型顺序：过滤非法值并补齐内置/自定义类型
  const normalizeSearchTypeOrder = (order: any) => {
    // 基础类型顺序：新增“应用”类型后需要同步进来，保证排序/禁用逻辑一致
    const baseIds = [...BASE_SEARCH_TYPE_IDS];
    const customIds = customSearchTypes.map((ext) => `ext:${ext}`);
    const allowed = new Set<string>([...baseIds, ...customIds]);
    const raw: string[] = Array.isArray(order)
      ? order
          .map((x: any) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean)
      : [];
    const out: string[] = [];
    for (const id of raw) {
      if (!allowed.has(id)) continue;
      if (out.includes(id)) continue;
      out.push(id);
    }
    for (const id of [...baseIds, ...customIds]) {
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };

  const allowedTypeIdsForDisable = (() => {
    const baseIds = [...BASE_SEARCH_TYPE_IDS];
    const customIds = customSearchTypes.map((ext) => `ext:${ext}`);
    return new Set<string>([...baseIds, ...customIds]);
  })();
  const disabledSearchTypeIdsRaw: string[] = Array.isArray(s?.disabledSearchTypeIds)
    ? s.disabledSearchTypeIds
        .map((x: any) => (typeof x === "string" ? x.trim() : ""))
        .filter(Boolean)
    : [];
  const disabledSearchTypeIds: string[] = [];
  const disabledSeen = new Set<string>();
  for (const id of disabledSearchTypeIdsRaw) {
    if (!allowedTypeIdsForDisable.has(id)) continue;
    if (id === "all") continue;
    if (disabledSeen.has(id)) continue;
    disabledSeen.add(id);
    disabledSearchTypeIds.push(id);
  }

  const backgroundImagePath =
    typeof s?.backgroundImagePath === "string" ? s.backgroundImagePath.trim() : DEFAULT_SETTINGS.backgroundImagePath;
  const customAvatarPath =
    typeof s?.customAvatarPath === "string" ? s.customAvatarPath.trim() : DEFAULT_SETTINGS.customAvatarPath;
  const backgroundImageOpacityRaw =
    typeof s?.backgroundImageOpacity === "number" ? s.backgroundImageOpacity : DEFAULT_SETTINGS.backgroundImageOpacity;
  const backgroundImageOpacity = Number.isFinite(backgroundImageOpacityRaw)
    ? Math.min(1, Math.max(0, backgroundImageOpacityRaw))
    : DEFAULT_SETTINGS.backgroundImageOpacity;

  const normalizeIgnoredPath = (v: string) =>
    v.replace(/\//g, "\\").trim().replace(/[\\]+$/g, "");
  const ignoredPathsRaw: string[] = Array.isArray(s?.ignoredPaths)
    ? s.ignoredPaths.map((x: any) => (typeof x === "string" ? x : "")).map((x: string) => x.trim()).filter(Boolean)
    : [];
  const ignoredPaths: string[] = [];
  const ignoredSeen = new Set<string>();
  for (const p of ignoredPathsRaw) {
    const norm = normalizeIgnoredPath(p).toLowerCase();
    if (!norm) continue;
    if (ignoredSeen.has(norm)) continue;
    ignoredSeen.add(norm);
    ignoredPaths.push(p.trim());
  }

  const safeDefaultSearchTypeId = disabledSearchTypeIds.includes(defaultSearchTypeId) ? "all" : defaultSearchTypeId;

  // 规范化结果操作按钮：只接受允许的 id、去重、最多三项，并保持原有顺序
  const allowedActionIds = new Set<ResultActionButtonId>(["openFolder", "copyPath", "deleteHistory", "runAsAdmin"]);
  const resultActionButtonsRaw: string[] = Array.isArray(s?.resultActionButtons)
    ? s.resultActionButtons
        .map((x: any) => (typeof x === "string" ? x.trim() : ""))
        .filter(Boolean)
    : [];
  const resultActionButtons: ResultActionButtonId[] = [];
  for (const id of resultActionButtonsRaw) {
    if (!allowedActionIds.has(id as ResultActionButtonId)) continue;
    if (resultActionButtons.includes(id as ResultActionButtonId)) continue;
    resultActionButtons.push(id as ResultActionButtonId);
    if (resultActionButtons.length >= 3) break;
  }
  if (resultActionButtons.length === 0) {
    resultActionButtons.push(...DEFAULT_SETTINGS.resultActionButtons);
  }

  const clampInt = (v: any, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  const searchWindowInitialWidth = clampInt(
    s?.searchWindowInitialWidth,
    DEFAULT_SETTINGS.searchWindowInitialWidth,
    450,
    1000,
  );
  const rawMaxHeight = s?.searchWindowMaxHeight ?? s?.searchWindowInitialHeight;
  const searchWindowMaxHeight = clampInt(rawMaxHeight, DEFAULT_SETTINGS.searchWindowMaxHeight, 200, 10000);
  const searchDisplayLimit = clampInt(s?.searchDisplayLimit, DEFAULT_SETTINGS.searchDisplayLimit, 20, 100);
  const preferredFileExtensions = (() => {
    const rawList = Array.isArray((s as any)?.preferredFileExtensions)
      ? (s as any).preferredFileExtensions
      : DEFAULT_SETTINGS.preferredFileExtensions;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of rawList) {
      const rawExt = typeof it === "string" ? it.trim().toLowerCase() : "";
      if (!rawExt) continue;
      const ext = rawExt.startsWith(".") ? rawExt : `.${rawExt}`;
      if (ext.length < 2 || ext.length > 12) continue;
      if (seen.has(ext)) continue;
      seen.add(ext);
      out.push(ext);
      if (out.length >= 80) break;
    }
    return out.length > 0 ? out : DEFAULT_SETTINGS.preferredFileExtensions;
  })();
  // 排序参数统一归一化后进入全局设置，避免 UI 临时值直接污染评分
  const searchRanking = normalizeSearchRanking((s as any)?.searchRanking);

  return {
    autoStart: Boolean(s?.autoStart),
    searchShortcut,
    settingsShortcut,
    acceptSelectedResultShortcut,
    theme,
    uiFontFamily,
    historyLimit:
      typeof s?.historyLimit === "number" && Number.isFinite(s.historyLimit)
        ? Math.min(50, Math.max(0, Math.floor(s.historyLimit)))
        : 5,
    defaultSearchTypeId: safeDefaultSearchTypeId,
    customSearchTypes,
    searchTypeOrder: normalizeSearchTypeOrder(s?.searchTypeOrder),
    disabledSearchTypeIds,
    ignoredPaths,
    keepStateOnClose: Boolean(s?.keepStateOnClose),
    // 默认显示路径：当配置缺失时回落到默认值，避免 Boolean(undefined) 误判为 false
    showResultPath: typeof s?.showResultPath === "boolean" ? s.showResultPath : DEFAULT_SETTINGS.showResultPath,
    enableHistory: s?.enableHistory !== false,
    backgroundImagePath,
    backgroundImageOpacity,
    customAvatarPath,
    resultActionButtons,
    searchWindowInitialWidth,
    searchWindowMaxHeight,
    searchDisplayLimit,
    searchRanking,
    compactMode: typeof s?.compactMode === "boolean" ? s.compactMode : DEFAULT_SETTINGS.compactMode,
    preferredFileExtensions,
  };
}

// 备份配置的存储 Key 已抽离：便于你统一调整 localStorage 的命名与迁移策略
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
    ?.invoke("get-app-bootstrap-state")
    .then((raw: any) => {
      const next: AppBootstrapState = {
        settings: normalizeSettings(raw?.settings),
        history: Array.isArray(raw?.history) ? raw.history : [],
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
          window.ipcRenderer?.invoke("save-settings", next);
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
          window.ipcRenderer?.invoke("save-settings", reset);
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

    const handler = (_event: any, next: AppSettings) => {
      const normalized = normalizeSettings(next);
      bootstrapStateCache = {
        ...bootstrapStateCache,
        settings: normalized,
      };
      setBaseSettings(normalized);
      setLoaded(true);
    };
    window.ipcRenderer?.on("settings-updated", handler as any);

    return () => {
      mounted = false;
      window.ipcRenderer?.off("settings-updated", handler as any);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--fs-font-sans", settings.uiFontFamily || DEFAULT_SETTINGS.uiFontFamily);
  }, [settings]);

  return { settings, loaded };
}
