import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppItem, AppSettings, SearchResponse } from "../appTypes";
import { refreshUserStatusSilently } from "../membership";
import { getSearchTypeOptions, normalizeSettings, useSettings } from "../settingsStore";
import { useWindowResizeHandles } from "./useWindowResizeHandles";

type RefreshHistoryOpts = { typeId?: string; preserveSelectedPath?: string };

export function useSearchController() {
  // 统一读取设置：搜索页会用到默认类型、类型顺序、主题与背景相关配置
  const { settings } = useSettings();

  // 搜索输入与类型选择：驱动查询与结果过滤
  const [query, setQuery] = useState("");
  const [searchTypeId, setSearchTypeId] = useState<string>(settings.defaultSearchTypeId || "all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lastSelectedBy, setLastSelectedBy] = useState<"keyboard" | "mouse">("keyboard");
  const [results, setResults] = useState<AppItem[]>([]);
  const [visibleCount, setVisibleCount] = useState(50);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // 关键元素引用：输入框聚焦、列表滚动、下拉菜单点击外部关闭等
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<any>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const typeSelectRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 窗口高度自适应：减少频繁 resize 的抖动与重复调用
  const lastResizeHeightRef = useRef(0);
  const resizeRafRef = useRef<number | null>(null);
  // 竞态保护：异步搜索返回时对齐“当前 query/type”，避免旧请求覆盖新结果
  const queryRef = useRef("");
  const searchTypeIdRef = useRef(searchTypeId);
  const selectedPathRef = useRef("");
  const searchRequestIdRef = useRef(0);

  const ITEM_HEIGHT = 52;
  const MAX_LIST_HEIGHT = 382;
  const TYPE_MENU_MIN_LIST_SPACE = 240;

  useEffect(() => {
    void refreshUserStatusSilently();
  }, []);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    searchTypeIdRef.current = searchTypeId;
  }, [searchTypeId]);

  useEffect(() => {
    selectedPathRef.current = results[selectedIndex]?.path || "";
  }, [results, selectedIndex]);

  // 根据当前选择的搜索类型对结果做二次过滤（历史/增量结果都会走这里）
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

  useEffect(() => {
    // 点击下拉选择器之外时关闭菜单，避免菜单悬浮影响键盘操作
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

  const { startResizing } = useWindowResizeHandles();

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

  // 刷新历史记录：用于“空输入”模式下展示最近打开项
  const refreshHistory = async (opts?: RefreshHistoryOpts) => {
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

  useEffect(() => {
    inputRef.current?.focus();
    // 主进程通知“需要重置搜索页”时触发：按用户设置决定是否保留上次状态
    const handleReset = async () => {
      void refreshUserStatusSilently();
      window.ipcRenderer?.invoke("get-settings").then(async (latestSettings: AppSettings) => {
        const s = normalizeSettings(latestSettings);
        if (s.keepStateOnClose) {
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
    const handler = (_event: any, payload: { query: string; results: AppItem[] }) => {
      if (payload.query === query) {
        const filteredMore = filterItemsBySearchType(payload.results, searchTypeId);
        if (filteredMore.length > 0) {
          setResults((prev) => [...prev, ...filteredMore]);
        }
      }
    };
    window.ipcRenderer?.on("more-results", handler);
    return () => {
      window.ipcRenderer?.off("more-results", handler);
    };
  }, [query, searchTypeId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) {
      // 少于 2 个字符时不触发搜索：空输入显示历史，其余清空结果并收起状态
      searchRequestIdRef.current += 1;
      if (trimmed.length === 0) {
        refreshHistory();
      } else {
        setResults([]);
        setVisibleCount(50);
        setIsSearching(false);
        setHasMore(false);
      }
      return;
    }

    searchRequestIdRef.current += 1;
    const requestId = searchRequestIdRef.current;
    setIsSearching(true);
    setHasMore(false);
    // 防抖：避免连续输入触发过多 IPC 搜索请求
    const timer = setTimeout(async () => {
      try {
        const resp = (await window.ipcRenderer?.invoke(
          "search-files",
          trimmed,
          { searchTypeId },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;
        // 竞态保护：只接受“最新请求 + 当前 query/type”对应的结果
        if (searchRequestIdRef.current !== requestId) return;
        if (queryRef.current.trim() !== trimmed) return;
        if (searchTypeIdRef.current !== searchTypeId) return;
        const nextResults = resp?.results ?? [];
        setResults(nextResults);
        setVisibleCount(50);
        setSelectedIndex(0);
        setIsIndexing(Boolean(resp?.isIndexing));
        setHasMore(Boolean(resp?.hasMore));
      } finally {
        if (searchRequestIdRef.current === requestId) setIsSearching(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [query, searchTypeId]);

  useEffect(() => {
    if (listRef.current && lastSelectedBy === "keyboard") {
      if (typeof listRef.current.scrollToItem === "function") {
        listRef.current.scrollToItem(selectedIndex, "smart");
      } else if (typeof listRef.current.scrollToRow === "function") {
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

  const openSettings = () => {
    window.ipcRenderer?.invoke("open-settings-window");
  };

  const openFolder = (app: AppItem) => {
    window.ipcRenderer?.invoke("open-folder", app.path);
  };

  const launchApp = (app: AppItem) => {
    window.ipcRenderer?.invoke("open-item", {
      name: app.name,
      path: app.path,
      type: app.type || "file",
    });
  };

  const handleKeyDownCapture = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "k")) {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      return;
    }

    if (e.key === "Escape") {
      setTypeMenuOpen(false);
      window.ipcRenderer?.invoke("hide-window");
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const idx = Math.max(
        0,
        searchTypeOptions.findIndex((t) => t.id === searchTypeId),
      );
      const delta = e.shiftKey ? -1 : 1;
      const nextIdx = (idx + delta + searchTypeOptions.length) % searchTypeOptions.length;
      const next = searchTypeOptions[nextIdx];
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
    } else if (e.key === "Home") {
      setLastSelectedBy("keyboard");
      setSelectedIndex(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setLastSelectedBy("keyboard");
      setSelectedIndex(results.length - 1);
      e.preventDefault();
    } else if (e.key === "PageDown") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => Math.min(results.length - 1, prev + 10));
      e.preventDefault();
    } else if (e.key === "PageUp") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => Math.max(0, prev - 10));
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey) openFolder(results[selectedIndex]);
      else launchApp(results[selectedIndex]);
    }
  };

  const visibleResults = useMemo(() => results.slice(0, visibleCount), [results, visibleCount]);
  const currentTypeLabel = useMemo(() => {
    return searchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有文件";
  }, [searchTypeId, searchTypeOptions]);

  const listHeight = Math.min(visibleResults.length * ITEM_HEIGHT, MAX_LIST_HEIGHT);
  const trimmedQuery = query.trim();
  const showEmptyState =
    trimmedQuery.length >= 2 &&
    !isSearching &&
    !isIndexing &&
    results.length === 0;
  const showInputHint =
    trimmedQuery.length > 0 &&
    trimmedQuery.length < 2 &&
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
    if (scrollContainerRef.current && listRef.current) {
      listRef.current.scrollToRow({ index: 0, align: "auto", behavior: "smooth" });
      setSelectedIndex(0);
    }
  };

  const onItemsRendered = (visibleRows: { startIndex: number; stopIndex: number }) => {
    if (visibleRows.stopIndex >= visibleResults.length - 1 && visibleResults.length < results.length) {
      setVisibleCount((prev) => prev + 50);
    }
  };

  const statusText = isSearching
    ? "正在搜索…"
    : isIndexing
      ? "正在建立本地文件索引…"
      : "";

  return {
    settings,
    query,
    setQuery,
    searchTypeId,
    setSearchTypeId,
    typeMenuOpen,
    setTypeMenuOpen,
    selectedIndex,
    setSelectedIndex,
    lastSelectedBy,
    setLastSelectedBy,
    results,
    visibleCount,
    setVisibleCount,
    isSearching,
    isIndexing,
    hasMore,
    placeholder,
    searchTypeOptions,
    currentTypeLabel,
    visibleResults,
    listHeight,
    showEmptyState,
    showInputHint,
    statusText,
    ITEM_HEIGHT,
    MAX_LIST_HEIGHT,
    inputRef,
    listRef,
    scrollContainerRef,
    typeSelectRef,
    typeMenuRef,
    containerRef,
    handleKeyDownCapture,
    startResizing,
    openSettings,
    openFolder,
    launchApp,
    refreshHistory,
    deleteHistoryItem,
    scrollToTop,
    onItemsRendered,
    trimmedQuery,
  };
}
