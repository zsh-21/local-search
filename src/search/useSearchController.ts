import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);

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
  // 搜索会话 ID：用于关联主进程分批推送的 more-results，避免切换类型/重复搜索导致重复项与数量不一致
  const searchSessionIdRef = useRef("");
  const pendingAppendRef = useRef<AppItem[]>([]);
  const flushAppendTimerRef = useRef<number | null>(null);

  const ITEM_HEIGHT = 52;
  const MAX_LIST_HEIGHT = 382;
  const TYPE_MENU_MIN_LIST_SPACE = 240;
  const DISPLAY_LIMIT = 500;

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

  useEffect(() => {
    // 结果集变化时保护 selectedIndex：避免指向越界导致列表滚动/渲染异常
    if (results.length === 0) return;
    if (selectedIndex < 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex > results.length - 1) {
      setSelectedIndex(results.length - 1);
    }
  }, [results.length, selectedIndex]);
  // 根据当前选择的搜索类型对结果做二次过滤（历史/增量结果都会走这里）
  const filterItemsBySearchType = (items: AppItem[], typeId: string) => {
    const id = typeof typeId === "string" && typeId.trim() ? typeId.trim() : "all";
    if (id === "all") return items;
    if (id === "file") {
      // “文件”类型只展示普通文件 + 应用：图片/视频/自定义扩展的文件统一归属到各自类型，避免串结果
      const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
      const videoExts = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
      const customExts = new Set(
        (settings.customSearchTypes || [])
          .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
          .filter(Boolean),
      );
      return items.filter((x) => {
        if (x.type === "app") return true;
        if (x.type !== "file") return false;
        const p = (x.path || "").toLowerCase();
        const dot = p.lastIndexOf(".");
        const ext = dot >= 0 ? p.slice(dot) : "";
        if (!ext) return true;
        if (imageExts.has(ext)) return false;
        if (videoExts.has(ext)) return false;
        if (customExts.has(ext)) return false;
        return true;
      });
    }
    if (id === "folder") return items.filter((x) => x.type === "folder");
    // “设置”结果只出现在“设置/所有类型”中：这里用于过滤历史与后台增量结果
    if (id === "settings") return items.filter((x) => x.type === "settings");
    if (id === "image" || id === "video") {
      // 图片/视频类型：只从文件结果里按扩展名筛选
      const exts =
        id === "image"
          ? new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"])
          : new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
      return items.filter((x) => {
        if (x.type !== "file") return false;
        const p = (x.path || "").toLowerCase();
        const dot = p.lastIndexOf(".");
        const ext = dot >= 0 ? p.slice(dot) : "";
        return exts.has(ext);
      });
    }
    if (id.startsWith("ext:")) {
      const ext = id.slice(4).toLowerCase();
      if (!ext) return items;
      return items.filter(
        (x) => x.type === "file" && (x.path || "").toLowerCase().endsWith(ext),
      );
    }
    return items;
  };

  const normalizeResultKey = (x: AppItem) => {
    const t = typeof x?.type === "string" ? x.type : "";
    const p = typeof x?.path === "string" ? x.path.trim().toLowerCase() : "";
    return `${t}|${p}`;
  };

  const dedupeResults = (items: AppItem[]) => {
    // 去重：保证切换类型/后台增量合并时不会出现重复项，且列表数量稳定可预期
    const seen = new Set<string>();
    const out: AppItem[] = [];
    for (const it of items) {
      const key = normalizeResultKey(it);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  };

  const limitResults = (items: AppItem[]) => items.slice(0, DISPLAY_LIMIT);

  const mergeResultsStable = (prev: AppItem[], next: AppItem[]) => {
    const nextByKey = new Map<string, AppItem>();
    for (const it of next) {
      const k = normalizeResultKey(it);
      if (!k) continue;
      nextByKey.set(k, it);
    }

    const seen = new Set<string>();
    const merged: AppItem[] = [];
    for (const it of prev) {
      const k = normalizeResultKey(it);
      if (!k || seen.has(k)) continue;
      const newer = nextByKey.get(k);
      if (newer) {
        merged.push({
          ...it,
          ...newer,
          icon: typeof newer.icon === "string" && newer.icon ? newer.icon : it.icon,
        });
      } else {
        merged.push(it);
      }
      seen.add(k);
    }

    for (const it of next) {
      const k = normalizeResultKey(it);
      if (!k || seen.has(k)) continue;
      merged.push(it);
      seen.add(k);
    }

    return merged;
  };

  const mergeByServerOrder = (prev: AppItem[], serverOrdered: AppItem[]) => {
    const prevByKey = new Map<string, AppItem>();
    for (const it of prev) {
      const k = normalizeResultKey(it);
      if (!k) continue;
      prevByKey.set(k, it);
    }

    const seen = new Set<string>();
    const out: AppItem[] = [];

    for (const it of serverOrdered) {
      const k = normalizeResultKey(it);
      if (!k || seen.has(k)) continue;
      const p = prevByKey.get(k);
      if (p) {
        out.push({
          ...it,
          icon: typeof it.icon === "string" && it.icon ? it.icon : p.icon,
        });
      } else {
        out.push(it);
      }
      seen.add(k);
      if (out.length >= DISPLAY_LIMIT) return out;
    }

    for (const it of prev) {
      const k = normalizeResultKey(it);
      if (!k || seen.has(k)) continue;
      out.push(it);
      seen.add(k);
      if (out.length >= DISPLAY_LIMIT) break;
    }

    return out;
  };

  const flushPendingAppends = () => {
    if (flushAppendTimerRef.current != null) {
      window.clearTimeout(flushAppendTimerRef.current);
      flushAppendTimerRef.current = null;
    }
    const batch = pendingAppendRef.current;
    if (!batch || batch.length === 0) return;
    pendingAppendRef.current = [];
    startTransition(() => {
      setResults((prev) => {
        const next = limitResults(dedupeResults([...prev, ...batch]));
        setTotalCount((c) => Math.max(c, next.length));
        return next;
      });
    });
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

  const enabledSearchTypeOptions = useMemo(() => {
    // 搜索类型开关：设置面板可关闭某些类型（“所有类型”永远保留）
    const disabled = Array.isArray(settings.disabledSearchTypeIds) ? settings.disabledSearchTypeIds : [];
    return searchTypeOptions.filter((t) => t.id === "all" || !disabled.includes(t.id));
  }, [searchTypeOptions, settings.disabledSearchTypeIds]);

  useEffect(() => {
    const valid = enabledSearchTypeOptions.some((t) => t.id === searchTypeId);
    if (!valid) setSearchTypeId(settings.defaultSearchTypeId || "all");
  }, [searchTypeId, enabledSearchTypeOptions, settings.defaultSearchTypeId]);

  const placeholder = useMemo(() => {
    if (searchTypeId === "all") return "搜索所有文件与文件夹...";
    if (searchTypeId === "file") return "搜索文件（不含文件夹）...";
    if (searchTypeId === "folder") return "搜索文件夹（不含文件）...";
    if (searchTypeId === "image") return "搜索图片...";
    if (searchTypeId === "video") return "搜索视频...";
    if (searchTypeId === "settings") return "搜索系统设置项...";
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
    const deduped = limitResults(dedupeResults(filtered));
    setResults(deduped);
    setTotalCount(deduped.length);
    const preservePath = typeof opts?.preserveSelectedPath === "string" ? opts.preserveSelectedPath : "";
    if (preservePath) {
      const idx = deduped.findIndex((x) => x.path === preservePath);
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
        setResults(limitResults(dedupeResults(filterItemsBySearchType(historyItems, nextTypeId))));
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
      const currentQuery = queryRef.current.trim();
      const currentTypeId = searchTypeIdRef.current;
      const currentSessionId = searchSessionIdRef.current;
      const payloadQuery = typeof payload?.query === "string" ? payload.query : "";
      const payloadTypeId = typeof (payload as any)?.searchTypeId === "string" ? (payload as any).searchTypeId : "";
      const payloadSessionId =
        typeof (payload as any)?.searchSessionId === "string" ? (payload as any).searchSessionId : "";
      if (!currentQuery) return;
      if (!currentSessionId) return;
      if (payloadQuery !== currentQuery) return;
      if (payloadTypeId !== currentTypeId) return;
      if (payloadSessionId !== currentSessionId) return;

      const filteredMore = filterItemsBySearchType(payload.results, currentTypeId);
      if (filteredMore.length <= 0) return;
      pendingAppendRef.current = [...pendingAppendRef.current, ...filteredMore];
      if (flushAppendTimerRef.current == null) {
        flushAppendTimerRef.current = window.setTimeout(() => flushPendingAppends(), 50);
      }
    };
    window.ipcRenderer?.on("more-results", handler);
    return () => {
      flushPendingAppends();
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
        setTotalCount(0);
        setIsSearching(false);
        setHasMore(false);
      }
      return;
    }

    searchRequestIdRef.current += 1;
    const requestId = searchRequestIdRef.current;
    const searchSessionId = `${Date.now()}-${requestId}`;
    searchSessionIdRef.current = searchSessionId;
    setIsSearching(true);
    setHasMore(false);
    setTotalCount(0);
    pendingAppendRef.current = [];
    if (flushAppendTimerRef.current != null) {
      window.clearTimeout(flushAppendTimerRef.current);
      flushAppendTimerRef.current = null;
    }
    // 防抖：避免连续输入触发过多 IPC 搜索请求
    const timer = setTimeout(async () => {
      try {
        const resp = (await window.ipcRenderer?.invoke(
          "search-files",
          trimmed,
          { searchTypeId, searchSessionId },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;
        // 竞态保护：只接受“最新请求 + 当前 query/type”对应的结果
        if (searchRequestIdRef.current !== requestId) return;
        if (queryRef.current.trim() !== trimmed) return;
        if (searchTypeIdRef.current !== searchTypeId) return;
        const nextResults = filterItemsBySearchType(resp?.results ?? [], searchTypeId);
        setSelectedIndex(0);
        startTransition(() => {
          const limited = limitResults(dedupeResults(nextResults));
          setResults(limited);
          setTotalCount(typeof resp?.totalCount === "number" ? resp.totalCount : limited.length);
          setIsIndexing(Boolean(resp?.isIndexing));
          setHasMore(Boolean(resp?.hasMore));
        });
      } finally {
        if (searchRequestIdRef.current === requestId) setIsSearching(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [query, searchTypeId]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) return;
    if (!isIndexing) return;
    if (isSearching) return;

    let cancelled = false;
    const refreshOnce = async () => {
      if (cancelled) return;
      if (!window.ipcRenderer) return;
      if (!isIndexing) return;
      if (isSearching) return;

      const currentQuery = queryRef.current.trim();
      if (currentQuery !== trimmed) return;

      const currentTypeId = searchTypeIdRef.current;
      const currentSessionId = searchSessionIdRef.current;
      if (!currentSessionId) return;
      try {
        const resp = (await window.ipcRenderer.invoke(
          "search-files",
          trimmed,
          { searchTypeId: currentTypeId, searchSessionId: currentSessionId },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;

        if (cancelled) return;
        if (queryRef.current.trim() !== trimmed) return;
        if (searchTypeIdRef.current !== currentTypeId) return;

        const nextResults = filterItemsBySearchType(resp?.results ?? [], currentTypeId);
        const respTotal = typeof resp?.totalCount === "number" ? resp.totalCount : 0;
        const serverOrdered = limitResults(dedupeResults(nextResults));
        startTransition(() => {
          setResults((prev) => {
            const merged = mergeByServerOrder(prev, serverOrdered);
            setTotalCount((c) => Math.max(c, respTotal, merged.length));
            return merged;
          });
          setIsIndexing(Boolean(resp?.isIndexing));
          setHasMore((v) => v || Boolean(resp?.hasMore));
        });
      } catch {}
    };

    const intervalId = window.setInterval(() => {
      void refreshOnce();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [query, isIndexing, isSearching]);

  useEffect(() => {
    if (listRef.current && lastSelectedBy === "keyboard") {
      if (typeof listRef.current.scrollToItem === "function") {
        const align =
          results.length > 0 && selectedIndex >= results.length - 1
            ? "end"
            : selectedIndex <= 0
              ? "start"
              : "smart";
        listRef.current.scrollToItem(selectedIndex, align);
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
    if (app.type === "settings") {
      window.ipcRenderer?.invoke("open-item", {
        name: app.name,
        path: app.path,
        type: app.type || "file",
      });
      return;
    }
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

  // 列表使用虚拟滚动（react-window v2），这里直接使用全量 results，避免“选中索引超出可见切片”导致空白渲染
  const visibleResults = results;
  const currentTypeLabel = useMemo(() => {
    return enabledSearchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有类型";
  }, [searchTypeId, enabledSearchTypeOptions]);

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
    return;
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
    isSearching,
    isIndexing,
    hasMore,
    totalCount,
    placeholder,
    searchTypeOptions: enabledSearchTypeOptions,
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
