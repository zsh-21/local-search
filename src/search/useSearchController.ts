import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppItem, AppSettings } from "../appTypes";
import { getBootstrapHistoryCache, getSearchTypeOptions, useSettings } from "../settingsStore";
import {
  DEFAULT_SETTINGS,
  SEARCH_ITEM_HEIGHT_COMPACT,
  SEARCH_ITEM_HEIGHT_NORMAL,
  SEARCH_LIST_MIN_HEIGHT,
  SEARCH_WINDOW_BOTTOM_BAR_HEIGHT,
  SEARCH_WINDOW_TOP_BAR_HEIGHT,
} from "../constants/initialValues";
import {
  dedupeResults,
  filterItemsBySearchType as filterItemsBySearchTypeUtil,
  limitResults as limitResultsUtil,
} from "./searchResultUtils";
import { isStrictSearchMatch, parseSearchMatchIntent, pickSearchMatchTargetText } from "../../shared/searchMatch";
import { buildCalcItem, mapCalcHistoryToItems, normalizeCalcHistoryPayload, parseCalcMode } from "./searchCalcUtils";
import { parseDrivePrefix, resolveGhostCandidateByInput } from "./searchInputUtils";
import { resizeSearchWindowToContent } from "./searchWindowResize";
import {
  createHandleKeyDownCapture,
  createHandleKeyDownCore,
  isShortcutPressed,
} from "./searchKeyboardHandlers";
import {
  copyCalcResultAction,
  copyPathAction,
  launchAppAction,
  openFolderAction,
  openSettingsAction,
  runAsAdminAction,
} from "./searchItemActions";
import { useSearchControllerSearchEffects } from "./useSearchControllerSearchEffects";
import { useSearchControllerLifecycleEffects } from "./useSearchControllerLifecycleEffects";

type RefreshHistoryOpts = { typeId?: string; preserveSelectedPath?: string };
const SEARCH_STATUS_DELAY_MS = 120;
const SEARCH_DEBOUNCE_READY_MS = 0;
const SEARCH_DEBOUNCE_INDEXING_MS = 120;

export function useSearchController() {
  const { settings, loaded } = useSettings();

  const [query, setQuery] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [ghostInputValue, setGhostInputValue] = useState("");
  const [searchTypeId, setSearchTypeId] = useState<string>(settings.defaultSearchTypeId || "all");
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedActionIndex, setSelectedActionIndex] = useState(-1);
  const [lastSelectedBy, setLastSelectedBy] = useState<"keyboard" | "mouse">("keyboard");
  const [results, setResults] = useState<AppItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchingIndicator, setShowSearchingIndicator] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [hoveredKey, setHoveredKey] = useState("");
  const [toast, setToast] = useState<null | { kind: "success" | "error" | "info"; message: string }>(null);
  const [calculatorIconDataUrl, setCalculatorIconDataUrl] = useState("");
  const [isPanelPinned, setIsPanelPinned] = useState(false);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (message: string, kind: "success" | "error" | "info" = "info") => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ kind, message });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 1600);
  };

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<any>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const typeSelectRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const lastResizePayloadRef = useRef<null | {
    height: number;
    minHeight: number;
    maxHeight: number;
  }>(null);
  const resizeRafRef = useRef<number | null>(null);
  const searchingIndicatorTimerRef = useRef<number | null>(null);
  const queryRef = useRef("");
  const searchTypeIdRef = useRef(searchTypeId);
  const selectedPathRef = useRef("");
  const isPanelPinnedRef = useRef(isPanelPinned);
  const searchRequestIdRef = useRef(0);
  const searchSessionIdRef = useRef("");
  const pendingAppendRef = useRef<AppItem[]>([]);
  const flushAppendTimerRef = useRef<number | null>(null);
  const preserveGhostSuggestionRef = useRef(false);
  const calcItemRef = useRef<AppItem | null>(null);
  const calcHistoryItemsRef = useRef<AppItem[]>([]);
  const typeSwitchRequestedRef = useRef(false);
  const historyItemsRef = useRef<AppItem[]>(getBootstrapHistoryCache());
  const bootstrapTypeSyncedRef = useRef(false);

  const resizeWindowToContent = useCallback(
    (opts?: { includeTypeMenu?: boolean }) => {
      resizeSearchWindowToContent({
        opts,
        containerRef,
        typeMenuOpen,
        typeMenuRef,
        settings,
        resultsLength: results.length,
        lastResizePayloadRef,
      });
    },
    [results.length, settings.compactMode, settings.searchWindowMaxHeight, typeMenuOpen],
  );

  const syncWindowHeight = useCallback(
    (opts?: { includeTypeMenu?: boolean }) => {
      resizeWindowToContent(opts);
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeWindowToContent(opts);
      });
    },
    [resizeWindowToContent],
  );

  const setQueryAndInputValue = (next: string) => {
    preserveGhostSuggestionRef.current = false;
    setQuery(next);
    setInputValue(next);
    setGhostInputValue("");
    setSelectedActionIndex((prev) => (prev >= 0 ? -1 : prev));
  };

  const clearGhostInputValue = useCallback(() => {
    preserveGhostSuggestionRef.current = false;
    setGhostInputValue("");
  }, []);

  const syncBlurHideByPinnedState = useCallback((pinned: boolean) => {
    void window.ipcRenderer?.invoke("set-search-blur-hide-enabled", !pinned);
  }, []);

  const notifySearchViewReady = useCallback(() => {
    void window.ipcRenderer?.invoke("search-view-ready", {
      allowBlurHide: !isPanelPinnedRef.current,
    });
  }, []);

  const ITEM_HEIGHT = settings.compactMode ? SEARCH_ITEM_HEIGHT_COMPACT : SEARCH_ITEM_HEIGHT_NORMAL;
  const deviceMaxHeight = Math.floor((window.screen as any)?.availHeight || 0);
  const maxWindowHeight = Math.min(
    typeof settings.searchWindowMaxHeight === "number" ? settings.searchWindowMaxHeight : DEFAULT_SETTINGS.searchWindowMaxHeight,
    deviceMaxHeight > 0 ? deviceMaxHeight : Number.POSITIVE_INFINITY,
  );
  const MAX_LIST_HEIGHT = Math.max(
    SEARCH_LIST_MIN_HEIGHT,
    Math.round(maxWindowHeight) - SEARCH_WINDOW_TOP_BAR_HEIGHT - SEARCH_WINDOW_BOTTOM_BAR_HEIGHT,
  );
  const DISPLAY_LIMIT = settings.searchDisplayLimit;
  const MAX_PENDING_APPEND_ITEMS = 500;
  const lastVisibleStartIndexRef = useRef(0);

  const filterItemsBySearchType = (items: AppItem[], typeId: string) => {
    return filterItemsBySearchTypeUtil(items, typeId, settings.customSearchTypes || []);
  };

  const limitHistoryResults = (items: AppItem[]) => limitResultsUtil(items, DISPLAY_LIMIT);
  const applyStrictSearchResults = useCallback((items: AppItem[], rawQuery: string) => {
    const intent = parseSearchMatchIntent(rawQuery);
    if (!intent.term || intent.tokens.length === 0) return [];
    return items.filter((item) => {
      const target = pickSearchMatchTargetText(item, intent);
      return isStrictSearchMatch(target, intent);
    });
  }, []);
  const applyCalcResults = useCallback((currentCalcItem: AppItem | null, preservePath?: string) => {
    const history = calcHistoryItemsRef.current;
    const merged = currentCalcItem
      ? [currentCalcItem, ...history.filter((it) => it.path !== currentCalcItem.path)]
      : history.slice();
    const deduped = dedupeResults(merged);
    setResults(deduped);
    setTotalCount(deduped.length);
    if (preservePath) {
      const idx = deduped.findIndex((x) => x.path === preservePath);
      setSelectedIndex(idx >= 0 ? idx : 0);
    } else {
      setSelectedIndex(0);
    }
    setIsSearching(false);
    setIsIndexing(false);
    setHasMore(false);
  }, []);

  const searchTypeOptions = useMemo(
    () =>
      getSearchTypeOptions(
        settings.customSearchTypes || [],
        settings.searchTypeOrder,
      ),
    [settings.customSearchTypes, settings.searchTypeOrder],
  );

  const enabledSearchTypeOptions = useMemo(() => {
    const disabled = Array.isArray(settings.disabledSearchTypeIds) ? settings.disabledSearchTypeIds : [];
    return searchTypeOptions.filter((t) => t.id === "all" || !disabled.includes(t.id));
  }, [searchTypeOptions, settings.disabledSearchTypeIds]);

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

  const applyHistoryResults = (historyItems: AppItem[], opts?: RefreshHistoryOpts) => {
    const typeId = typeof opts?.typeId === "string" ? opts.typeId : searchTypeId;
    const filtered = filterItemsBySearchType(historyItems, typeId);
    const deduped = limitHistoryResults(dedupeResults(filtered));
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

  const refreshHistory = async (opts?: RefreshHistoryOpts) => {
    applyHistoryResults(historyItemsRef.current, opts);
  };

  const deleteHistoryItem = async (targetPath: string) => {
    if (!targetPath) return;
    await window.ipcRenderer?.invoke("delete-history-item", targetPath);
  };

  const deleteCalcHistoryItem = async (expression: string) => {
    if (!expression) return;
    await window.ipcRenderer?.invoke("delete-calc-history-item", expression);
  };

  const deleteResultItem = useCallback(
    async (item: AppItem | undefined) => {
      if (!item?.path) return;
      if (parseCalcMode(queryRef.current).isCalcMode && item.type === "calc") {
        await deleteCalcHistoryItem(item.path);
        return;
      }
      await deleteHistoryItem(item.path);
    },
    [],
  );

  useSearchControllerSearchEffects({
    query, searchTypeId, isIndexing, isSearching, results, buildCalcItem, parseCalcMode, parseDrivePrefix,
    queryRef, searchTypeIdRef, selectedPathRef, calcItemRef, searchRequestIdRef, searchSessionIdRef,
    typeSwitchRequestedRef, pendingAppendRef, flushAppendTimerRef, setResults, setTotalCount, setIsSearching,
    setHasMore, setHoveredKey, setSelectedIndex, setIsIndexing, refreshHistory, filterItemsBySearchType,
    applyStrictSearchResults, applyCalcResults, MAX_PENDING_APPEND_ITEMS, SEARCH_DEBOUNCE_INDEXING_MS,
    SEARCH_DEBOUNCE_READY_MS,
  });

  const hideWindow = () => {
    setTypeMenuOpen(false);
    window.ipcRenderer?.invoke("hide-window");
  };

  const togglePanelPinned = useCallback(() => {
    setIsPanelPinned((prev) => {
      const next = !prev;
      syncBlurHideByPinnedState(next);
      isPanelPinnedRef.current = next;
      return next;
    });
  }, [syncBlurHideByPinnedState]);

  useSearchControllerLifecycleEffects({
    notifySearchViewReady, historyItemsRef, bootstrapTypeSyncedRef, loaded, setSearchTypeId, queryRef,
    searchTypeIdRef, selectedPathRef, applyHistoryResults, toastTimerRef, searchingIndicatorTimerRef,
    resizeRafRef, setIsIndexing, setIndexProgress, isSearching, setShowSearchingIndicator, SEARCH_STATUS_DELAY_MS,
    query, searchTypeId, isPanelPinned, isPanelPinnedRef, syncBlurHideByPinnedState, results, selectedIndex,
    setSelectedIndex, preserveGhostSuggestionRef, setGhostInputValue, inputValue, ghostInputValue, lastSelectedBy,
    resolveGhostCandidateByInput, normalizeCalcHistoryPayload, mapCalcHistoryToItems, parseCalcMode, applyCalcResults,
    calcHistoryItemsRef, calcItemRef, typeSelectRef, setTypeMenuOpen, typeMenuOpen, setCalculatorIconDataUrl,
    enabledSearchTypeOptions, settings, inputRef, lastResizePayloadRef, setQueryAndInputValue, syncWindowHeight,
    refreshHistory, listRef, hideWindow,
  });

  const openSettings = () => openSettingsAction();
  const copyCalcResult = (item: AppItem | undefined) => copyCalcResultAction(item, showToast);
  const openFolder = (app: AppItem) => openFolderAction(app);
  const launchApp = (app: AppItem) => launchAppAction(app, copyCalcResult);
  const runAsAdmin = (app: AppItem) => {
    void runAsAdminAction(app, showToast);
  };
  const copyPath = (item: AppItem) => copyPathAction(item, showToast);

  const isCalcMode = parseCalcMode(query).isCalcMode;
  const isHistoryMode = !isCalcMode && query.trim().length === 0;

  const getVisibleActionIdsForItem = useCallback(
    (item: AppItem | undefined) => {
      if (!item) return [] as AppSettings["resultActionButtons"];
      if (item.type === "calc") {
        return isCalcMode ? (["deleteHistory"] as AppSettings["resultActionButtons"]) : ([] as AppSettings["resultActionButtons"]);
      }
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
    [settings.resultActionButtons, isHistoryMode, isCalcMode],
  );

  const selectedActionIds = useMemo(() => {
    return getVisibleActionIdsForItem(results[selectedIndex]);
  }, [getVisibleActionIdsForItem, results, selectedIndex]);

  const selectedActionId =
    selectedActionIndex >= 0 && selectedActionIndex < selectedActionIds.length
      ? selectedActionIds[selectedActionIndex]
      : "";

  const clearActionSelection = useCallback(() => {
    setSelectedActionIndex((prev) => (prev >= 0 ? -1 : prev));
  }, []);

  useEffect(() => {
    setSelectedActionIndex(-1);
  }, [selectedIndex]);

  const acceptSelectedResultToInput = () => {
    const selected = results[selectedIndex];
    if (!selected?.name) return false;
    setQueryAndInputValue(selected.name);
    setGhostInputValue("");
    inputRef.current?.focus();
    return true;
  };

  const clearSearchInput = useCallback(() => {
    setQueryAndInputValue("");
    setGhostInputValue("");
    setSelectedIndex(0);
    setSelectedActionIndex(-1);
    setTypeMenuOpen(false);
    inputRef.current?.focus();
  }, [setQueryAndInputValue]);

  const handleKeyDownCapture = createHandleKeyDownCapture({
    inputValue,
    ghostInputValue,
    inputRef,
    preserveGhostSuggestionRef,
    setQuery,
    setInputValue,
    setSelectedActionIndex,
    clearSearchInput,
    hideWindow,
    togglePanelPinned,
    enabledSearchTypeOptions,
    searchTypeId,
    typeSwitchRequestedRef,
    setGhostInputValue,
    setSearchTypeId,
    setTypeMenuOpen,
    results,
    settings,
    isShortcutPressed,
    acceptSelectedResultToInput,
    setLastSelectedBy,
    setSelectedIndex,
    resolveGhostCandidateByInput,
    selectedIndex,
    copyCalcResult,
    openFolder,
    launchApp,
  });

  const handleKeyDownCore = useMemo(
    () =>
      createHandleKeyDownCore({
        selectedActionIndex,
        setSelectedActionIndex,
        results,
        selectedIndex,
        getVisibleActionIdsForItem,
        setLastSelectedBy,
        openFolder,
        copyPath,
        runAsAdmin,
        deleteResultItem,
        togglePanelPinned,
        handleKeyDownCapture,
      }),
    [
      selectedActionIndex,
      results,
      selectedIndex,
      getVisibleActionIdsForItem,
      openFolder,
      copyPath,
      runAsAdmin,
      deleteResultItem,
      togglePanelPinned,
      handleKeyDownCapture,
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
  const visibleResults = results;
  const currentTypeLabel = useMemo(
    () => enabledSearchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有类型",
    [enabledSearchTypeOptions, searchTypeId],
  );
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
  const ghostSuffixValue = useMemo(() => {
    if (!inputValue || !ghostInputValue) return "";
    if (ghostInputValue.length <= inputValue.length) return "";
    const inputLower = inputValue.toLocaleLowerCase();
    const ghostLower = ghostInputValue.toLocaleLowerCase();
    if (!ghostLower.startsWith(inputLower)) return "";
    return ghostInputValue.slice(inputValue.length);
  }, [ghostInputValue, inputValue]);

  useLayoutEffect(() => {
    syncWindowHeight({ includeTypeMenu: true });
  }, [syncWindowHeight, isIndexing, showEmptyState, showInputHint, showSearchingIndicator, typeMenuOpen, visibleResults.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      resizeWindowToContent({ includeTypeMenu: true });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resizeWindowToContent]);

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

  const searchActivity: "idle" | "searching" | "indexing" = showSearchingIndicator
    ? "searching"
    : isIndexing
      ? "indexing"
      : "idle";

  return {
    settings, query, setQuery: setQueryAndInputValue, inputValue, ghostInputValue, ghostSuffixValue,
    searchTypeId, setSearchTypeId, typeMenuOpen, setTypeMenuOpen, selectedIndex, setSelectedIndex,
    lastSelectedBy, setLastSelectedBy, results, isSearching, isIndexing, hasMore, totalCount, isCalcMode,
    isPanelPinned, placeholder, searchTypeOptions: enabledSearchTypeOptions, currentTypeLabel,
    visibleResults, listHeight, showEmptyState, showInputHint, searchActivity, indexProgress, ITEM_HEIGHT,
    MAX_LIST_HEIGHT, inputRef, listRef, scrollContainerRef, typeSelectRef, typeMenuRef, containerRef,
    handleKeyDownCapture: handleReactKeyDownCapture, handleWindowKeyDownCapture, openSettings, openFolder,
    launchApp, runAsAdmin, copyPath, hideWindow, togglePanelPinned, refreshHistory, deleteHistoryItem,
    deleteResultItem, scrollToTop, onItemsRendered, trimmedQuery, showBackToTop, hoveredKey, setHoveredKey,
    toast, showToast, calculatorIconDataUrl, selectedActionId, clearActionSelection, clearSearchInput,
    clearGhostInputValue,
  };
}

