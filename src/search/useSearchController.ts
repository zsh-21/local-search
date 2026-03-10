import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppItem, AppSettings, SearchResponse } from "../appTypes";
import { refreshUserStatusSilently } from "../membership";
import { getSearchTypeOptions, normalizeSettings, useSettings } from "../settingsStore";
import { useWindowResizeHandles } from "./useWindowResizeHandles";
import {
  dedupeResults,
  filterItemsBySearchType as filterItemsBySearchTypeUtil,
  limitResults as limitResultsUtil,
  mergeResultsStable,
  normalizeResultKey,
} from "./searchResultUtils";

type RefreshHistoryOpts = { typeId?: string; preserveSelectedPath?: string };

export function useSearchController() {
  // 统一读取设置：搜索页会用到默认类型、类型顺序、主题与背景相关配置
  const { settings } = useSettings();

  const parseDrivePrefix = (raw: string) => {
    // 输入支持“盘符前缀”：例如 C:、c:、C：，用于将搜索范围限制到指定盘符并提升速度
    const s = typeof raw === "string" ? raw.trim() : "";
    const m = s.match(/^([a-zA-Z])\s*[:：]\s*/);
    if (!m) return { term: s, drive: "" };
    const drive = (m[1] || "").toLowerCase();
    const term = s.slice(m[0].length).trim();
    return { term, drive };
  };

  // 搜索输入与类型选择：驱动查询与结果过滤
  const [query, setQuery] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [searchTypeId, setSearchTypeId] = useState<string>(settings.defaultSearchTypeId || "all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState(-1);
  const [lastSelectedBy, setLastSelectedBy] = useState<"keyboard" | "mouse">("keyboard");
  const [results, setResults] = useState<AppItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [hoveredKey, setHoveredKey] = useState("");
  const [toast, setToast] = useState<null | { kind: "success" | "error" | "info"; message: string }>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (message: string, kind: "success" | "error" | "info" = "info") => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ kind, message });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 1600);
  };

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
  const iconFetchTokenRef = useRef(0);
  const iconFetchStartedTokenRef = useRef(0);
  const requestedIconKeysRef = useRef<Set<string>>(new Set());
  // Tab/Shift+Tab 切换类型时不走 120ms 防抖，保证切换后立即看到新类型结果
  const typeSwitchRequestedRef = useRef(false);
  const shouldEchoSelectedOnceRef = useRef(false);

  const setQueryAndInputValue = (next: string) => {
    setQuery(next);
    setInputValue(next);
    shouldEchoSelectedOnceRef.current = false;
  };

  /**
   * 重置搜索界面所有状态到初始状态
   * 包括：清空搜索内容、关闭搜索类型下拉框、恢复默认搜索类型、重置索引与选中项等
   */
  const resetAllStates = useCallback(() => {
    setQueryAndInputValue("");
    setTypeMenuOpen(false);
    setSearchTypeId(settings.defaultSearchTypeId || "all");
    setSelectedIndex(0);
    setSelectedActionIndex(-1);
    setHoveredKey("");
    setIsSearching(false);
    setResults([]);
  }, [settings.defaultSearchTypeId, setQueryAndInputValue]);

  const ITEM_HEIGHT = 52;
  const MAX_LIST_HEIGHT = 382;
  const TYPE_MENU_MIN_LIST_SPACE = 240;
  const DISPLAY_LIMIT = 500;
  const lastVisibleStartIndexRef = useRef(0);

  useEffect(() => {
    void refreshUserStatusSilently();
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
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
    if (!shouldEchoSelectedOnceRef.current) return;
    const it = results[selectedIndex];
    if (it?.name) setInputValue(it.name);
    shouldEchoSelectedOnceRef.current = false;
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
    return filterItemsBySearchTypeUtil(items, typeId, settings.customSearchTypes || []);
  };

  const limitResults = (items: AppItem[]) => limitResultsUtil(items, DISPLAY_LIMIT);

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
         const next = limitResults(mergeResultsStable(prev, batch));
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
    if (searchTypeId === "app") return "搜索应用...";
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
        setQueryAndInputValue("");
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
    // 窗口被隐藏时执行的操作（主进程主动 blur 或显式调用 hide-window 时都会发此事件）
    const handler = () => {
      if (!settings.keepStateOnClose) {
        // 关闭时重置状态：清空内容、关闭下拉、恢复默认类型
        resetAllStates();
      } else {
        // 如果保留状态，则只确保下拉菜单已关闭
        setTypeMenuOpen(false);
      }
    };
    window.ipcRenderer?.on("search-window-hidden", handler as any);
    return () => {
      window.ipcRenderer?.off("search-window-hidden", handler as any);
    };
  }, [settings.keepStateOnClose, resetAllStates]);

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
    // more-results 事件用于主进程“增量回填图标/更多结果”
    // 这里必须常驻监听（不要随 query/searchTypeId 反复解绑/绑定），否则极易在首搜阶段丢事件，表现为“第一次没图标，第二次才有”
    const handler = (_event: any, payload: { query: string; results: AppItem[] }) => {
      const currentQuery = parseDrivePrefix(queryRef.current).term;
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
  }, []);

  useEffect(() => {
    const { term: trimmed, drive } = parseDrivePrefix(query);
    if (!trimmed || trimmed.length < 1) {
      // 空输入不触发搜索：显示历史；其余交由后续流程处理（支持单字符搜索）
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
    iconFetchTokenRef.current += 1;
    iconFetchStartedTokenRef.current = 0;
    requestedIconKeysRef.current.clear();
    setIsSearching(true);
    setHasMore(false);
    setTotalCount(0);
    setHoveredKey("");
    pendingAppendRef.current = [];
    if (flushAppendTimerRef.current != null) {
      window.clearTimeout(flushAppendTimerRef.current);
      flushAppendTimerRef.current = null;
    }
    // 防抖：避免连续输入触发过多 IPC 搜索请求
    const delay = typeSwitchRequestedRef.current ? 0 : 120;
    typeSwitchRequestedRef.current = false;
    const timer = setTimeout(async () => {
      try {
        const resp = (await window.ipcRenderer?.invoke(
          "search-files",
          trimmed,
          { searchTypeId, searchSessionId, drive },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;
        // 竞态保护：只接受“最新请求 + 当前 query/type”对应的结果
        if (searchRequestIdRef.current !== requestId) return;
        if (parseDrivePrefix(queryRef.current).term !== trimmed) return;
        if (searchTypeIdRef.current !== searchTypeId) return;
        const nextResults = filterItemsBySearchType(resp?.results ?? [], searchTypeId);
        setSelectedIndex(0);
        startTransition(() => {
          const limited = limitResults(dedupeResults(nextResults));
          setResults(limited);
          const rawTotal = typeof resp?.totalCount === "number" ? resp.totalCount : limited.length;
          // 如果没有更多结果，且当前结果数量小于后端返回的总数（说明前端去重了），则以当前结果数量为准，避免界面显示“12条结果”但列表只有3项
          const finalTotal = (!resp?.hasMore && limited.length < rawTotal) ? limited.length : rawTotal;
          setTotalCount(finalTotal);
          setIsIndexing(Boolean(resp?.isIndexing));
          setHasMore(Boolean(resp?.hasMore));
        });
      } finally {
        if (searchRequestIdRef.current === requestId) setIsSearching(false);
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [query, searchTypeId]);

  useEffect(() => {
    if (searchTypeId !== "app") return;
    // 搜索进行中时结果会频繁变化：此时抢占式补齐图标会导致频繁 setState，引发列表短暂卡顿/闪动
    // 这里等本轮搜索结束后再拉取首屏缺失图标，并批量合并到 results，减少渲染压力
    if (isSearching) return;
    const now = Date.now();
    if (iconFetchStartedTokenRef.current > 0 && now - iconFetchStartedTokenRef.current < 120) return;
    const token = iconFetchTokenRef.current;
    if (!window.ipcRenderer) return;
    if (!queryRef.current || queryRef.current.trim().length < 1) return;

    const candidates = results
      .filter((x) => x?.type === "app" && (!x.icon || !String(x.icon).trim()))
      .slice(0, 24);
    if (candidates.length === 0) return;

    iconFetchStartedTokenRef.current = now;
    const queue = candidates.slice();
    const retryCounts = new Map<string, number>();
    let cancelled = false;

    const run = async () => {
      while (!cancelled && iconFetchTokenRef.current === token) {
        const it = queue.shift();
        if (!it) return;
        const key = normalizeResultKey(it);
        if (!key) continue;
        if (requestedIconKeysRef.current.has(key)) continue;
        requestedIconKeysRef.current.add(key);
        try {
          const icon = (await window.ipcRenderer.invoke("get-result-icon", {
            type: it.type,
            path: it.path,
            name: it.name,
          })) as string | undefined;
          if (cancelled || iconFetchTokenRef.current !== token) return;
          if (typeof icon !== "string" || !icon) {
            const retried = retryCounts.get(key) || 0;
            requestedIconKeysRef.current.delete(key);
            if (retried < 2) {
              retryCounts.set(key, retried + 1);
              queue.push(it);
            }
            continue;
          }
          // 将图标回填统一走“批量合并”队列：避免每个 icon 都触发一次列表重渲染导致卡顿
          pendingAppendRef.current = [...pendingAppendRef.current, { ...it, icon }];
          if (flushAppendTimerRef.current == null) {
            flushAppendTimerRef.current = window.setTimeout(() => flushPendingAppends(), 50);
          }
        } catch {
          requestedIconKeysRef.current.delete(key);
        }
      }
    };

    void Promise.all([run(), run()]);
    return () => {
      cancelled = true;
    };
  }, [results, searchTypeId, isSearching]);

  useEffect(() => {
    const trimmed = parseDrivePrefix(query).term;
    if (!trimmed || trimmed.length < 1) return;
    if (!isIndexing) return;
    if (isSearching) return;

    let cancelled = false;
    const refreshOnce = async () => {
      if (cancelled) return;
      if (!window.ipcRenderer) return;
      if (!isIndexing) return;
      if (isSearching) return;

      const currentQuery = parseDrivePrefix(queryRef.current).term;
      if (currentQuery !== trimmed) return;

      const currentTypeId = searchTypeIdRef.current;
      const currentSessionId = searchSessionIdRef.current;
      if (!currentSessionId) return;
      const currentDrive = parseDrivePrefix(queryRef.current).drive;
      try {
        const resp = (await window.ipcRenderer.invoke(
          "search-files",
          trimmed,
          { searchTypeId: currentTypeId, searchSessionId: currentSessionId, drive: currentDrive },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;

        if (cancelled) return;
        if (parseDrivePrefix(queryRef.current).term !== trimmed) return;
        if (searchTypeIdRef.current !== currentTypeId) return;

        const nextResults = filterItemsBySearchType(resp?.results ?? [], currentTypeId);
        const respTotal = typeof resp?.totalCount === "number" ? resp.totalCount : 0;
        const serverOrdered = limitResults(dedupeResults(nextResults));
        startTransition(() => {
          setResults((prev) => {
            // 增量回填/索引刷新时只“补齐/更新”数据，不重排已加载的列表顺序，避免拖拽/操作时出现跳动
            const merged = limitResults(mergeResultsStable(prev, serverOrdered));
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

  const hideWindow = useCallback(() => {
    if (!settings.keepStateOnClose) {
      // 关闭时重置状态：清空内容、关闭下拉、恢复默认类型
      resetAllStates();
    } else {
      // 保持状态时仅关闭下拉框，避免下次打开时遮挡
      setTypeMenuOpen(false);
    }
    window.ipcRenderer?.invoke("hide-window");
  }, [settings.keepStateOnClose, resetAllStates]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hideWindow();
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
    // “打开目录”需要在主进程区分 app/file/folder：应用优先定位到开始菜单快捷方式所在目录，而不是打开 AppsFolder 虚拟目录
    window.ipcRenderer?.invoke("open-folder", { type: app.type, path: app.path, name: app.name });
  };

  const launchApp = (app: AppItem) => {
    window.ipcRenderer?.invoke("open-item", {
      name: app.name,
      path: app.path,
      type: app.type || "file",
    });
  };

  const runAsAdmin = (app: AppItem) => {
    // 以管理员身份运行可能失败（UAC 拒绝/不支持的类型）：这里用 toast 给出明确反馈，避免“点击没反应”
    (async () => {
      try {
        const resp = (await window.ipcRenderer?.invoke("run-as-admin", {
          path: app.path,
          type: app.type,
          name: app.name,
        })) as { ok: boolean; message?: string } | boolean | undefined;

        if (!resp) return;
        const ok = typeof resp === "boolean" ? resp : Boolean(resp?.ok);
        const msg = typeof resp === "object" && resp ? (resp as any).message : "";
        // toast 文案不换行：将可能出现的换行符压缩为一个空格，配合 CSS 省略号显示
        const safeMsg = String(msg || "").replace(/\s*\r?\n\s*/g, " ").trim();

        if (ok) {
          showToast("已请求管理员运行", "success");
        } else {
          showToast(safeMsg || "管理员运行失败", "error");
        }
      } catch {
        showToast("管理员运行失败", "error");
      }
    })();
  };

  const copyPath = (item: AppItem) => {
    if (!item?.path) return;
    navigator.clipboard
      .writeText(item.path)
      .then(() => showToast("已复制路径", "success"))
      .catch(() => showToast("复制失败", "error"));
  };

  const isHistoryMode = query.trim().length === 0;

  const getVisibleActionIdsForItem = useCallback(
    (item: AppItem | undefined) => {
      if (!item) return [] as AppSettings["resultActionButtons"]; 
      const raw = Array.isArray(settings.resultActionButtons) ? settings.resultActionButtons : [];
      const out: AppSettings["resultActionButtons"][number][] = [];
      for (const id of raw) {
        if (id === "deleteHistory" && !isHistoryMode) continue;
        if (id === "runAsAdmin" && item.type !== "app") continue;
        if (!(["openFolder", "copyPath", "deleteHistory", "runAsAdmin"] as const).includes(id as any)) continue;
        if (out.includes(id)) continue;
        out.push(id);
        if (out.length >= 3) break;
      }
      return out;
    },
    [settings.resultActionButtons, isHistoryMode],
  );

  const selectedActionIds = useMemo(() => {
    return getVisibleActionIdsForItem(results[selectedIndex]);
  }, [getVisibleActionIdsForItem, results, selectedIndex]);

  const selectedActionId =
    selectedActionIndex >= 0 && selectedActionIndex < selectedActionIds.length
      ? selectedActionIds[selectedActionIndex]
      : "";

  useEffect(() => {
    setSelectedActionIndex(-1);
  }, [selectedIndex]);

  const handleKeyDownCore = useCallback(
    (e: {
      key: string;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      metaKey: boolean;
      preventDefault: () => void;
      stopPropagation: () => void;
      isComposing?: boolean;
    }) => {
      if ((e as any).isComposing) return;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (results.length === 0) return;
        const item = results[selectedIndex];
        const ids = getVisibleActionIdsForItem(item);
        if (ids.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setLastSelectedBy("keyboard");
        setSelectedActionIndex((prev) => {
          const nextPrev = typeof prev === "number" ? prev : -1;

          // 第一次左右切换：必须先选中第一个按钮，再根据方向继续切
          if (nextPrev < 0) return 0;

          const delta = e.key === "ArrowRight" ? 1 : -1;
          const next = (nextPrev + delta + ids.length) % ids.length;
          return next;
        });
        return;
      }

      if (e.key === "Enter" && selectedActionIndex >= 0) {
        if (results.length === 0) return;
        const item = results[selectedIndex];
        const ids = getVisibleActionIdsForItem(item);
        const id = selectedActionIndex >= 0 && selectedActionIndex < ids.length ? ids[selectedActionIndex] : "";
        if (!id) return;

        e.preventDefault();
        e.stopPropagation();
        setSelectedActionIndex(-1);

        if (id === "openFolder") openFolder(item);
        else if (id === "copyPath") copyPath(item);
        else if (id === "runAsAdmin") runAsAdmin(item);
        else if (id === "deleteHistory") void deleteHistoryItem(item.path);
        return;
      }

      if (e.key === "ArrowDown") {
        if (selectedActionIndex >= 0) setSelectedActionIndex(-1);
      } else if (e.key === "ArrowUp") {
        if (selectedActionIndex >= 0) setSelectedActionIndex(-1);
      }

      handleKeyDownCapture(e as any);
    },
    [
      results,
      selectedIndex,
      selectedActionIndex,
      getVisibleActionIdsForItem,
      openFolder,
      runAsAdmin,
      deleteHistoryItem,
    ],
  );

  const handleWindowKeyDownCapture = useCallback(
    (e: KeyboardEvent) => {
      handleKeyDownCore(e as any);
    },
    [handleKeyDownCore],
  );

  const handleReactKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      handleKeyDownCore(e as any);
    },
    [handleKeyDownCore],
  );

  const handleKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && (e.key === "l" || e.key === "k")) {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      return;
    }

    if (e.key === "Escape") {
      hideWindow();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const idx = Math.max(
        0,
        enabledSearchTypeOptions.findIndex((t) => t.id === searchTypeId),
      );
      const delta = e.shiftKey ? -1 : 1;
      const nextIdx = (idx + delta + enabledSearchTypeOptions.length) % enabledSearchTypeOptions.length;
      const next = enabledSearchTypeOptions[nextIdx];
      typeSwitchRequestedRef.current = true;
      if (next) setSearchTypeId(next.id);
      setTypeMenuOpen(false);
      return;
    }

    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      setLastSelectedBy("keyboard");
      shouldEchoSelectedOnceRef.current = true;
      setSelectedIndex((prev) => (prev + 1) % results.length);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setLastSelectedBy("keyboard");
      shouldEchoSelectedOnceRef.current = true;
      setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      e.preventDefault();
    } else if (e.key === "Home") {
      setLastSelectedBy("keyboard");
      shouldEchoSelectedOnceRef.current = true;
      setSelectedIndex(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setLastSelectedBy("keyboard");
      shouldEchoSelectedOnceRef.current = true;
      setSelectedIndex(results.length - 1);
      e.preventDefault();
    } else if (e.key === "PageDown") {
      setLastSelectedBy("keyboard");
      shouldEchoSelectedOnceRef.current = true;
      setSelectedIndex((prev) => Math.min(results.length - 1, prev + 10));
      e.preventDefault();
    } else if (e.key === "PageUp") {
      setLastSelectedBy("keyboard");
      shouldEchoSelectedOnceRef.current = true;
      setSelectedIndex((prev) => Math.max(0, prev - 10));
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (e.ctrlKey) openFolder(results[selectedIndex]);
      else launchApp(results[selectedIndex]);
    }
  };

  // 列表使用虚拟滚动（react-window v2），这里直接使用全量 results，避免“选中索引超出可见切片”导致空白渲染
  const visibleResults = results;
  const currentTypeLabel = useMemo(() => {
    return enabledSearchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有类型";
  }, [searchTypeId, enabledSearchTypeOptions]);

  const listHeight = Math.min(visibleResults.length * ITEM_HEIGHT, MAX_LIST_HEIGHT);
  const parsedQuery = useMemo(() => parseDrivePrefix(query), [query]);
  const trimmedQuery = parsedQuery.term;
  const showEmptyState =
    trimmedQuery.length >= 1 &&
    !isSearching &&
    !isIndexing &&
    results.length === 0;
  const showInputHint =
    trimmedQuery.length > 0 &&
    trimmedQuery.length < 1 &&
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
      setShowBackToTop(false);
    }
  };

  const onItemsRendered = (visibleRows: { startIndex: number; stopIndex: number }) => {
    const startIndex = typeof visibleRows?.startIndex === "number" ? visibleRows.startIndex : 0;
    lastVisibleStartIndexRef.current = startIndex;
    const shouldShow = Math.max(startIndex, selectedIndex) > 8;
    setShowBackToTop((prev) => (prev === shouldShow ? prev : shouldShow));
  };

  const statusText = isSearching
    ? "正在搜索…"
    : isIndexing
      ? "正在建立本地文件索引…"
      : "";

  return {
    settings,
    query,
    setQuery: setQueryAndInputValue,
    inputValue,
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
    handleKeyDownCapture: handleReactKeyDownCapture,
    handleWindowKeyDownCapture,
    startResizing,
    openSettings,
    openFolder,
    launchApp,
    runAsAdmin,
    copyPath,
    hideWindow,
    refreshHistory,
    deleteHistoryItem,
    scrollToTop,
    onItemsRendered,
    trimmedQuery,
    showBackToTop,
    hoveredKey,
    setHoveredKey,
    toast,
    showToast,
    selectedActionId,
  };
}
