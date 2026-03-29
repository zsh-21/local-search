import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { AppItem, AppSettings, SearchTypeOption } from "../appTypes";
import type { AppBootstrapState } from "../settingsStore";
import { refreshUserStatusSilently } from "../membership";
import { loadBootstrapState, setBootstrapHistoryCache } from "../settingsStore";
import {
  IPC_EVENT_CALC_HISTORY_UPDATED,
  IPC_EVENT_HISTORY_UPDATED,
  IPC_EVENT_RESET_SEARCH,
  IPC_EVENT_SEARCH_WINDOW_HIDDEN,
  IPC_EVENT_SEARCH_WINDOW_OPENED,
  IPC_GET_CALC_HISTORY,
  IPC_GET_INDEX_PROGRESS,
  IPC_GET_RESULT_ICON,
} from "../../shared/ipc/channels";
type RefreshHistoryOptions = {
  typeId?: string;
  preserveSelectedPath?: string;
};
type CalcHistoryRecord = {
  expression: string;
  result: string;
  lastUsed: number;
};
type ListAlign = "auto" | "start" | "end" | "center" | "smart";
type SearchListHandle = {
  scrollToItem?: (index: number, align?: ListAlign) => void;
  scrollToRow?: (options: { index: number; align?: ListAlign }) => void;
};
type NumberStateSetter = (value: number | ((prev: number) => number)) => void;
type BooleanStateSetter = (value: boolean | ((prev: boolean) => boolean)) => void;
type SearchControllerLifecycleParams = {
  notifySearchViewReady: () => void;
  historyItemsRef: MutableRefObject<AppItem[]>;
  bootstrapTypeSyncedRef: MutableRefObject<boolean>;
  loaded: boolean;
  setSearchTypeId: (value: string) => void;
  queryRef: MutableRefObject<string>;
  searchTypeIdRef: MutableRefObject<string>;
  selectedPathRef: MutableRefObject<string>;
  applyHistoryResults: (historyItems: AppItem[], options?: RefreshHistoryOptions) => void;
  toastTimerRef: MutableRefObject<number | null>;
  searchingIndicatorTimerRef: MutableRefObject<number | null>;
  resizeRafRef: MutableRefObject<number | null>;
  setIsIndexing: BooleanStateSetter;
  setIndexProgress: NumberStateSetter;
  isSearching: boolean;
  setShowSearchingIndicator: BooleanStateSetter;
  SEARCH_STATUS_DELAY_MS: number;
  query: string;
  searchTypeId: string;
  isPanelPinned: boolean;
  isPanelPinnedRef: MutableRefObject<boolean>;
  syncBlurHideByPinnedState: (pinned: boolean) => void;
  results: AppItem[];
  selectedIndex: number;
  setSelectedIndex: NumberStateSetter;
  preserveGhostSuggestionRef: MutableRefObject<boolean>;
  setGhostInputValue: (value: string) => void;
  inputValue: string;
  ghostInputValue: string;
  lastSelectedBy: "keyboard" | "mouse";
  resolveGhostCandidateByInput: (rawInput: string, candidateName: string) => string;
  normalizeCalcHistoryPayload: (payload: unknown) => CalcHistoryRecord[];
  mapCalcHistoryToItems: (records: CalcHistoryRecord[]) => AppItem[];
  parseCalcMode: (rawQuery: string) => { isCalcMode: boolean; expression: string };
  applyCalcResults: (currentCalcItem: AppItem | null, preservePath?: string) => void;
  calcHistoryItemsRef: MutableRefObject<AppItem[]>;
  calcItemRef: MutableRefObject<AppItem | null>;
  typeSelectRef: RefObject<HTMLDivElement>;
  setTypeMenuOpen: (value: boolean) => void;
  typeMenuOpen: boolean;
  setCalculatorIconDataUrl: (value: string) => void;
  enabledSearchTypeOptions: SearchTypeOption[];
  settings: AppSettings;
  inputRef: RefObject<HTMLInputElement>;
  lastResizePayloadRef: MutableRefObject<{
    height: number;
    minHeight: number;
    maxHeight: number;
  } | null>;
  setQueryAndInputValue: (next: string) => void;
  syncWindowHeight: (options?: { includeTypeMenu?: boolean }) => void;
  refreshHistory: (options?: RefreshHistoryOptions) => Promise<void>;
  listRef: MutableRefObject<SearchListHandle | null>;
  hideWindow: () => void;
};
function normalizeBootstrapSnapshot(snapshot: AppBootstrapState): AppBootstrapState {
  return {
    settings: snapshot.settings,
    history: Array.isArray(snapshot.history) ? snapshot.history : [],
  };
}
function normalizeCalcHistoryResponse(raw: unknown): { results?: unknown } {
  if (!raw || typeof raw !== "object") return {};
  return raw as { results?: unknown };
}
export function useSearchControllerLifecycleEffects(params: SearchControllerLifecycleParams) {
  useEffect(() => {
    params.notifySearchViewReady();
  }, [params.notifySearchViewReady]);

  useEffect(() => {
    void refreshUserStatusSilently();
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadBootstrapState().then((snapshot) => {
      if (!mounted) return;
      const normalizedSnapshot = normalizeBootstrapSnapshot(snapshot);
      params.historyItemsRef.current = normalizedSnapshot.history;
      setBootstrapHistoryCache(params.historyItemsRef.current);

      if (!params.bootstrapTypeSyncedRef.current && params.loaded) {
        const nextTypeId = normalizedSnapshot.settings.defaultSearchTypeId || "all";
        params.bootstrapTypeSyncedRef.current = true;
        params.setSearchTypeId(nextTypeId);
        if (params.queryRef.current.trim().length === 0) {
          params.applyHistoryResults(params.historyItemsRef.current, { typeId: nextTypeId });
        }
      } else if (params.queryRef.current.trim().length === 0) {
        params.applyHistoryResults(params.historyItemsRef.current, {
          typeId: params.searchTypeIdRef.current,
          preserveSelectedPath: params.selectedPathRef.current,
        });
      }
    });

    const handleHistoryUpdated = (_event: unknown, payload?: { results?: AppItem[] }) => {
      const nextHistory = Array.isArray(payload?.results) ? payload.results : [];
      params.historyItemsRef.current = nextHistory;
      setBootstrapHistoryCache(nextHistory);
      if (params.queryRef.current.trim().length === 0) {
        params.applyHistoryResults(nextHistory, {
          typeId: params.searchTypeIdRef.current,
          preserveSelectedPath: params.selectedPathRef.current,
        });
      }
    };

    window.ipcRenderer?.on<[payload?: { results?: AppItem[] }]>(IPC_EVENT_HISTORY_UPDATED, handleHistoryUpdated);
    return () => {
      mounted = false;
      window.ipcRenderer?.off<[payload?: { results?: AppItem[] }]>(IPC_EVENT_HISTORY_UPDATED, handleHistoryUpdated);
    };
  }, [params.loaded]);

  useEffect(() => {
    return () => {
      if (params.toastTimerRef.current) window.clearTimeout(params.toastTimerRef.current);
      if (params.searchingIndicatorTimerRef.current != null) {
        window.clearTimeout(params.searchingIndicatorTimerRef.current);
        params.searchingIndicatorTimerRef.current = null;
      }
      if (params.resizeRafRef.current != null) {
        cancelAnimationFrame(params.resizeRafRef.current);
        params.resizeRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timerId: number | null = null;
    let searchWindowVisible = true;
    let stableIsIndexing = false;
    let falseStreak = 0;
    const POLL_FAST_INDEXING_MS = 500;
    const POLL_IDLE_MS = 5000;
    const POLL_ERROR_RETRY_MS = 3000;
    const FALSE_STREAK_THRESHOLD = 3;
    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      if (!searchWindowVisible) return;
      if (timerId != null) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        void poll();
      }, Math.max(100, Math.floor(Number(delayMs) || 0)));
    };

    const poll = async () => {
      if (cancelled) return;
      if (!window.ipcRenderer) {
        scheduleNext(POLL_IDLE_MS);
        return;
      }
      if (!searchWindowVisible) return;
      let hasError = false;
      try {
        const resp = (await window.ipcRenderer.invoke(IPC_GET_INDEX_PROGRESS)) as
          | {
              isIndexing?: boolean;
              progress?: number;
            }
          | undefined;
        if (cancelled) return;

        const isIndexing = Boolean(resp?.isIndexing);
        const raw = Number(resp?.progress);
        const normalized = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
        if (isIndexing) {
          falseStreak = 0;
          if (!stableIsIndexing) {
            stableIsIndexing = true;
            params.setIsIndexing(true);
          }
          params.setIndexProgress((prev) => (prev === normalized ? prev : normalized));
        } else if (!stableIsIndexing) {
          params.setIsIndexing(false);
          params.setIndexProgress((prev) => (prev === 0 ? prev : 0));
        } else {
          falseStreak += 1;
          if (falseStreak >= FALSE_STREAK_THRESHOLD) {
            stableIsIndexing = false;
            falseStreak = 0;
            params.setIsIndexing(false);
            params.setIndexProgress(0);
          }
        }

        const nextDelayMs = isIndexing || stableIsIndexing ? POLL_FAST_INDEXING_MS : POLL_IDLE_MS;
        scheduleNext(nextDelayMs);
      } catch {
        hasError = true;
      }
      if (hasError && !cancelled && searchWindowVisible) {
        scheduleNext(POLL_ERROR_RETRY_MS);
      }
    };

    const handleSearchWindowHidden = () => {
      searchWindowVisible = false;
      if (timerId != null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    const handleSearchWindowOpened = () => {
      if (cancelled) return;
      searchWindowVisible = true;
      if (timerId != null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      void poll();
    };

    window.ipcRenderer?.on(IPC_EVENT_SEARCH_WINDOW_HIDDEN, handleSearchWindowHidden);
    window.ipcRenderer?.on(IPC_EVENT_SEARCH_WINDOW_OPENED, handleSearchWindowOpened);
    void poll();

    return () => {
      cancelled = true;
      if (timerId != null) window.clearTimeout(timerId);
      window.ipcRenderer?.off(IPC_EVENT_SEARCH_WINDOW_HIDDEN, handleSearchWindowHidden);
      window.ipcRenderer?.off(IPC_EVENT_SEARCH_WINDOW_OPENED, handleSearchWindowOpened);
    };
  }, []);

  useEffect(() => {
    if (params.searchingIndicatorTimerRef.current != null) {
      window.clearTimeout(params.searchingIndicatorTimerRef.current);
      params.searchingIndicatorTimerRef.current = null;
    }
    if (!params.isSearching) {
      params.setShowSearchingIndicator(false);
      return;
    }
    params.setShowSearchingIndicator(false);
    params.searchingIndicatorTimerRef.current = window.setTimeout(() => {
      params.setShowSearchingIndicator(true);
      params.searchingIndicatorTimerRef.current = null;
    }, params.SEARCH_STATUS_DELAY_MS);
    return () => {
      if (params.searchingIndicatorTimerRef.current != null) {
        window.clearTimeout(params.searchingIndicatorTimerRef.current);
        params.searchingIndicatorTimerRef.current = null;
      }
    };
  }, [params.isSearching]);

  useEffect(() => {
    params.queryRef.current = params.query;
  }, [params.query]);

  useEffect(() => {
    params.searchTypeIdRef.current = params.searchTypeId;
  }, [params.searchTypeId]);

  useEffect(() => {
    params.isPanelPinnedRef.current = params.isPanelPinned;
    params.syncBlurHideByPinnedState(params.isPanelPinned);
  }, [params.isPanelPinned, params.syncBlurHideByPinnedState]);

  useEffect(() => {
    params.selectedPathRef.current = params.results[params.selectedIndex]?.path || "";
  }, [params.results, params.selectedIndex]);

  useEffect(() => {
    if (params.preserveGhostSuggestionRef.current) return;
    params.setGhostInputValue("");
  }, [params.query, params.searchTypeId]);

  useEffect(() => {
    if (params.results.length > 0) return;
    params.setGhostInputValue("");
  }, [params.results.length]);

  useEffect(() => {
    if (params.preserveGhostSuggestionRef.current) {
      const inputLower = params.inputValue.toLocaleLowerCase();
      const ghostLower = params.ghostInputValue.toLocaleLowerCase();
      if (ghostLower.startsWith(inputLower) && params.ghostInputValue.length > params.inputValue.length) return;
      params.preserveGhostSuggestionRef.current = false;
    }
    if (!params.inputValue || params.results.length === 0) {
      params.setGhostInputValue("");
      return;
    }
    if (params.lastSelectedBy === "keyboard" && params.selectedIndex > 0) return;
    const firstName = typeof params.results[0]?.name === "string" ? params.results[0].name : "";
    const nextGhostValue = params.resolveGhostCandidateByInput(params.inputValue, firstName);
    if (!nextGhostValue) {
      params.setGhostInputValue("");
      return;
    }
    params.setGhostInputValue(nextGhostValue);
  }, [params.inputValue, params.results, params.lastSelectedBy, params.selectedIndex]);

  useEffect(() => {
    if (params.results.length === 0) return;
    if (params.selectedIndex < 0) {
      params.setSelectedIndex(0);
      return;
    }
    if (params.selectedIndex > params.results.length - 1) {
      params.setSelectedIndex(params.results.length - 1);
    }
  }, [params.results.length, params.selectedIndex]);

  useEffect(() => {
    let mounted = true;
    const applyPayload = (payload?: { results?: unknown }) => {
      const records = params.normalizeCalcHistoryPayload(payload?.results);
      params.calcHistoryItemsRef.current = params.mapCalcHistoryToItems(records);
      if (!mounted) return;
      const queryMode = params.parseCalcMode(params.queryRef.current);
      if (!queryMode.isCalcMode) return;
      params.applyCalcResults(params.calcItemRef.current, params.selectedPathRef.current);
    };

    void window.ipcRenderer
      ?.invoke(IPC_GET_CALC_HISTORY)
      .then((resp) => {
        applyPayload(normalizeCalcHistoryResponse(resp));
      })
      .catch(() => {});

    const handleCalcHistoryUpdated = (_event: unknown, payload?: { results?: unknown }) => {
      applyPayload(payload);
    };
    window.ipcRenderer?.on<[payload?: { results?: unknown }]>(IPC_EVENT_CALC_HISTORY_UPDATED, handleCalcHistoryUpdated);
    return () => {
      mounted = false;
      window.ipcRenderer?.off<[payload?: { results?: unknown }]>(IPC_EVENT_CALC_HISTORY_UPDATED, handleCalcHistoryUpdated);
    };
  }, [params.applyCalcResults]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (params.typeSelectRef.current && !params.typeSelectRef.current.contains(event.target as Node)) {
        params.setTypeMenuOpen(false);
      }
    };
    if (params.typeMenuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [params.typeMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    void window.ipcRenderer
      ?.invoke(IPC_GET_RESULT_ICON, { type: "calc", name: "计算器", path: "" })
      .then((icon) => {
        if (cancelled) return;
        if (typeof icon !== "string") return;
        const normalized = icon.trim();
        if (!normalized) return;
        params.setCalculatorIconDataUrl(normalized);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const valid = params.enabledSearchTypeOptions.some((option) => option.id === params.searchTypeId);
    if (!valid) params.setSearchTypeId(params.settings.defaultSearchTypeId || "all");
  }, [params.searchTypeId, params.enabledSearchTypeOptions, params.settings.defaultSearchTypeId]);

  useEffect(() => {
    params.inputRef.current?.focus();
    const handleReset = async () => {
      void refreshUserStatusSilently();
      params.lastResizePayloadRef.current = null;
      if (params.settings.keepStateOnClose) {
        setTimeout(() => {
          params.inputRef.current?.focus();
          params.notifySearchViewReady();
        }, 50);
        return;
      }
      const nextTypeId = params.settings.defaultSearchTypeId || "all";
      params.setSearchTypeId(nextTypeId);
      params.setQueryAndInputValue("");
      params.applyHistoryResults(params.historyItemsRef.current, { typeId: nextTypeId });
      params.syncWindowHeight({ includeTypeMenu: false });
      setTimeout(() => {
        params.inputRef.current?.focus();
        params.notifySearchViewReady();
      }, 50);
    };
    window.ipcRenderer?.on(IPC_EVENT_RESET_SEARCH, handleReset);
    return () => {
      window.ipcRenderer?.off(IPC_EVENT_RESET_SEARCH, handleReset);
    };
  }, [params.settings, params.syncWindowHeight, params.notifySearchViewReady]);

  useEffect(() => {
    const handler = () => {
      params.setTypeMenuOpen(false);
      params.lastResizePayloadRef.current = null;
    };
    window.ipcRenderer?.on(IPC_EVENT_SEARCH_WINDOW_HIDDEN, handler);
    return () => {
      window.ipcRenderer?.off(IPC_EVENT_SEARCH_WINDOW_HIDDEN, handler);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      void refreshUserStatusSilently();
      params.inputRef.current?.focus();
      params.notifySearchViewReady();
      params.lastResizePayloadRef.current = null;
      const queryMode = params.parseCalcMode(params.queryRef.current);
      const refreshPromise = queryMode.isCalcMode
        ? Promise.resolve(params.applyCalcResults(params.calcItemRef.current, params.selectedPathRef.current))
        : params.queryRef.current.trim().length === 0
          ? params.refreshHistory({
              typeId: params.searchTypeIdRef.current,
              preserveSelectedPath: params.selectedPathRef.current,
            })
          : Promise.resolve();
      void refreshPromise.finally(() => {
        params.syncWindowHeight({ includeTypeMenu: true });
      });
    };
    window.ipcRenderer?.on(IPC_EVENT_SEARCH_WINDOW_OPENED, handler);
    return () => {
      window.ipcRenderer?.off(IPC_EVENT_SEARCH_WINDOW_OPENED, handler);
    };
  }, [params.syncWindowHeight, params.applyCalcResults, params.notifySearchViewReady]);

  useEffect(() => {
    const list = params.listRef.current;
    if (!list || params.lastSelectedBy !== "keyboard") return;
    if (typeof list.scrollToItem === "function") {
      const align: ListAlign =
        params.results.length > 0 && params.selectedIndex >= params.results.length - 1
          ? "end"
          : params.selectedIndex <= 0
            ? "start"
            : "smart";
      list.scrollToItem(params.selectedIndex, align);
      return;
    }
    if (typeof list.scrollToRow === "function") {
      list.scrollToRow({ index: params.selectedIndex, align: "auto" });
    }
  }, [params.selectedIndex, params.lastSelectedBy]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        params.hideWindow();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);
}
