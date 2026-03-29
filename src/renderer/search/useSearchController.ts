import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ListImperativeAPI } from "react-window";
import { AppItem } from "../appTypes";
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
import { buildCalcItem, mapCalcHistoryToItems, normalizeCalcHistoryPayload, parseCalcMode } from "./searchCalcUtils";
import { parseDrivePrefix, resolveGhostCandidateByInput } from "./searchInputUtils";
import { resizeSearchWindowToContent } from "./searchWindowResize";
import { applyCalcResultsCore, applyHistoryResultsCore } from "./searchResultAppliers";
import { useSearchActionVisibility } from "./useSearchActionVisibility";
import { useSearchKeyHandlers } from "./useSearchKeyHandlers";
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
import {
  IPC_DELETE_CALC_HISTORY_ITEM,
  IPC_DELETE_HISTORY_ITEM,
  IPC_HIDE_WINDOW,
  IPC_SEARCH_VIEW_READY,
  IPC_SET_SEARCH_BLUR_HIDE_ENABLED,
} from "../../shared/ipc/channels";

type RefreshHistoryOpts = { typeId?: string; preserveSelectedPath?: string };
const SEARCH_STATUS_DELAY_MS = 120;
const SEARCH_DEBOUNCE_READY_MS = 0;
const SEARCH_DEBOUNCE_INDEXING_MS = 120;
type SearchListHandle = {
  readonly element: HTMLDivElement | null;
  scrollToRow: (options: { index: number; align?: "auto" | "start" | "end" | "center" | "smart" }) => void;
  scrollToItem?: (index: number, align?: "auto" | "start" | "end" | "center" | "smart") => void;
} & ListImperativeAPI;

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
  const [iconByKey, setIconByKey] = useState<Record<string, string>>({});
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
  const listRef = useRef<SearchListHandle | null>(null);
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
  const iconByKeyRef = useRef<Record<string, string>>({});
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
  const pendingScrollTopRef = useRef(false);

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
    void window.ipcRenderer?.invoke(IPC_SET_SEARCH_BLUR_HIDE_ENABLED, !pinned);
  }, []);

  const notifySearchViewReady = useCallback(() => {
    void window.ipcRenderer?.invoke(IPC_SEARCH_VIEW_READY, {
      allowBlurHide: !isPanelPinnedRef.current,
    });
  }, []);

  const ITEM_HEIGHT = settings.compactMode ? SEARCH_ITEM_HEIGHT_COMPACT : SEARCH_ITEM_HEIGHT_NORMAL;
  const deviceMaxHeight = Math.floor(window.screen?.availHeight || 0);
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
  const applyCalcResults = useCallback((currentCalcItem: AppItem | null, preservePath?: string) => {
    applyCalcResultsCore({
      currentCalcItem,
      historyItems: calcHistoryItemsRef.current,
      preservePath,
      setResults,
      setTotalCount,
      setSelectedIndex,
      setIsSearching,
      setIsIndexing,
      setHasMore,
      dedupeResults,
    });
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

  const applyHistoryResults = useCallback(
    (historyItems: AppItem[], opts?: RefreshHistoryOpts) => {
      const typeId = typeof opts?.typeId === "string" ? opts.typeId : searchTypeId;
      const preservePath = typeof opts?.preserveSelectedPath === "string" ? opts.preserveSelectedPath : "";
      applyHistoryResultsCore({
        historyItems,
        typeId,
        preservePath,
        setResults,
        setTotalCount,
        setSelectedIndex,
        setIsSearching,
        setIsIndexing,
        filterItemsBySearchType,
        limitHistoryResults,
        dedupeResults,
      });
    },
    [searchTypeId, filterItemsBySearchType, limitHistoryResults],
  );

  const refreshHistory = async (opts?: RefreshHistoryOpts) => {
    applyHistoryResults(historyItemsRef.current, opts);
  };

  const deleteHistoryItem = async (targetPath: string) => {
    if (!targetPath) return;
    await window.ipcRenderer?.invoke(IPC_DELETE_HISTORY_ITEM, targetPath);
  };

  const deleteCalcHistoryItem = async (expression: string) => {
    if (!expression) return;
    await window.ipcRenderer?.invoke(IPC_DELETE_CALC_HISTORY_ITEM, expression);
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
    query, searchTypeId, isIndexing, isSearching, hasMore, results, buildCalcItem, parseCalcMode, parseDrivePrefix,
    queryRef, searchTypeIdRef, selectedPathRef, calcItemRef, searchRequestIdRef, searchSessionIdRef,
    typeSwitchRequestedRef, pendingAppendRef, flushAppendTimerRef, setResults, setTotalCount, setIsSearching,
    setHasMore, setHoveredKey, setSelectedIndex, setIsIndexing, refreshHistory, filterItemsBySearchType,
    iconByKeyRef, setIconByKey,
    applyCalcResults, MAX_PENDING_APPEND_ITEMS, SEARCH_DEBOUNCE_INDEXING_MS,
    SEARCH_DEBOUNCE_READY_MS,
  });

  useEffect(() => {
    iconByKeyRef.current = iconByKey;
  }, [iconByKey]);

  useEffect(() => {
    const trimmed = parseDrivePrefix(query).term.trim();
    if (!trimmed) {
      pendingScrollTopRef.current = false;
      return;
    }
    if (parseCalcMode(trimmed).isCalcMode) {
      pendingScrollTopRef.current = false;
      return;
    }
    // 新搜索开始后等待结果完成再回到顶部，避免搜索中途跳动
    pendingScrollTopRef.current = true;
  }, [query, searchTypeId]);

  const hideWindow = () => {
    setTypeMenuOpen(false);
    window.ipcRenderer?.invoke(IPC_HIDE_WINDOW);
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

  const { getVisibleActionIdsForItem, selectedActionIds, selectedActionId } = useSearchActionVisibility({
    settings,
    isHistoryMode,
    isCalcMode,
    results,
    selectedIndex,
    selectedActionIndex,
  });

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

  const { handleKeyDownCapture: handleReactKeyDownCapture, handleWindowKeyDownCapture } = useSearchKeyHandlers({
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
    acceptSelectedResultToInput,
    setLastSelectedBy,
    setSelectedIndex,
    resolveGhostCandidateByInput,
    selectedIndex,
    copyCalcResult,
    openFolder,
    launchApp,
    selectedActionIndex,
    getVisibleActionIdsForItem,
    copyPath,
    runAsAdmin,
    deleteResultItem,
  });
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
  const showInputHint = false;
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
      listRef.current.scrollToRow({ index: 0, align: "auto",  });
      setSelectedIndex(0);
      setShowBackToTop(false);
    }
  };

  useEffect(() => {
    if (isSearching) return;
    if (!pendingScrollTopRef.current) return;
    const trimmed = parseDrivePrefix(queryRef.current).term.trim();
    if (!trimmed) {
      pendingScrollTopRef.current = false;
      return;
    }
    // 搜索结果完成后再回到顶部
    pendingScrollTopRef.current = false;
    requestAnimationFrame(() => {
      scrollToTop();
    });
  }, [isSearching, results.length, scrollToTop]);

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
    MAX_LIST_HEIGHT, iconByKey, inputRef, listRef, scrollContainerRef, typeSelectRef, typeMenuRef, containerRef,
    handleKeyDownCapture: handleReactKeyDownCapture, handleWindowKeyDownCapture, openSettings, openFolder,
    launchApp, runAsAdmin, copyPath, hideWindow, togglePanelPinned, refreshHistory, deleteHistoryItem,
    deleteResultItem, scrollToTop, onItemsRendered, trimmedQuery, showBackToTop, hoveredKey, setHoveredKey,
    toast, showToast, calculatorIconDataUrl, selectedActionId, clearActionSelection, clearSearchInput,
    clearGhostInputValue,
  };
}

