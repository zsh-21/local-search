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
}

const DEFAULT_SETTINGS: AppSettings = {
  autoStart: false,
  searchShortcut: "Alt+T",
  settingsShortcut: "Alt+Shift+T",
  theme: "dark",
  historyLimit: 5,
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
  useSettings();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [results, setResults] = useState<AppItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<any>(null);

  const ITEM_HEIGHT = 52;
  const MAX_LIST_HEIGHT = 420;

  useEffect(() => {
    inputRef.current?.focus();
    const handleReset = async() => {
      setQuery("");
	  const resp = (await window.ipcRenderer?.invoke("get-history")) as
          | { results: AppItem[] }
          | undefined;
        const historyItems = resp?.results ?? [];
     setResults(historyItems);
      setIsSearching(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    };
    window.ipcRenderer?.on("reset-search", handleReset);
    return () => {
      window.ipcRenderer?.removeAllListeners("reset-search");
    };
  }, []);

  useEffect(() => {
    if (!query) {
      (async () => {
        const resp = (await window.ipcRenderer?.invoke("get-history")) as
          | { results: AppItem[] }
          | undefined;
        const historyItems = resp?.results ?? [];
        setResults(historyItems);
        setSelectedIndex(0);
        setIsSearching(false);
        setIsIndexing(false);

        const containerPadding = 16;
        const searchBoxHeight = 52;
        const listHeight =
          historyItems.length > 0
            ? Math.min(historyItems.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10
            : 0;
        window.ipcRenderer?.invoke(
          "resize-window",
          containerPadding + searchBoxHeight + listHeight,
        );
      })();
      return;
    }

    const timer = setTimeout(async () => {
      if (query.length < 2) {
        const resp = (await window.ipcRenderer?.invoke("get-history")) as
          | { results: AppItem[] }
          | undefined;
        const historyItems = resp?.results ?? [];
        setResults(historyItems);
        setSelectedIndex(0);
        setIsSearching(false);
        setIsIndexing(false);

        const containerPadding = 16;
        const searchBoxHeight = 52;
        const listHeight =
          historyItems.length > 0
            ? Math.min(historyItems.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10
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
        )) as SearchResponse | undefined;
        const nextResults = resp?.results ?? [];
        setResults(nextResults);
        setSelectedIndex(0);
        setIsIndexing(Boolean(resp?.isIndexing));

        const containerPadding = 16;
        const searchBoxHeight = 52;
        const statusHeight = resp?.isIndexing ? 20 : 0;
        const listHeight =
          nextResults.length > 0
            ? Math.min(nextResults.length * ITEM_HEIGHT, MAX_LIST_HEIGHT) + 10
            : 0;

        window.ipcRenderer?.invoke(
          "resize-window",
          containerPadding + searchBoxHeight + statusHeight + listHeight,
        );
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (listRef.current)
      listRef.current.scrollToRow({ index: selectedIndex, align: "auto" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      window.ipcRenderer?.invoke("hide-window");
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
          </div>
        </li>
      </div>
    );
  };

  const listHeight = Math.min(results.length * ITEM_HEIGHT, MAX_LIST_HEIGHT);

  return (
    <div className="container">
      <div className="search-box">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入文件名/路径（支持部分搜索）"
          autoFocus
        />
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

      {results.length > 0 && (
        <div className="results">
          <List<any>
            listRef={listRef}
            style={{ height: listHeight, width: "100%" }}
            rowCount={results.length}
            rowHeight={ITEM_HEIGHT}
            className="virtual-list"
            rowComponent={Row}
            rowProps={{}}
          />
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
    "general" | "shortcuts" | "appearance"
  >("general");

  useEffect(() => {
    setDraft(settings);
  }, [
    settings.autoStart,
    settings.searchShortcut,
    settings.settingsShortcut,
    settings.theme,
  ]);

  useEffect(() => {
    const handler = () => {
      setDraft(settings);
      setError("");
      setActiveKey("general");
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
      { key: "shortcuts" as const, label: "快捷键" },
      { key: "appearance" as const, label: "外观" },
    ],
    [],
  );

  return (
    <div className="container" onKeyDown={handleKeyDown}>
       <div className="settings-header" onDoubleClick={onToggleMax}>
        <span className="settings-title">设置</span>
        <div className="settings-window-controls">
              <button
                type="button"
                className="window-btn"
                onClick={onToggleMax}
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
                        min={5}
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
                    {error ? (
                      <div className="settings-error">{error}</div>
                    ) : null}
                  </div>
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
