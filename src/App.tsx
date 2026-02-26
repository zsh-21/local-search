import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { List } from "react-window";
import "./App.css";
import { login, refreshUserByToken, User } from "./api";
import { MEMBERSHIP_CONTROLLED_FEATURES } from "./membershipFeatureConfig";

interface AppItem {
  name: string;
  path: string;
  description?: string;
  icon?: string;
  type?: string;
}

interface SearchResponse {
  results: AppItem[];
  isIndexing: boolean;
}

interface AppSettings {
  autoStart: boolean;
  searchShortcut: string;
  settingsShortcut: string;
  theme: "dark" | "light";
  historyLimit: number;
  defaultSearchTypeId: string;
  customSearchTypes: string[];
  searchTypeOrder: string[];
  keepStateOnClose: boolean;
  showResultPath: boolean;
  enableHistory: boolean;
  accentColor: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStart: false,
  searchShortcut: "Alt+T",
  settingsShortcut: "Alt+Shift+T",
  theme: "dark",
  historyLimit: 5,
  defaultSearchTypeId: "all",
  customSearchTypes: [],
  searchTypeOrder: ["all", "file"],
  keepStateOnClose: false,
  showResultPath: false,
  enableHistory: true,
  accentColor: "#38bdf8",
};

const MEMBERSHIP_CHANGED_EVENT = "fs-membership-changed";

function getStoredTokenFromLocalStorage(): string {
  return (localStorage.getItem("fs_token") || "").trim();
}

async function refreshUserStatusSilently(opts?: { onUser?: (user: User) => void }): Promise<void> {
  const token = getStoredTokenFromLocalStorage();
  if (!token) return;

  try {
    const next = await refreshUserByToken(token);
    if (!next) return;
    localStorage.setItem("fs_user", JSON.stringify(next.user));
    localStorage.setItem("fs_token", next.token);
    window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
    opts?.onUser?.(next.user);
  } catch {
    return;
  }
}

function getStoredUserFromLocalStorage(): User | null {
  try {
    const raw = localStorage.getItem("fs_user");
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

function isUserMember(user: User | null): boolean {
  const expiresAt = user?.memberExpiresAt;
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

function useStoredMembership(): boolean {
  const [isMember, setIsMember] = useState(() => isUserMember(getStoredUserFromLocalStorage()));

  useEffect(() => {
    const refresh = () => setIsMember(isUserMember(getStoredUserFromLocalStorage()));

    window.addEventListener("storage", refresh);
    window.addEventListener(MEMBERSHIP_CHANGED_EVENT, refresh as EventListener);

    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(MEMBERSHIP_CHANGED_EVENT, refresh as EventListener);
    };
  }, []);

  return isMember;
}

function getMembershipLockTip(): string {
  const labels = MEMBERSHIP_CONTROLLED_FEATURES.map((x) => x.label);
  return `会员功能：${labels.join("、")}（开通会员后可使用）`;
}

function normalizeSettings(s: any): AppSettings {
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
    (defaultSearchTypeIdRaw.startsWith("ext:") &&
      /^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
      customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
      ? defaultSearchTypeIdRaw
      : "all";

  const normalizeSearchTypeOrder = (order: any) => {
    const baseIds = ["all", "file"];
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

  return {
    autoStart: Boolean(s?.autoStart),
    searchShortcut,
    settingsShortcut,
    theme,
    historyLimit:
      typeof s?.historyLimit === "number" && Number.isFinite(s.historyLimit)
        ? Math.min(50, Math.max(0, Math.floor(s.historyLimit)))
        : 5,
    defaultSearchTypeId,
    customSearchTypes,
    searchTypeOrder: normalizeSearchTypeOrder(s?.searchTypeOrder),
    keepStateOnClose: Boolean(s?.keepStateOnClose),
    showResultPath: Boolean(s?.showResultPath),
    enableHistory: s?.enableHistory !== false,
    accentColor: typeof s?.accentColor === "string" ? s.accentColor : DEFAULT_SETTINGS.accentColor,
  };
}

// 备份配置的存储 Key
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

function applyMembershipRestrictionsToSettings(settings: AppSettings, isMember: boolean): AppSettings {
  // 如果是会员，且存在备份配置，尝试恢复（仅在备份存在时）
  // 注意：这里是一个纯函数，副作用（恢复配置到 store）应在组件层处理
  // 但此处我们只负责返回“当前应展示的配置”。
  // 实际的“恢复”逻辑需要配合 useEffect 在状态变化时触发一次性写入。
  if (isMember) return settings;

  // 非会员：备份当前的高级配置（如果它们不是默认值），然后重置为默认值
  // 注意：applyMembershipRestrictionsToSettings 会在渲染循环中调用，
  // 因此不能在这里直接写 localStorage，否则会频繁 IO。
  // 备份逻辑应移动到 useSettings 的副作用中。

  return normalizeSettings({
    ...settings,
    // 非会员：关闭会员专属能力（同时避免通过本地设置绕过）
    accentColor: DEFAULT_SETTINGS.accentColor,
    defaultSearchTypeId: DEFAULT_SETTINGS.defaultSearchTypeId,
    customSearchTypes: [],
    searchTypeOrder: DEFAULT_SETTINGS.searchTypeOrder,
    showResultPath: false,
  });
}

type SearchTypeOption = { id: string; label: string };

function getSearchTypeOptions(customTypes: string[], order: string[] | undefined) {
  const base: SearchTypeOption[] = [
    { id: "all", label: "所有文件" },
    { id: "file", label: "文件" },
    // { id: "folder", label: "文件夹" },
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

function toAccelerator(e: React.KeyboardEvent) {
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

function useSettings() {
  const [baseSettings, setBaseSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const isMember = useStoredMembership();

  // 会员状态变化时的配置备份与恢复逻辑
  useLayoutEffect(() => {
    // 首次加载或状态变化时触发
    
    // 如果是会员，尝试恢复备份
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
          };
          window.ipcRenderer?.invoke("save-settings", next);
          return next;
        });
        clearBackupSettings();
      }
    } else {
      // 如果是非会员，备份当前非默认配置并重置
      setBaseSettings((prev) => {
        // 只有当当前配置包含自定义项时才备份
        const hasCustomSettings =
          prev.accentColor !== DEFAULT_SETTINGS.accentColor ||
          prev.defaultSearchTypeId !== DEFAULT_SETTINGS.defaultSearchTypeId ||
          (prev.customSearchTypes && prev.customSearchTypes.length > 0) ||
          prev.showResultPath !== false;

        if (hasCustomSettings) {
          saveBackupSettings({
            accentColor: prev.accentColor,
            defaultSearchTypeId: prev.defaultSearchTypeId,
            customSearchTypes: prev.customSearchTypes,
            searchTypeOrder: prev.searchTypeOrder,
            showResultPath: prev.showResultPath,
          });
          
          // 强制重置为默认值并保存
          const reset = {
            ...prev,
            accentColor: DEFAULT_SETTINGS.accentColor,
            defaultSearchTypeId: DEFAULT_SETTINGS.defaultSearchTypeId,
            customSearchTypes: [],
            searchTypeOrder: DEFAULT_SETTINGS.searchTypeOrder,
            showResultPath: false,
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
    window.ipcRenderer?.invoke("get-settings").then((s: AppSettings) => {
      if (!mounted) return;
      setBaseSettings(normalizeSettings(s));
    });

    const handler = (_event: any, next: AppSettings) => {
      setBaseSettings(normalizeSettings(next));
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
    // 设置初始透明度颜色
    const r = parseInt(settings.accentColor.slice(1, 3), 16);
    const g = parseInt(settings.accentColor.slice(3, 5), 16);
    const b = parseInt(settings.accentColor.slice(5, 7), 16);
    document.documentElement.style.setProperty("--fs-accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
    document.documentElement.style.setProperty("--fs-dots", `rgba(${r}, ${g}, ${b}, 0.2)`);
    document.documentElement.style.setProperty("--fs-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);
  }, [settings]);

  return settings;
}

function SearchView() {
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [searchTypeId, setSearchTypeId] = useState<string>(
    settings.defaultSearchTypeId || "all",
  );
  useEffect(() => {
    void refreshUserStatusSilently();
  }, []);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lastSelectedBy, setLastSelectedBy] = useState<"keyboard" | "mouse">("keyboard");
  const [results, setResults] = useState<AppItem[]>([]);
  const [visibleCount, setVisibleCount] = useState(50);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<any>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const typeSelectRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastResizeHeightRef = useRef(0);
  const resizeRafRef = useRef<number | null>(null);
  const queryRef = useRef("");
  const searchTypeIdRef = useRef(searchTypeId);
  const selectedPathRef = useRef("");

  const ITEM_HEIGHT = 52;
  const MAX_LIST_HEIGHT = 382;
  const TYPE_MENU_MIN_LIST_SPACE = 240;

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    searchTypeIdRef.current = searchTypeId;
  }, [searchTypeId]);

  useEffect(() => {
    selectedPathRef.current = results[selectedIndex]?.path || "";
  }, [results, selectedIndex]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (typeSelectRef.current && !typeSelectRef.current.contains(e.target as Node)) {
        setTypeMenuOpen(false);
      }
    };
    if (typeMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [typeMenuOpen]);

  const filterItemsBySearchType = (items: AppItem[], typeId: string) => {
    const id = typeof typeId === "string" && typeId.trim() ? typeId.trim() : "all";
    if (id === "all") return items;
    if (id === "file") return items.filter((x) => x.type === "file");
    if (id === "folder") return items.filter((x) => x.type === "folder");
    if (id.startsWith("ext:")) {
      const ext = id.slice(4).toLowerCase();
      if (!ext) return items;
      return items.filter(
        (x) => x.type === "file" && (x.path || "").toLowerCase().endsWith(ext),
      );
    }
    return items;
  };

  const [width, setWidth] = useState(720);

  useEffect(() => {
    window.ipcRenderer?.invoke("get-window-bounds").then((bounds: any) => {
      if (bounds) setWidth(bounds.width);
    });
  }, []);

  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const startXPosRef = useRef(0);
  const resizeDirRef = useRef<"left" | "right" | null>(null);

  const startResizing = async (e: React.MouseEvent, dir: "left" | "right") => {
    e.preventDefault();
    e.stopPropagation();
    
    const bounds = await window.ipcRenderer?.invoke("get-window-bounds");
    if (!bounds) return;

    isResizingRef.current = true;
    startXRef.current = e.screenX;
    startWidthRef.current = bounds.width;
    startXPosRef.current = bounds.x;
    resizeDirRef.current = dir;
    document.body.style.cursor = "ew-resize";
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      const deltaX = e.screenX - startXRef.current;
      let newWidth = startWidthRef.current;
      let newX = startXPosRef.current;

      if (resizeDirRef.current === "right") {
        newWidth = startWidthRef.current + deltaX;
      } else if (resizeDirRef.current === "left") {
        newWidth = startWidthRef.current - deltaX;
        newX = startXPosRef.current + deltaX;
      }

      // 限制宽度
      if (newWidth < 450) {
        if (resizeDirRef.current === "left") {
          newX = startXPosRef.current + (startWidthRef.current - 450);
        }
        newWidth = 450;
      } else if (newWidth > 1000) {
        if (resizeDirRef.current === "left") {
          newX = startXPosRef.current - (1000 - startWidthRef.current);
        }
        newWidth = 1000;
      }

      setWidth(newWidth);
      window.ipcRenderer?.invoke("set-window-bounds", {
        width: Math.round(newWidth),
        x: Math.round(newX)
      });
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        resizeDirRef.current = null;
        document.body.style.cursor = "";
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []); // Remove width dependency to avoid re-binding during resize

  const searchTypeOptions = useMemo(
    () =>
      getSearchTypeOptions(
        settings.customSearchTypes || [],
        settings.searchTypeOrder,
      ),
    [settings.customSearchTypes, settings.searchTypeOrder],
  );

  useEffect(() => {
    const valid = searchTypeOptions.some((t) => t.id === searchTypeId);
    if (!valid) setSearchTypeId(settings.defaultSearchTypeId || "all");
  }, [searchTypeId, searchTypeOptions, settings.defaultSearchTypeId]);

  const placeholder = useMemo(() => {
    if (searchTypeId === "all") return "搜索所有文件与文件夹...";
    if (searchTypeId === "file") return "搜索文件（不含文件夹）...";
    if (searchTypeId === "folder") return "搜索文件夹（不含文件）...";
    if (searchTypeId.startsWith("ext:")) {
      const ext = searchTypeId.slice(4);
      return `搜索${ext} 文件...`;
    }
    return "搜索所有文件与文件夹...";
  }, [searchTypeId]);

  useEffect(() => {
    inputRef.current?.focus();
    const handleReset = async() => {
      void refreshUserStatusSilently();
      // 这里的 settings 必须是最新的，否则会导致 keepStateOnClose 判断错误
      window.ipcRenderer?.invoke("get-settings").then(async (latestSettings: AppSettings) => {
        const s = normalizeSettings(latestSettings);
        if (s.keepStateOnClose) {
          // 如果开启了保留状态，只重新聚焦，不重置
          setTimeout(() => {
            inputRef.current?.focus();
            window.ipcRenderer?.invoke("search-view-ready");
          }, 50);
          return;
        }
        const nextTypeId = s.defaultSearchTypeId || "all";
        setSearchTypeId(nextTypeId);
        setQuery("");
        const resp = (await window.ipcRenderer?.invoke("get-history")) as
            | { results: AppItem[] }
            | undefined;
        const historyItems = resp?.results ?? [];
        setResults(filterItemsBySearchType(historyItems, nextTypeId));
        setVisibleCount(50);
        setIsSearching(false);
        setTimeout(() => {
          inputRef.current?.focus();
          window.ipcRenderer?.invoke("search-view-ready");
        }, 50);
      });
    };
    window.ipcRenderer?.on("reset-search", handleReset);
    return () => {
      window.ipcRenderer?.removeAllListeners("reset-search");
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      setTypeMenuOpen(false);
    };
    window.ipcRenderer?.on("search-window-hidden", handler as any);
    return () => {
      window.ipcRenderer?.off("search-window-hidden", handler as any);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      void refreshUserStatusSilently();
      inputRef.current?.focus();
      window.ipcRenderer?.invoke("search-view-ready");
      if (queryRef.current.trim().length === 0) {
        void refreshHistory({
          typeId: searchTypeIdRef.current,
          preserveSelectedPath: selectedPathRef.current,
        });
      }
    };
    window.ipcRenderer?.on("search-window-opened", handler as any);
    return () => {
      window.ipcRenderer?.off("search-window-opened", handler as any);
    };
  }, []);

  useEffect(() => {
    const handler = (_event: any, { query: respQuery, results: moreResults }: { query: string, results: AppItem[] }) => {
      if (respQuery === query) {
        // 再次过滤确保结果类型一致性
        const filteredMore = filterItemsBySearchType(moreResults, searchTypeId);
        if (filteredMore.length > 0) {
          setResults(prev => [...prev, ...filteredMore]);
        }
      }
    };
    window.ipcRenderer?.on("more-results", handler);
    return () => {
      window.ipcRenderer?.removeAllListeners("more-results");
    };
  }, [query, searchTypeId]);

  useEffect(() => {
    if (!query || query.trim().length < 2) {
      if (query.trim().length === 0) {
        refreshHistory();
      } else {
        setResults([]);
        setVisibleCount(50);
        setIsSearching(false);
        setHasMore(false);
      }
      return;
    }

    setIsSearching(true);
    setHasMore(false);
    const timer = setTimeout(async () => {
      try {
        const resp = (await window.ipcRenderer?.invoke(
          "search-files",
          query,
          { searchTypeId },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;
        const nextResults = resp?.results ?? [];
        setResults(nextResults);
        setVisibleCount(50);
        setSelectedIndex(0);
        setIsIndexing(Boolean(resp?.isIndexing));
        setHasMore(Boolean(resp?.hasMore));
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query, searchTypeId]);

  useEffect(() => {
    const handleMoreResults = (_: any, data: { query: string; results: AppItem[] }) => {
      if (data.query === query) {
        setResults(prev => [...prev, ...data.results]);
      }
    };
    window.ipcRenderer?.on("more-results", handleMoreResults);
    return () => {
      window.ipcRenderer?.off("more-results", handleMoreResults);
    };
  }, [query]);

  useEffect(() => {
    // 只有在通过键盘导航（上下键）改变选中索引时，才执行自动滚动
    if (listRef.current && lastSelectedBy === "keyboard") {
      // 检查当前 react-window List 版本支持的方法
      if (typeof listRef.current.scrollToItem === 'function') {
        listRef.current.scrollToItem(selectedIndex, 'auto');
      } else if (typeof listRef.current.scrollToRow === 'function') {
        listRef.current.scrollToRow({ index: selectedIndex, align: "auto" });
      }
    }
  }, [selectedIndex, lastSelectedBy]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.ipcRenderer?.send("hide-window");
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setTypeMenuOpen(false)
      window.ipcRenderer?.invoke("hide-window");
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const idx = Math.max(
        0,
        searchTypeOptions.findIndex((t) => t.id === searchTypeId),
      );
      const next = searchTypeOptions[(idx + 1)>searchTypeOptions.length-1?0:idx+1];
      if (next) setSearchTypeId(next.id);
      setTypeMenuOpen(false);
      return;
    }

    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => (prev + 1) % results.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      e.preventDefault();
    } else if (e.key === "Enter") {
      launchApp(results[selectedIndex]);
    }
  };

  const launchApp = (app: AppItem) => {
    window.ipcRenderer?.invoke("open-item", {
      name: app.name,
      path: app.path,
      type: app.type || "file",
    });
    // 不在这里清除 query 和 results，交给下一次呼出时的 reset-search 处理
  };

  const openFolder = (app: AppItem) => {
    window.ipcRenderer?.invoke("open-folder", app.path);
  };

  const openSettings = () => {
    window.ipcRenderer?.invoke("open-settings-window");
  };

  const isHistoryMode = query.trim().length === 0;

  const refreshHistory = async (opts?: { typeId?: string; preserveSelectedPath?: string }) => {
    const resp = (await window.ipcRenderer?.invoke("get-history")) as
      | { results: AppItem[] }
      | undefined;
    const historyItems = resp?.results ?? [];
    const typeId = typeof opts?.typeId === "string" ? opts.typeId : searchTypeId;
    const filtered = filterItemsBySearchType(historyItems, typeId);
    setResults(filtered);
    const preservePath = typeof opts?.preserveSelectedPath === "string" ? opts.preserveSelectedPath : "";
    if (preservePath) {
      const idx = filtered.findIndex((x) => x.path === preservePath);
      setSelectedIndex(idx >= 0 ? idx : 0);
    } else {
      setSelectedIndex(0);
    }
    setIsSearching(false);
    setIsIndexing(false);
  };

  const deleteHistoryItem = async (targetPath: string) => {
    if (!targetPath) return;
    await window.ipcRenderer?.invoke("delete-history-item", targetPath);
    await refreshHistory();
  };

  const statusText = isSearching
    ? "正在搜索…"
    : isIndexing
      ? "正在建立本地文件索引…"
      : "";

  const getExtension = (path: string) => {
    const parts = path.split(".");
    return parts.length > 1 ? parts.pop()?.toUpperCase() : "";
  };

  const isImageFile = (path: string) => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg"].includes(ext);
  };

  const Row = ({
    index,
    style,
    ariaAttributes,
  }: {
    index: number;
    style: React.CSSProperties;
    ariaAttributes?: any;
  }) => {
    const item = visibleResults[index];
    if (!item) return null;

    const isSelected = index === selectedIndex;
    const isImg = item.type === "file" && isImageFile(item.path);
    const lowerPath = (item.path || "").toLowerCase();
    const isLink = lowerPath.endsWith(".lnk") || lowerPath.endsWith(".url");
    const badgeText =
      item.type === "folder"
        ? "文件夹"
        : isLink
          ? "LINK"
          : item.type === "file"
            ? getExtension(item.path)
            : "";

    return (
      <div
        style={style}
        {...ariaAttributes}
        className={`result-item-wrapper ${isSelected ? "selected" : ""}`}
        onClick={() => launchApp(item)}
        onMouseEnter={() => {
          if (selectedIndex !== index) {
            setLastSelectedBy("mouse");
            setSelectedIndex(index);
          }
        }}
      >
        <li className={index === selectedIndex ? "selected" : ""}>
          <span className="result-index">{index + 1}</span>
          {item.icon ? (
            <img 
              className={`result-icon ${isImg ? "image-preview" : ""}`} 
              src={item.icon} 
              alt="" 
            />
          ) : (
            <span className="result-icon placeholder" />
          )}
          <div className="result-meta">
            <div className="result-name-row">
              <span className="app-name">{item.name}</span>
              {badgeText ? <span className="file-ext-badge">{badgeText}</span> : null}
              {index === selectedIndex && (
                <span className="shortcut-hint">ENTER</span>
              )}
            </div>
            {settings.showResultPath ? (
              <span className="app-path" title={item.path}>
                {item.path}
              </span>
            ) : null}
          </div>
          <div className="action-group">
            <button
              className="action-btn"
              onClick={(e) => {
                e.stopPropagation();
                openFolder(item);
              }}
              title="打开所在目录"
              aria-label="打开所在目录"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M3 7.5c0-1.1.9-2 2-2h5l2 2h7c1.1 0 2 .9 2 2v7.5c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.5Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="action-btn"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(item.path);
              }}
              title="复制路径"
              aria-label="复制路径"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M8 4V3c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v10c0 .6-.4 1-1 1h-1M4 8v12c0 .6.4 1 1 1h10c.6 0 1-.4 1-1V8c0-.6-.4-1-1-1H5c-.6 0-1 .4-1 1Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {isHistoryMode ? (
              <button
                className="action-btn delete-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteHistoryItem(item.path);
                }}
                title="删除该历史"
                aria-label="删除该历史"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6 6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : null}
          </div>
        </li>
      </div>
    );
  };

  const visibleResults = useMemo(() => {
    return results.slice(0, visibleCount);
  }, [results, visibleCount]);

  const getSearchTypeIcon = (opt: any) => {
    if (opt.id === "all") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
        </svg>
      );
    }
    if (opt.id === "file") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
      );
    }
    if (opt.id === "folder") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>
        </svg>
      );
    }
    if (opt.id.startsWith("ext:")) {
      return <span className="type-icon-text">{opt.id.slice(4).toUpperCase()}</span>;
    }
    return null;
  };

  const currentTypeLabel = useMemo(() => {
    return searchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有文件";
  }, [searchTypeId, searchTypeOptions]);

  const listHeight = Math.min(visibleResults.length * ITEM_HEIGHT, MAX_LIST_HEIGHT);
  
  const showEmptyState =
    query.trim().length >= 1 &&
    !isSearching &&
    !isIndexing &&
    results.length === 0;

  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;

    const run = () => {
      const c = containerRef.current;
      if (!c) return;

      const containerRect = c.getBoundingClientRect();
      let nextHeight = Math.ceil(containerRect.height);

      const menuEl = typeMenuOpen ? typeMenuRef.current : null;
      if (menuEl) {
        const menuRect = menuEl.getBoundingClientRect();
        const needed = Math.ceil(menuRect.bottom - containerRect.top + 10);
        nextHeight = Math.max(nextHeight, needed, TYPE_MENU_MIN_LIST_SPACE);
      }

      nextHeight = Math.max(nextHeight, 76);
      if (nextHeight !== lastResizeHeightRef.current) {
        lastResizeHeightRef.current = nextHeight;
        window.ipcRenderer?.invoke("resize-window", nextHeight);
      }
    };

    if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(run);
    return () => {
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    };
  }, [isSearching, isIndexing, results.length, visibleResults.length, query, typeMenuOpen, showEmptyState]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      const c = containerRef.current;
      if (!c) return;
      const nextHeight = Math.max(76, Math.ceil(c.getBoundingClientRect().height));
      if (nextHeight !== lastResizeHeightRef.current) {
        lastResizeHeightRef.current = nextHeight;
        window.ipcRenderer?.invoke("resize-window", nextHeight);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollToTop = () => {
    if (scrollContainerRef.current&&listRef.current) {
      listRef.current.scrollToRow({ index: 0, align: "auto",behavior: "smooth" });
      setSelectedIndex(0);
    }
  };

  const onItemsRendered = (
    visibleRows: { startIndex: number; stopIndex: number },
    _allRows: { startIndex: number; stopIndex: number },
  ) => {
    if (visibleRows.stopIndex >= visibleResults.length - 1 && visibleResults.length < results.length) {
      setVisibleCount(prev => prev + 50);
    }
  };

  // 渲染底部信息的组件，作为虚拟列表的最后一个元素
  const BottomInfo = () => {
    if (results.length === 0) return null;
    return (
      <div className="list-bottom-info">
        {visibleResults.length < results.length ? (
          isSearching || isIndexing ? (
            <div className="loading-more">
              <span className="spinner" />
              <span>正在加载更多结果...</span>
            </div>
          ) : (
            <div className="no-more-results">
              {`已显示 ${visibleResults.length} / ${results.length} ${isHistoryMode ? "条历史记录" : "个结果"}`}
            </div>
          )
        ) : (
          <div className="no-more-results">
            {isHistoryMode ? `已显示全部 ${results.length} 条历史记录` : `已显示全部 ${results.length} 个结果`}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`container search-container ${typeMenuOpen ? "menu-open" : ""}`} ref={containerRef} onKeyDownCapture={handleKeyDown}>
      <div
        className="resize-handle left"
        onMouseDown={(e) => startResizing(e, "left")}
      />
      <div
        className="resize-handle right"
        onMouseDown={(e) => startResizing(e, "right")}
      />
      <div className="search-box">
        <div className="search-icon-wrapper">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="search-icon-svg">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
        <div className="search-box-right">
          <div className="result-count">
            {results.length > 0 ? `${results.length} 条结果` : ""}
          </div>
          <div className="type-select" ref={typeSelectRef}>
            <button
              className="type-select-btn"
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setTypeMenuOpen((v) => !v);
              }}
              aria-haspopup="menu"
              aria-expanded={typeMenuOpen}
              aria-label="切换搜索类型"
              title="切换搜索类型"
            >
              <span className="type-select-label">{currentTypeLabel}</span>
              <span className="type-select-caret">▾</span>
            </button>
            {typeMenuOpen ? (
              <div 
                className="type-select-menu" 
                role="menu"
                ref={typeMenuRef}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="type-select-menu-inner">
                  {searchTypeOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`type-select-item ${opt.id === searchTypeId ? "active" : ""}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSearchTypeId(opt.id);
                        setTypeMenuOpen(false);
                      }}
                    >
                      <div className="type-select-item-left">
                        {/* <div className="type-item-icon">
                          {getSearchTypeIcon(opt)}
                        </div> */}
                        <span>{opt.label}</span>
                      </div>
                      {opt.id === searchTypeId && <span className="check-mark">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <button
          className="settings-btn"
          onClick={openSettings}
          title="设置"
          type="button"
          aria-label="设置"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="drag-icon" title="按住拖拽移动" />
      </div>

      {statusText && (
        <div className="status">
          <span className="spinner" />
          <span className="status-text">{statusText}</span>
        </div>
      )}

      {(visibleResults.length > 0 || showEmptyState) && (
        <div className="results">
          {showEmptyState ? (
            <div className="empty-state">暂无搜索结果...😭</div>
          ) : (
            <>
              <div 
                ref={scrollContainerRef}
                className="results-scroll-container" 
                style={{ maxHeight: MAX_LIST_HEIGHT, overflowY: 'auto' }}
              >
                <List<any>
                  listRef={listRef}
                  style={{ height: listHeight, width: "100%", overflow: 'visible' }}
                  rowCount={visibleResults.length}
                  rowHeight={ITEM_HEIGHT}
                  className="virtual-list"
                  rowComponent={Row}
                  rowProps={{}}
                  onRowsRendered={onItemsRendered}
                />
                <BottomInfo />
              </div>
              {selectedIndex > 8 && (
                <button 
                  className="back-to-top-btn" 
                  onClick={scrollToTop}
                  title="返回顶部"
                  type="button"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m18 15-6-6-6 6"/>
                  </svg>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SettingsView() {
  const settings = useSettings();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [error, setError] = useState("");
  const [maximized, setMaximized] = useState(false);
  const [activeKey, setActiveKey] = useState<
    "general" | "search" | "shortcuts" | "appearance" | "account"
  >("account");
  const [newTypeExt, setNewTypeExt] = useState("");

  useEffect(() => {
    setDraft(settings);
  }, [
    settings.autoStart,
    settings.searchShortcut,
    settings.settingsShortcut,
    settings.theme,
    settings.historyLimit,
    settings.defaultSearchTypeId,
    settings.customSearchTypes,
    settings.searchTypeOrder,
    settings.showResultPath,
    settings.accentColor,
  ]);

  useEffect(() => {
    const handler = () => {
      void refreshUserStatusSilently({ onUser: (nextUser) => setUser(nextUser) });
      setDraft(settings);
      setError("");
      setActiveKey("account");
      setNewTypeExt("");
      document.documentElement.dataset.theme = settings.theme;
      document.documentElement.style.setProperty("--fs-accent", settings.accentColor);
      // 重置带透明度的颜色
      const r = parseInt(settings.accentColor.slice(1, 3), 16);
      const g = parseInt(settings.accentColor.slice(3, 5), 16);
      const b = parseInt(settings.accentColor.slice(5, 7), 16);
      document.documentElement.style.setProperty("--fs-accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
      document.documentElement.style.setProperty("--fs-dots", `rgba(${r}, ${g}, ${b}, 0.2)`);
      document.documentElement.style.setProperty("--fs-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);
    };
    window.ipcRenderer?.on("settings-window-opened", handler as any);
    return () => {
      window.ipcRenderer?.off("settings-window-opened", handler as any);
    };
  }, [settings]);

  const applyThemePreview = (theme: AppSettings["theme"], accentColor: string) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--fs-accent", accentColor);
    // 计算带透明度的主题色
    const r = parseInt(accentColor.slice(1, 3), 16);
    const g = parseInt(accentColor.slice(3, 5), 16);
    const b = parseInt(accentColor.slice(5, 7), 16);
    document.documentElement.style.setProperty("--fs-accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
    document.documentElement.style.setProperty("--fs-dots", `rgba(${r}, ${g}, ${b}, 0.2)`);
    document.documentElement.style.setProperty("--fs-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);

    document.documentElement.classList.add("theme-anim");
    window.setTimeout(() => {
      document.documentElement.classList.remove("theme-anim");
    }, 240);
  };

  const onClose = () => {
    setError("");
    setDraft(settings);
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--fs-accent", settings.accentColor);
    // 重置带透明度的颜色
    const r = parseInt(settings.accentColor.slice(1, 3), 16);
    const g = parseInt(settings.accentColor.slice(3, 5), 16);
    const b = parseInt(settings.accentColor.slice(5, 7), 16);
    document.documentElement.style.setProperty("--fs-accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
    document.documentElement.style.setProperty("--fs-dots", `rgba(${r}, ${g}, ${b}, 0.2)`);
    document.documentElement.style.setProperty("--fs-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);
    window.ipcRenderer?.invoke("hide-window");
  };

  const onToggleMax = async () => {
    const resp = (await window.ipcRenderer?.invoke("toggle-maximize")) as
      | { maximized: boolean }
      | undefined;
    if (typeof resp?.maximized === "boolean") setMaximized(resp.maximized);
  };

  const save = async () => {
    setError("");
    const nextDraft = applyMembershipRestrictionsToSettings(draft, isUserMember(user));
    const resp = (await window.ipcRenderer?.invoke("save-settings", nextDraft)) as
      | { ok: boolean; message?: string }
      | undefined;
    if (resp?.ok === false) {
      setError(resp.message || "设置保存失败");
      return;
    }
    // 保存成功后，立即确保本地主题色是最新的
    applyThemePreview(nextDraft.theme, nextDraft.accentColor);
    window.ipcRenderer?.invoke("hide-window");
  };

  const typeOptions = useMemo(
    () => getSearchTypeOptions(draft.customSearchTypes || [], draft.searchTypeOrder),
    [draft.customSearchTypes, draft.searchTypeOrder],
  );

  const moveTypeId = (list: string[], fromId: string, toId: string, position: "before" | "after") => {
    const fromIndex = list.indexOf(fromId);
    let toIndex = list.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) return list;
    
    const next = list.slice();
    const [item] = next.splice(fromIndex, 1);
    
    // 重新计算 toIndex，因为 splice 之后索引可能变化
    toIndex = next.indexOf(toId);
    if (position === "after") {
      next.splice(toIndex + 1, 0, item);
    } else {
      next.splice(toIndex, 0, item);
    }
    return next;
  };

  const setShortcut = (
    key: "searchShortcut" | "settingsShortcut",
    e: React.KeyboardEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const accel = toAccelerator(e);
    if (!accel) return;
    setDraft({ ...draft, [key]: accel });
    setError("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  const navItems = useMemo(
    () => [
      {
        key: "general" as const,
        label: "通用",
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
          </svg>
        ),
      },
      {
        key: "search" as const,
        label: "搜索",
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
            <path d="m20 20-3.3-3.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        key: "shortcuts" as const,
        label: "快捷键",
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M7 15a4 4 0 1 1 0-8h6a4 4 0 1 1 0 8H7Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path d="M10 9v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M14 9v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        key: "appearance" as const,
        label: "外观",
        icon: (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3a9 9 0 1 0 9 9c0-.4-.03-.8-.08-1.19A7 7 0 0 1 12 3Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
    ],
    [],
  );

  const sectionMeta = useMemo(() => {
    return {
      general: { title: "通用", desc: "启动、状态与历史记录" },
      search: { title: "搜索", desc: "默认类型、自定义类型与顺序" },
      shortcuts: { title: "快捷键", desc: "呼出搜索与打开设置" },
      appearance: { title: "外观", desc: "主题模式与主题色" },
      account: { title: "账号", desc: "登录与账号状态" },
    } as const;
  }, []);

  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem("fs_user");
    return saved ? JSON.parse(saved) : null;
  });
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const isMember = useMemo(() => isUserMember(user), [user]);
  const membershipLockTip = useMemo(() => getMembershipLockTip(), []);
  const [loginForm, setLoginForm] = useState({ account: "", password: "" });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [toast, setToast] = useState<null | { kind: "success" | "error" | "info"; message: string }>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (message: string, kind: "success" | "error" | "info" = "info") => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ kind, message });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2000);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const doRefreshStatus = async () => {
    if (isRefreshingStatus) return;
    if (!getStoredTokenFromLocalStorage()) return;
    setIsRefreshingStatus(true);
    try {
      // 强制至少展示 1 秒 loading
      await Promise.all([
        refreshUserStatusSilently({ onUser: (nextUser) => setUser(nextUser) }),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      showToast("已更新", "success");
    } finally {
      setIsRefreshingStatus(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginForm.account || !loginForm.password) {
      setLoginError("请输入账号和密码");
      showToast("请输入账号和密码", "info");
      return;
    }
    setIsLoggingIn(true);
    setLoginError("");

    try {
      const data = await login(loginForm.account, loginForm.password);
      setUser(data.user);
      localStorage.setItem("fs_user", JSON.stringify(data.user));
      localStorage.setItem("fs_token", data.token);
      window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
      setLoginForm({ account: "", password: "" });
      showToast("登录成功", "success");
    } catch (err: any) {
      const msg = err?.message || "登录失败";
      setLoginError(msg);
      showToast(msg, "error");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (!user || isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await new Promise((r) => window.setTimeout(r, 350));
      setUser(null);
      localStorage.removeItem("fs_user");
      localStorage.removeItem("fs_token");
      window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
      showToast("已退出登录", "success");
    } finally {
      setIsLoggingOut(false);
    }
  };


  const getSearchTypeIcon = (opt: any) => {
    if (opt.id === "all") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
        </svg>
      );
    }
    if (opt.id === "file") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
      );
    }
    if (opt.id === "folder") {
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>
        </svg>
      );
    }
    if (opt.id.startsWith("ext:")) {
      return <span className="type-icon-text">{opt.id.slice(4).toUpperCase()}</span>;
    }
    return null;
  };

  const themeColors = [
    { name: "天际蓝", color: "#38bdf8" },
    { name: "罗兰紫", color: "#818cf8" },
    { name: "极光绿", color: "#34d399" },
    { name: "珊瑚红", color: "#fb7185" },
    { name: "琥珀橙", color: "#fbbf24" },
    { name: "翡翠绿", color: "#10b981" },
    { name: "深海蓝", color: "#2563eb" },
    { name: "丁香紫", color: "#a855f7" },
    { name: "玫瑰金", color: "#f43f5e" },
    { name: "钛金灰", color: "#64748b" },
  ];

  const formatDateTime = (value: unknown) => {
    if (!value) return "";
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
  };

  return (
    <div className={`container settings-container ${maximized ? "maximized" : ""}`} onKeyDown={handleKeyDown}>
      <div
        className="settings-header"
        title="按住拖拽可移动窗口"
      >
        <div
          className="settings-title-wrap"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onToggleMax();
          }}
          title="双击全屏/取消全屏"
        >
          <img src="/tray.svg" className="settings-logo" alt="logo" />
          <span className="settings-title">设置</span>
          <button
            type="button"
            className="settings-official-link"
            title="访问官网"
            onClick={(e) => {
              e.stopPropagation();
              // 使用 electron 打开外部链接
              window.ipcRenderer?.invoke("open-external", "http://www.yitong.xin/");
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
        <div className="settings-header-spacer" />
        <div className="settings-window-controls">
          <button
            type="button"
            className="window-btn"
            onClick={() => window.ipcRenderer?.invoke("minimize-window")}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label="最小化"
            title="最小化"
          >
            <span style={{ fontSize: 14,fontWeight:600, transform: "translateY(-2px)" }}>—</span>
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={onToggleMax}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label="全屏/取消全屏"
            title="全屏/取消全屏"
          >
            {maximized ? (
              <span style={{ fontSize: 20 }}>❐</span>
            ) : (
              <span style={{ fontSize: 20 }}>▢</span>
            )}
          </button>
          <button
            type="button"
            className="window-btn close"
            onClick={onClose}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label="关闭"
            title="关闭"
          >
            <span style={{ fontSize: 30 }}>×</span>
          </button>
        </div>
      </div>
		    <div className="settings-panel">
        <div className="settings-shell"> 
          <div className="settings-body">
            <div className="settings-nav" role="tablist" aria-label="设置菜单">
              <button
                type="button"
                className={`settings-nav-account-card ${activeKey === "account" ? "active" : ""}`}
                onClick={() => setActiveKey("account")}
              >
                <div className="settings-account-avatar-box">
                  <span className="settings-nav-account-avatar" aria-hidden="true">
                    {user ? (
                      <span className="settings-nav-account-avatar-text">
                        {user.avatarText || user.nickname?.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <svg
                        className="settings-nav-account-avatar-icon"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M20 21a8 8 0 1 0-16 0"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                        />
                        <path
                          d="M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
                          stroke="currentColor"
                          strokeWidth="1.8"
                        />
                      </svg>
                    )}
                  </span>
                </div>
                <span className="settings-nav-account-meta">
                  <span className="settings-nav-account-name">
                    {user ? user.nickname || user.phone || user.email : "未登录"}
                  </span>
                  <span className="settings-nav-account-sub">
                    {user ? user.email || user.phone || "" : "点击登录"}
                  </span>
                </span>
              </button>

              <div className="settings-nav-divider" aria-hidden="true" />
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`settings-nav-item ${activeKey === item.key ? "active" : ""}`}
                  onClick={() => setActiveKey(item.key)}
                >
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span className="settings-nav-label">{item.label}</span>
                </button>
              ))}
            </div>

            <div className="settings-main">
              <div className="settings-main-inner">
                
                {activeKey === "general" ? (
                  <div className="settings-content">
                    <div className="settings-group">
                      <div className="settings-group-title">启动</div>
                      <label className="setting-row">
                        <input
                          type="checkbox"
                          checked={draft.autoStart}
                          onChange={(e) => {
                            setDraft({ ...draft, autoStart: e.target.checked });
                            setError("");
                          }}
                        />
                        <span>跟随此电脑启动自动运行</span>
                      </label>
                    </div>
                    <div className="settings-group">
                      <div className="settings-group-title">搜索状态</div>
                      <label className="setting-row">
                        <input
                          type="checkbox"
                          checked={draft.keepStateOnClose}
                          onChange={(e) => {
                            setDraft({ ...draft, keepStateOnClose: e.target.checked });
                            setError("");
                          }}
                        />
                        <span>呼出面板时保留上一次的状态</span>
                      </label>
                    </div>
                    <div className="settings-group">
                      <div className="settings-group-title">历史记录</div>
                      <label className="setting-row">
                        <input
                          type="checkbox"
                          checked={draft.enableHistory}
                          onChange={(e) => {
                            setDraft({ ...draft, enableHistory: e.target.checked });
                            setError("");
                          }}
                        />
                        <span>记录历史操作</span>
                      </label>
                      <div className="form-row">
                        <div className="form-label">最大展示数量</div>
                        <input
                          className="number-input"
                          type="number"
                          min={0}
                          max={50}
                          step={1}
                          value={draft.historyLimit}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            setDraft({
                              ...draft,
                              historyLimit: Number.isFinite(n)
                                ? Math.min(50, Math.max(0, Math.floor(n)))
                                : 5,
                            });
                            setError("");
                          }}
                        />
                      </div>
                      <div className="form-row">
                        <div className="form-label">历史操作</div>
                        <button
                          type="button"
                          className="small-btn"
                          onClick={async () => {
                            setError("");
                            const ok = window.confirm(
                              "确定要清除所有历史记录吗？此操作不可恢复。",
                            );
                            if (!ok) return;
                            await window.ipcRenderer?.invoke("clear-history");
                          }}
                        >
                          清除所有历史
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeKey === "search" ? (
                  <div className="settings-content">
                    <div className="settings-group">
                      <div className="settings-group-title">默认类型</div>
                      <div className="form-row">
                        <div className="form-label">默认选择</div>
                        <select
                          className="select-input"
                          value={draft.defaultSearchTypeId}
                          disabled={!isMember}
                          title={!isMember ? membershipLockTip : undefined}
                          onChange={(e) => {
                            setDraft({ ...draft, defaultSearchTypeId: e.target.value });
                            setError("");
                          }}
                        >
                          {typeOptions.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="settings-group">
                      <div className="settings-group-title">列表显示</div>
                      <label className="setting-row" title={!isMember ? membershipLockTip : undefined}>
                        <input
                          type="checkbox"
                          checked={draft.showResultPath}
                          disabled={!isMember}
                          onChange={(e) => {
                            setDraft({ ...draft, showResultPath: e.target.checked });
                            setError("");
                          }}
                        />
                        <span>显示列表文件地址</span>
                      </label>
                    </div>

                    <div className="settings-group">
                      <div className="settings-group-title">自定义类型</div>
                      <div className="form-row">
                        <div className="form-label">新增后缀</div>
                        <div className="input-with-btn">
                          <input
                            type="text"
                            className="text-input"
                            value={newTypeExt}
                            placeholder=".docx"
                            disabled={!isMember}
                            title={!isMember ? membershipLockTip : undefined}
                            onChange={(e) => {
                              setNewTypeExt(e.target.value);
                              setError("");
                            }}
                          />
                          <button
                            type="button"
                            className="small-btn"
                            disabled={!isMember}
                            title={!isMember ? membershipLockTip : undefined}
                            onClick={() => {
                              const ext = newTypeExt.trim().toLowerCase();
                              if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
                                setError("后缀格式不合法（例如 .docx）");
                                return;
                              }
                              if (draft.customSearchTypes.includes(ext)) {
                                setError("该类型已存在");
                                return;
                              }
                              const nextCustom = [...draft.customSearchTypes, ext];
                              const nextOrder = getSearchTypeOptions(nextCustom, [
                                ...(draft.searchTypeOrder || []),
                                `ext:${ext}`,
                              ]).map((x) => x.id);
                              setDraft({
                                ...draft,
                                customSearchTypes: nextCustom,
                                searchTypeOrder: nextOrder,
                              });
                              setNewTypeExt("");
                              setError("");
                            }}
                          >
                            添加
                          </button>
                        </div>
                      </div>
                      {error ? <div className="settings-error">{error}</div> : null}
                    </div>

                    <div className="settings-group">
                      <div className="settings-group-title">类型顺序</div>
                      <div className="type-order-list">
                        <div className="type-order-list-inner">
                          {typeOptions.map((opt) => (
                            <TypeOrderItem
                              key={opt.id}
                              id={opt.id}
                              label={opt.label}
                              isCustom={opt.id.startsWith("ext:")}
                              orderedIds={typeOptions.map((x) => x.id)}
                              onMove={(fromId, toId, position) => {
                                const nextOrder = moveTypeId(
                                  typeOptions.map((x) => x.id),
                                  fromId,
                                  toId,
                                  position
                                );
                                setDraft({ ...draft, searchTypeOrder: nextOrder });
                                setError("");
                              }}
                              onDelete={(targetId) => {
                                if (!targetId.startsWith("ext:")) return;
                                const ext = targetId.slice(4);
                                const nextCustom = (draft.customSearchTypes || []).filter(
                                  (x) => x !== ext,
                                );
                                const nextDefault =
                                  draft.defaultSearchTypeId === targetId
                                    ? "all"
                                    : draft.defaultSearchTypeId;
                                const nextOrder = getSearchTypeOptions(
                                  nextCustom,
                                  (draft.searchTypeOrder || []).filter((x) => x !== targetId),
                                ).map((x) => x.id);
                                setDraft({
                                  ...draft,
                                  customSearchTypes: nextCustom,
                                  defaultSearchTypeId: nextDefault,
                                  searchTypeOrder: nextOrder,
                                });
                                setError("");
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeKey === "account" ? (
                  <div className="settings-content">
                    <div className="settings-group">
                      <div className="settings-group-title">账号信息</div>
                      {user ? (
                        <div className="account-profile">
                          <div className="profile-header">
                            <div className="avatar-placeholder">
                              {user.avatarText || user.nickname?.slice(0, 1).toUpperCase()}
                            </div>
                            <div className="profile-info">
                              <div className="profile-name">{user.nickname || user.phone || user.email}</div>
                              <div className="profile-status-row">
                                <div className="profile-status">已登录</div>
                              </div>
                            </div>
                            <button
                              type="button"
                              className="profile-refresh-btn"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void doRefreshStatus();
                              }}
                              disabled={!getStoredTokenFromLocalStorage() || isRefreshingStatus}
                              aria-label="刷新状态"
                              title="刷新状态"
                            >
                              <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                aria-hidden="true"
                                className={isRefreshingStatus ? "spin-anim" : ""}
                              >
                                <path
                                  d="M20 12a8 8 0 1 1-2.34-5.66"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                />
                                <path
                                  d="M20 4v6h-6"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </button>
                          </div>
                          <div className="account-details">
                             <div className="account-detail-row">
                              <div className="account-detail-key">会员状态</div>
                              <div className="account-detail-val">
                                {isMember ? <> {isMember && (
                                  <div className="profile-vip-tag">已订阅</div>
                                )}</> : "非会员/已过期"}
                              </div>
                            </div>
                            {user.phone ? (
                              <div className="account-detail-row">
                                <div className="account-detail-key">手机号</div>
                                <div className="account-detail-val">{user.phone}</div>
                              </div>
                            ) : null}
                            {user.email ? (
                              <div className="account-detail-row">
                                <div className="account-detail-key">邮箱</div>
                                <div className="account-detail-val">{user.email}</div>
                              </div>
                            ) : null}
                            {formatDateTime(user.createdAt) ? (
                              <div className="account-detail-row">
                                <div className="account-detail-key">创建时间</div>
                                <div className="account-detail-val">
                                  {formatDateTime(user.createdAt)}
                                </div>
                              </div>
                            ) : null}
                            {user.memberExpiresAt ? (
                              <div className="account-detail-row">
                                <div className="account-detail-key">会员到期</div>
                                <div className="account-detail-val">
                                  {formatDateTime(user.memberExpiresAt)}
                                </div>
                              </div>
                            ) : null}
                            {draft.theme ? (
                              <div className="account-detail-row">
                                <div className="account-detail-key">主题模式</div>
                                <div className="account-detail-val">{draft.theme}</div>
                              </div>
                            ) : null}
                            {draft.accentColor ? (
                              <div className="account-detail-row">
                                <div className="account-detail-key">主题色</div>
                                <div className="account-detail-val">
                                  <span
                                    className="account-color-swatch"
                                    style={{ background: draft.accentColor }}
                                    aria-hidden="true"
                                  />
                                  <span className="account-color-text">{draft.accentColor}</span>
                                </div>
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="settings-cancel logout-btn"
                            onClick={handleLogout}
                            disabled={isLoggingOut}
                          >
                            {isLoggingOut ? (
                              <>
                                <span className="btn-spinner" aria-hidden="true" />
                                退出中...
                              </>
                            ) : (
                              "退出登录"
                            )}
                          </button>
                        </div>
                      ) : (
                        <form className="login-form" onSubmit={handleLogin}>
                          <div className="form-row">
                            <div className="form-label">账号</div>
                            <input
                              type="text"
                              className="text-input"
                              value={loginForm.account}
                              onChange={(e) =>
                                setLoginForm({ ...loginForm, account: e.target.value })
                              }
                              placeholder="请输入手机号/邮箱/昵称"
                            />
                          </div>
                          <div className="form-row">
                            <div className="form-label">密码</div>
                            <input
                              type="password"
                              className="text-input"
                              value={loginForm.password}
                              onChange={(e) =>
                                setLoginForm({ ...loginForm, password: e.target.value })
                              }
                              placeholder="请输入密码"
                            />
                          </div>
                          {loginError && <div className="settings-error">{loginError}</div>}
                          <div className="form-actions">
                            <button
                              type="submit"
                              className="settings-confirm login-btn"
                              disabled={isLoggingIn}
                            >
                              {isLoggingIn ? (
                                <>
                                  <span className="btn-spinner" aria-hidden="true" />
                                  登录中...
                                </>
                              ) : (
                                "登录"
                              )}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeKey === "shortcuts" ? (
                  <div className="settings-content">
                    <div className="settings-group">
                      <div className="settings-group-title">快捷键</div>
                      <div className="shortcut-grid">
                        <div className="shortcut-row">
                          <div className="shortcut-label">呼出搜索框</div>
                          <input
                            className="shortcut-input"
                            readOnly
                            value={draft.searchShortcut}
                            placeholder="点击设置快捷键"
                            onKeyDown={(e) => {
                              e.preventDefault();
                              const acc = toAccelerator(e);
                              if (acc) {
                                setDraft({ ...draft, searchShortcut: acc });
                                setError("");
                              }
                            }}
                          />
                        </div>
                        <div className="shortcut-row">
                          <div className="shortcut-label">打开设置</div>
                          <input
                            className="shortcut-input"
                            readOnly
                            value={draft.settingsShortcut}
                            placeholder="点击设置快捷键"
                            onKeyDown={(e) => {
                              e.preventDefault();
                              const acc = toAccelerator(e);
                              if (acc) {
                                setDraft({ ...draft, settingsShortcut: acc });
                                setError("");
                              }
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeKey === "appearance" ? (
                  <div className="settings-content">
                    <div className="settings-group">
                      <div className="settings-group-title">主题界面</div>
                      <div className="theme-grid">
                        <button
                          type="button"
                          className={`theme-card dark ${draft.theme === "dark" ? "active" : ""}`}
                          onClick={() => {
                            setDraft({ ...draft, theme: "dark" });
                            document.documentElement.dataset.theme = "dark";
                          }}
                        >
                          <div className="theme-preview" />
                          <span>深色模式</span>
                        </button>
                        <button
                          type="button"
                          className={`theme-card light ${draft.theme === "light" ? "active" : ""}`}
                          onClick={() => {
                            setDraft({ ...draft, theme: "light" });
                            document.documentElement.dataset.theme = "light";
                          }}
                        >
                          <div className="theme-preview" />
                          <span>浅色模式</span>
                        </button>
                      </div>
                    </div>

                    <div className="settings-group">
                      <div className="settings-group-title">主题色</div>
                      <div className="accent-color-grid">
                        {themeColors.map((item) => (
                          <button
                            key={item.color}
                            type="button"
                            className={`accent-color-item ${draft.accentColor === item.color ? "active" : ""}`}
                            style={{ "--item-color": item.color } as any}
                            disabled={!isMember}
                            onClick={() => {
                              setDraft({ ...draft, accentColor: item.color });
                              applyThemePreview(draft.theme, item.color);
                            }}
                            title={isMember ? item.name : membershipLockTip}
                          >
                            <div className="accent-color-dot" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="settings-footer">
            <button className="settings-cancel" type="button" onClick={onClose}>
              取消
            </button>
            <button className="settings-confirm" type="button" onClick={save}>
              确认
            </button>
          </div>
        </div>
        {toast ? (
          <div className={`settings-toast ${toast.kind}`} role="status" aria-live="polite">
            <span className="settings-toast-icon" aria-hidden="true">
              {toast.kind === "success" ? "✓" : toast.kind === "error" ? "✕" : "i"}
            </span>
            <span className="settings-toast-text">{toast.message}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TypeOrderItem({
  id,
  label,
  isCustom,
  orderedIds,
  onMove,
  onDelete,
}: {
  id: string;
  label: string;
  isCustom: boolean;
  orderedIds: string[];
  onMove: (fromId: string, toId: string, position: "before" | "after") => void;
  onDelete: (id: string) => void;
}) {
  const [dragOverPos, setDragOverPos] = useState<"top" | "bottom" | null>(null);

  return (
    <div
      className={`type-order-item ${dragOverPos ? `drag-over-${dragOverPos}` : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
        // 设置拖拽预览图透明度
        const target = e.currentTarget as HTMLElement;
        target.classList.add("dragging-source");
        setTimeout(() => target.classList.remove("dragging-source"), 0);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        setDragOverPos(e.clientY < midY ? "top" : "bottom");
      }}
      onDragLeave={() => {
        setDragOverPos(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOverPos(null);
        const fromId = e.dataTransfer.getData("text/plain");
        if (!fromId || fromId === id) return;
        if (!orderedIds.includes(fromId) || !orderedIds.includes(id)) return;
        
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isTop = e.clientY < midY;
        
        // 如果是往下拖且放到下半部，或者往上拖且放到上半部，才执行移动
        // 简化逻辑：直接根据 drop 的位置触发移动
        onMove(fromId, id, isTop ? "before" : "after");
      }}
    >
      <span className="type-order-handle" aria-hidden="true" />
      <span className="type-order-label">{label}</span>
      <span className="type-order-spacer" />
      {isCustom ? (
        <button
          type="button"
          className="type-order-del"
          aria-label="删除"
          title="删除"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(id);
          }}
        >
          ×
        </button>
      ) : (
        <span className="type-order-fixed">内置</span>
      )}
    </div>
  );
}

function App() {
  const isSettings = useMemo(
    () =>
      new URLSearchParams(window.location.search).get("view") === "settings",
    [],
  );
  return isSettings ? <SettingsView /> : <SearchView />;
}

export default App;
