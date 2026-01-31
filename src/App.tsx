import { useEffect, useMemo, useRef, useState } from "react";
import { List } from "react-window";
import "./App.css";

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
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStart: false,
  searchShortcut: "Alt+T",
  settingsShortcut: "Alt+Shift+T",
  theme: "dark",
  historyLimit: 5,
  defaultSearchTypeId: "all",
  customSearchTypes: [],
};

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

  return {
    autoStart: Boolean(s?.autoStart),
    searchShortcut,
    settingsShortcut,
    theme,
    historyLimit:
      typeof s?.historyLimit === "number" && Number.isFinite(s.historyLimit)
        ? Math.min(50, Math.max(0, Math.floor(s.historyLimit)))
        : 5,
    defaultSearchTypeId:
      typeof s?.defaultSearchTypeId === "string" && s.defaultSearchTypeId.trim()
        ? s.defaultSearchTypeId.trim()
        : "all",
    customSearchTypes: Array.isArray(s?.customSearchTypes)
      ? Array.from(
          new Set(
            s.customSearchTypes
              .map((x: any) => (typeof x === "string" ? x.trim() : ""))
              .map((x: string) => x.toLowerCase())
              .filter((x: string) => /^\.[a-z0-9]{1,10}$/i.test(x)),
          ),
        )
      : [],
  };
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
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let mounted = true;
    window.ipcRenderer?.invoke("get-settings").then((s: AppSettings) => {
      if (!mounted) return;
      setSettings(normalizeSettings(s));
    });

    const handler = (_event: any, next: AppSettings) => {
      setSettings(normalizeSettings(next));
    };
    window.ipcRenderer?.on("settings-updated", handler as any);

    return () => {
      mounted = false;
      window.ipcRenderer?.off("settings-updated", handler as any);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  return settings;
}

function SearchView() {
  const settings = useSettings();
  const [query, setQuery] = useState("");
  const [searchTypeId, setSearchTypeId] = useState<string>(
    settings.defaultSearchTypeId || "all",
  );
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [results, setResults] = useState<AppItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<any>(null);

  const ITEM_HEIGHT = 52;
  const MAX_LIST_HEIGHT = 420;
  const EMPTY_HEIGHT = 54;

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

  // 监听状态变化，自动调整窗口高度
  useEffect(() => {
    const containerPadding = 16;
    const searchBoxHeight = 52;
    const hasStatus = isSearching || isIndexing;
    const statusHeight = hasStatus ? 20 : 0;

    const showEmptyState =
      query.trim().length >= 1 &&
      !isSearching &&
      !isIndexing &&
      results.length === 0;

    let listContentHeight = 0;
    if (isSearching) {
      // 搜索时强制收起列表，仅显示状态
      listContentHeight = 0;
    } else if (results.length > 0) {
      listContentHeight =
        Math.min(results.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10;
    } else if (showEmptyState) {
      listContentHeight = EMPTY_HEIGHT + 10;
    }

    window.ipcRenderer?.invoke(
      "resize-window",
      containerPadding + searchBoxHeight + statusHeight + listContentHeight,
    );
  }, [
    results.length,
    isSearching,
    isIndexing,
    query,
    ITEM_HEIGHT,
    MAX_LIST_HEIGHT,
    EMPTY_HEIGHT,
  ]);

  const searchTypeOptions = useMemo(() => {
    const base = [
      { id: "all", label: "所有文件" },
      { id: "file", label: "文件" },
      // { id: "folder", label: "文件夹" },
    ];
    const custom = (settings.customSearchTypes || []).map((ext) => ({
      id: `ext:${ext}`,
      label: `${ext.replace(".", "").toUpperCase()} 文件`,
    }));
    return [...base, ...custom];
  }, [settings.customSearchTypes]);

  useEffect(() => {
    const valid = searchTypeOptions.some((t) => t.id === searchTypeId);
    if (!valid) setSearchTypeId(settings.defaultSearchTypeId || "all");
  }, [searchTypeId, searchTypeOptions, settings.defaultSearchTypeId]);

  useEffect(() => {
    if (!typeMenuOpen) return;
    const onDoc = () => setTypeMenuOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [typeMenuOpen]);

  const currentTypeLabel =
    searchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有文件";

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
      const nextTypeId = settings.defaultSearchTypeId || "all";
      setSearchTypeId(nextTypeId);
      setQuery("");
	  const resp = (await window.ipcRenderer?.invoke("get-history")) as
          | { results: AppItem[] }
          | undefined;
        const historyItems = resp?.results ?? [];
     setResults(filterItemsBySearchType(historyItems, nextTypeId));
      setIsSearching(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    };
    window.ipcRenderer?.on("reset-search", handleReset);
    return () => {
      window.ipcRenderer?.removeAllListeners("reset-search");
    };
  }, [settings.defaultSearchTypeId]);

  useEffect(() => {
    if (!query) {
      (async () => {
        const resp = (await window.ipcRenderer?.invoke("get-history")) as
          | { results: AppItem[] }
          | undefined;
        const historyItems = resp?.results ?? [];
        const filtered = filterItemsBySearchType(historyItems, searchTypeId);
        setResults(filtered);
        setSelectedIndex(0);
        setIsSearching(false);
        setIsIndexing(false);

        const containerPadding = 16;
        const searchBoxHeight = 52;
        const listHeight =
          filtered.length > 0
            ? Math.min(filtered.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10
            : 0;
        window.ipcRenderer?.invoke(
          "resize-window",
          containerPadding + searchBoxHeight + listHeight,
        );
      })();
      return;
    }

    const timer = setTimeout(async () => {
      if (query.length < 1) {
        const resp = (await window.ipcRenderer?.invoke("get-history")) as
          | { results: AppItem[] }
          | undefined;
        const historyItems = resp?.results ?? [];
        const filtered = filterItemsBySearchType(historyItems, searchTypeId);
        setResults(filtered);
        setSelectedIndex(0);
        setIsSearching(false);
        setIsIndexing(false);

        const containerPadding = 16;
        const searchBoxHeight = 52;
        const listHeight =
          filtered.length > 0
            ? Math.min(filtered.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10
            : 0;
        window.ipcRenderer?.invoke(
          "resize-window",
          containerPadding + searchBoxHeight + listHeight,
        );
        return;
      }

      setIsSearching(true);
      window.ipcRenderer?.invoke("resize-window", 88);
      try {
        const resp = (await window.ipcRenderer?.invoke(
          "search-files",
          query,
          { searchTypeId },
        )) as SearchResponse | undefined;
        const nextResults = resp?.results ?? [];
        setResults(nextResults);
        setSelectedIndex(0);
        setIsIndexing(Boolean(resp?.isIndexing));

        const containerPadding = 16;
        const searchBoxHeight = 52;
        const statusHeight = resp?.isIndexing ? 20 : 0;
        const listHeight = nextResults.length > 0
          ? Math.min(nextResults.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10
          : resp?.isIndexing ? 0 : EMPTY_HEIGHT;

        window.ipcRenderer?.invoke(
          "resize-window",
          containerPadding + searchBoxHeight + statusHeight + listHeight,
        );
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query, searchTypeId]);

  useEffect(() => {
    if (listRef.current)
      listRef.current.scrollToRow({ index: selectedIndex, align: "auto" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      window.ipcRenderer?.invoke("hide-window");
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const idx = Math.max(
        0,
        searchTypeOptions.findIndex((t) => t.id === searchTypeId),
      );
      const next = searchTypeOptions[(idx + 1) % searchTypeOptions.length];
      if (next) setSearchTypeId(next.id);
      setTypeMenuOpen(false);
      return;
    }

    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      setSelectedIndex((prev) => (prev + 1) % results.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
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
    setQuery("");
    setResults([]);
    setIsSearching(false);
  };

  const openFolder = (app: AppItem) => {
    window.ipcRenderer?.invoke("open-folder", app.path);
  };

  const openSettings = () => {
    window.ipcRenderer?.invoke("open-settings-window");
  };

  const isHistoryMode = query.trim().length === 0;

  const refreshHistory = async () => {
    const resp = (await window.ipcRenderer?.invoke("get-history")) as
      | { results: AppItem[] }
      | undefined;
    const historyItems = resp?.results ?? [];
    setResults(filterItemsBySearchType(historyItems, searchTypeId));
    setSelectedIndex(0);
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

  const Row = ({
    index,
    style,
  }: {
    index: number;
    style: React.CSSProperties;
  }) => {
    const item = results[index];
    if (!item) return null;

    return (
      <div
        style={style}
        className={`result-item-wrapper ${index === selectedIndex ? "selected" : ""}`}
        onClick={() => launchApp(item)}
      >
        <li className={index === selectedIndex ? "selected" : ""}>
          {item.icon ? (
            <img className="result-icon" src={item.icon} alt="" />
          ) : (
            <span className="result-icon placeholder" />
          )}
          <div className="result-meta">
            <span className="app-name">{item.name}</span>
            <span className="app-path" title={item.path}>
              {item.path}
            </span>
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
                  d="M9 9h10v10H9V9Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path
                  d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
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

  const listHeight = Math.min(results.length * ITEM_HEIGHT, MAX_LIST_HEIGHT);
  const showEmptyState =
    query.trim().length >= 1 &&
    !isSearching &&
    !isIndexing &&
    results.length === 0;

  return (
    <div className="container">
      <div className="search-box">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoFocus
        />
        <div className="type-select" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="type-select-btn"
            type="button"
            onClick={() => setTypeMenuOpen((v) => !v)}
            aria-label="切换搜索类型"
            title="切换搜索类型"
          >
            <span className="type-select-label">{currentTypeLabel}</span>
            <span className="type-select-caret">▾</span>
          </button>
          {typeMenuOpen ? (
            <div className="type-select-menu" role="menu">
              {searchTypeOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`type-select-item ${opt.id === searchTypeId ? "active" : ""}`}
                  onClick={() => {
                    setSearchTypeId(opt.id);
                    setTypeMenuOpen(false);
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ) : null}
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

      {(results.length > 0 || showEmptyState) && (
        <div className="results">
          {showEmptyState ? (
            <div className="empty-state">暂无无结果...😭</div>
          ) : (
            <List<any>
              listRef={listRef}
              style={{ height: listHeight, width: "100%" }}
              rowCount={results.length}
              rowHeight={ITEM_HEIGHT}
              className="virtual-list"
              rowComponent={Row}
              rowProps={{}}
            />
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
    "general" | "search" | "shortcuts" | "appearance"
  >("general");
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
  ]);

  useEffect(() => {
    const handler = () => {
      setDraft(settings);
      setError("");
      setActiveKey("general");
      setNewTypeExt("");
      document.documentElement.dataset.theme = settings.theme;
    };
    window.ipcRenderer?.on("settings-window-opened", handler as any);
    return () => {
      window.ipcRenderer?.off("settings-window-opened", handler as any);
    };
  }, [settings]);

  const applyThemePreview = (theme: AppSettings["theme"]) => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.add("theme-anim");
    window.setTimeout(() => {
      document.documentElement.classList.remove("theme-anim");
    }, 240);
  };

  const onClose = () => {
    setError("");
    setDraft(settings);
    document.documentElement.dataset.theme = settings.theme;
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
    const resp = (await window.ipcRenderer?.invoke("save-settings", draft)) as
      | { ok: boolean; message?: string }
      | undefined;
    if (resp?.ok === false) {
      setError(resp.message || "设置保存失败");
      return;
    }
    window.ipcRenderer?.invoke("hide-window");
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
      { key: "general" as const, label: "通用" },
      { key: "search" as const, label: "搜索" },
      { key: "shortcuts" as const, label: "快捷键" },
      { key: "appearance" as const, label: "外观" },
    ],
    [],
  );

  return (
    <div className="container" onKeyDown={handleKeyDown}>
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
          <span className="settings-title">设置</span>
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
              {navItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`settings-nav-item ${activeKey === item.key ? "active" : ""}`}
                  onClick={() => setActiveKey(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="settings-main">
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
                    <div className="settings-group-title">历史记录</div>
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
                        onChange={(e) => {
                          setDraft({ ...draft, defaultSearchTypeId: e.target.value });
                          setError("");
                        }}
                      >
                        <option value="all">所有文件</option>
                        <option value="file">文件</option>
                        {/* <option value="folder">文件夹</option> */}
                        {draft.customSearchTypes.map((ext) => (
                          <option key={ext} value={`ext:${ext}`}>
                            {`${ext.replace(".", "").toUpperCase()} 文件`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="settings-group">
                    <div className="settings-group-title">自定义类型</div>
                    <div className="form-row">
                      <div className="form-label">新增后缀</div>
                      <input
                        className="text-input"
                        value={newTypeExt}
                        placeholder=".docx"
                        onChange={(e) => {
                          setNewTypeExt(e.target.value);
                          setError("");
                        }}
                      />
                      <button
                        type="button"
                        className="small-btn"
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
                          setDraft({
                            ...draft,
                            customSearchTypes: [...draft.customSearchTypes, ext],
                          });
                          setNewTypeExt("");
                          setError("");
                        }}
                      >
                        添加
                      </button>
                    </div>

                    {draft.customSearchTypes.length > 0 ? (
                      <div className="type-list">
                        {draft.customSearchTypes.map((ext) => (
                          <div key={ext} className="type-pill">
                            <span className="type-pill-label">{`${ext.replace(".", "").toUpperCase()} 文件`}</span>
                            <button
                              type="button"
                              className="type-pill-del"
                              aria-label="删除"
                              title="删除"
                              onClick={() => {
                                const nextList = draft.customSearchTypes.filter((x) => x !== ext);
                                const nextDefault =
                                  draft.defaultSearchTypeId === `ext:${ext}` ? "all" : draft.defaultSearchTypeId;
                                setDraft({
                                  ...draft,
                                  customSearchTypes: nextList,
                                  defaultSearchTypeId: nextDefault,
                                });
                                setError("");
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {error ? <div className="settings-error">{error}</div> : null}
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
                          placeholder="按下组合键…"
                          onKeyDown={(e) => setShortcut("searchShortcut", e)}
                        />
                      </div>
                      <div className="shortcut-row">
                        <div className="shortcut-label">呼出设置界面</div>
                        <input
                          className="shortcut-input"
                          readOnly
                          value={draft.settingsShortcut}
                          placeholder="按下组合键…"
                          onKeyDown={(e) => setShortcut("settingsShortcut", e)}
                        />
                      </div>
                    </div>
                  </div>
                  {error ? <div className="settings-error">{error}</div> : null}
                </div>
              ) : null}

              {activeKey === "appearance" ? (
                <div className="settings-content">
                  <div className="settings-group">
                    <div className="settings-group-title">外观</div>
                    <div
                      className="theme-segment"
                      role="radiogroup"
                      aria-label="主题"
                    >
                      <button
                        type="button"
                        className={`theme-option ${draft.theme === "light" ? "active" : ""}`}
                        onClick={() => {
                          setDraft({ ...draft, theme: "light" });
                          applyThemePreview("light");
                        }}
                      >
                        明亮
                      </button>
                      <button
                        type="button"
                        className={`theme-option ${draft.theme === "dark" ? "active" : ""}`}
                        onClick={() => {
                          setDraft({ ...draft, theme: "dark" });
                          applyThemePreview("dark");
                        }}
                      >
                        暗黑
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
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
      </div>
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
