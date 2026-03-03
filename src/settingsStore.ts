import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { AppSettings, DEFAULT_SETTINGS, ResultActionButtonId, SearchTypeOption } from "./appTypes";
import { useStoredMembership } from "./membership";

// 设置存储与衍生：规范化、会员降级、类型列表生成、主题应用、与主进程同步
export function normalizeSettings(s: any): AppSettings {
  const theme: AppSettings["theme"] = s?.theme === "light" ? "light" : "dark";
  const searchShortcut =
    typeof s?.searchShortcut === "string" && s.searchShortcut.trim()
      ? s.searchShortcut.trim()
      : DEFAULT_SETTINGS.searchShortcut;
  const settingsShortcut =
    typeof s?.settingsShortcut === "string" && s.settingsShortcut.trim()
      ? s.settingsShortcut.trim()
      : DEFAULT_SETTINGS.settingsShortcut;

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
    const baseIds = ["all", "file", "folder", "image", "video", "settings"];
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
    const baseIds = ["all", "file", "folder", "image", "video", "settings"];
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

  const effectType = s?.effectType === "warp" ? "warp" : s?.effectType === "waves" ? "waves" : "particles";
  const backgroundImagePath =
    typeof s?.backgroundImagePath === "string" ? s.backgroundImagePath.trim() : DEFAULT_SETTINGS.backgroundImagePath;
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
  const allowedActionIds = new Set<ResultActionButtonId>(["openFolder", "copyPath", "deleteHistory"]);
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

  return {
    autoStart: Boolean(s?.autoStart),
    searchShortcut,
    settingsShortcut,
    theme,
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
    showResultPath: Boolean(s?.showResultPath),
    enableHistory: s?.enableHistory !== false,
    accentColor: typeof s?.accentColor === "string" ? s.accentColor : DEFAULT_SETTINGS.accentColor,
    enableEffect: Boolean(s?.enableEffect),
    effectType,
    backgroundImagePath,
    backgroundImageOpacity,
    resultActionButtons,
  };
}

// 备份配置的存储 Key：用于会员状态变化时保留用户高级配置
const BACKUP_SETTINGS_KEY = "fs_backup_settings";

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
    accentColor: DEFAULT_SETTINGS.accentColor,
    defaultSearchTypeId: DEFAULT_SETTINGS.defaultSearchTypeId,
    customSearchTypes: [],
    searchTypeOrder: DEFAULT_SETTINGS.searchTypeOrder,
    showResultPath: false,
    enableEffect: false,
    effectType: "particles",
    // 非会员不允许自定义背景图：统一回落到默认背景
    backgroundImagePath: DEFAULT_SETTINGS.backgroundImagePath,
    backgroundImageOpacity: DEFAULT_SETTINGS.backgroundImageOpacity,
  });
}

export function getSearchTypeOptions(customTypes: string[], order: string[] | undefined): SearchTypeOption[] {
  const base: SearchTypeOption[] = [
    { id: "all", label: "所有类型" },
    { id: "file", label: "文件" },
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
  if (e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

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
            accentColor: backup.accentColor ?? prev.accentColor,
            defaultSearchTypeId: backup.defaultSearchTypeId ?? prev.defaultSearchTypeId,
            customSearchTypes: backup.customSearchTypes ?? prev.customSearchTypes,
            searchTypeOrder: backup.searchTypeOrder ?? prev.searchTypeOrder,
            showResultPath: backup.showResultPath ?? prev.showResultPath,
            enableEffect: backup.enableEffect ?? prev.enableEffect,
            effectType: backup.effectType ?? prev.effectType,
            backgroundImagePath: backup.backgroundImagePath ?? prev.backgroundImagePath,
            backgroundImageOpacity: backup.backgroundImageOpacity ?? prev.backgroundImageOpacity,
          };
          window.ipcRenderer?.invoke("save-settings", next);
          return next;
        });
        clearBackupSettings();
      }
    } else {
      setBaseSettings((prev) => {
        const hasCustomSettings =
          prev.accentColor !== DEFAULT_SETTINGS.accentColor ||
          prev.defaultSearchTypeId !== DEFAULT_SETTINGS.defaultSearchTypeId ||
          (prev.customSearchTypes && prev.customSearchTypes.length > 0) ||
          prev.showResultPath !== false ||
          prev.enableEffect !== false ||
          prev.effectType !== "particles" ||
          prev.backgroundImagePath !== DEFAULT_SETTINGS.backgroundImagePath ||
          prev.backgroundImageOpacity !== DEFAULT_SETTINGS.backgroundImageOpacity;

        if (hasCustomSettings) {
          saveBackupSettings({
            accentColor: prev.accentColor,
            defaultSearchTypeId: prev.defaultSearchTypeId,
            customSearchTypes: prev.customSearchTypes,
            searchTypeOrder: prev.searchTypeOrder,
            showResultPath: prev.showResultPath,
            enableEffect: prev.enableEffect,
            effectType: prev.effectType,
            backgroundImagePath: prev.backgroundImagePath,
            backgroundImageOpacity: prev.backgroundImageOpacity,
          });

          const reset = {
            ...prev,
            accentColor: DEFAULT_SETTINGS.accentColor,
            defaultSearchTypeId: DEFAULT_SETTINGS.defaultSearchTypeId,
            customSearchTypes: [],
            searchTypeOrder: DEFAULT_SETTINGS.searchTypeOrder,
            showResultPath: false,
            enableEffect: false,
            effectType: "particles" as const,
            backgroundImagePath: DEFAULT_SETTINGS.backgroundImagePath,
            backgroundImageOpacity: DEFAULT_SETTINGS.backgroundImageOpacity,
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
    window.ipcRenderer
      ?.invoke("get-settings")
      .then((s: AppSettings) => {
        if (!mounted) return;
        setBaseSettings(normalizeSettings(s));
        setLoaded(true);
      })
      .catch(() => {
        if (!mounted) return;
        setLoaded(true);
      });

    const handler = (_event: any, next: AppSettings) => {
      setBaseSettings(normalizeSettings(next));
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
    document.documentElement.style.setProperty("--fs-accent", settings.accentColor);
    const r = parseInt(settings.accentColor.slice(1, 3), 16);
    const g = parseInt(settings.accentColor.slice(3, 5), 16);
    const b = parseInt(settings.accentColor.slice(5, 7), 16);
    document.documentElement.style.setProperty("--fs-accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
    document.documentElement.style.setProperty("--fs-dots", `rgba(${r}, ${g}, ${b}, 0.2)`);
    document.documentElement.style.setProperty("--fs-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);
  }, [settings]);

  return { settings, loaded };
}
