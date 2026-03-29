import { startTransition, useEffect, useRef, type MutableRefObject } from "react";
import type { AppItem } from "../appTypes";
import { dedupeResults, mergeByServerOrder, mergeResultsStable } from "./searchResultUtils";
import { SearchScoreDebugLogger } from "./searchScoreDebugLogger";
import type { SearchScoreDebugRow } from "../../shared/types/searchScoreDebug";
import {
  IPC_EVENT_ICONS_UPDATED,
  IPC_EVENT_MORE_RESULTS,
  IPC_GET_ICONS_BY_KEYS,
  IPC_SEARCH_FILES,
} from "../../shared/ipc/channels";

/** 盘符前缀解析结果 */
type DrivePrefixResult = {
  term: string;
  drive: string;
};

/** 计算模式解析结果 */
type CalcModeResult = {
  isCalcMode: boolean;
  expression: string;
};

/** 数值状态更新函数 */
type NumberStateSetter = (value: number | ((prev: number) => number)) => void;

/** 布尔状态更新函数 */
type BooleanStateSetter = (value: boolean | ((prev: boolean) => boolean)) => void;

/** 搜索结果数组状态更新函数 */
type AppItemListSetter = (value: AppItem[] | ((prev: AppItem[]) => AppItem[])) => void;

/** 图标映射状态更新函数 */
type IconMapSetter = (
  value: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
) => void;

/** 分批搜索结果事件载荷 */
type MoreResultsPayload = {
  query?: string;
  searchTypeId?: string;
  searchSessionId?: string;
  results?: AppItem[];
  scoreDebugRows?: SearchScoreDebugRow[];
};

/** 图标更新事件载荷 */
type IconsUpdatedPayload = {
  query?: string;
  searchTypeId?: string;
  searchSessionId?: string;
  keys?: string[];
};

/** IPC 搜索返回结构 */
type SearchFilesResponse = {
  results?: AppItem[];
  isIndexing?: boolean;
  hasMore?: boolean;
  scoreDebugRows?: SearchScoreDebugRow[];
};

/** 搜索控制器搜索副作用参数 */
type SearchControllerSearchEffectsParams = {
  query: string;
  searchTypeId: string;
  isIndexing: boolean;
  isSearching: boolean;
  hasMore: boolean;
  results: AppItem[];
  buildCalcItem: (queryTerm: string) => AppItem | null;
  parseCalcMode: (rawQuery: string) => CalcModeResult;
  parseDrivePrefix: (raw: string) => DrivePrefixResult;
  queryRef: MutableRefObject<string>;
  searchTypeIdRef: MutableRefObject<string>;
  selectedPathRef: MutableRefObject<string>;
  calcItemRef: MutableRefObject<AppItem | null>;
  searchRequestIdRef: MutableRefObject<number>;
  searchSessionIdRef: MutableRefObject<string>;
  typeSwitchRequestedRef: MutableRefObject<boolean>;
  pendingAppendRef: MutableRefObject<AppItem[]>;
  flushAppendTimerRef: MutableRefObject<number | null>;
  setResults: AppItemListSetter;
  setTotalCount: NumberStateSetter;
  setIsSearching: BooleanStateSetter;
  setIsIndexing: BooleanStateSetter;
  setHasMore: BooleanStateSetter;
  setHoveredKey: (value: string) => void;
  setSelectedIndex: NumberStateSetter;
  refreshHistory: () => Promise<void> | void;
  filterItemsBySearchType: (items: AppItem[], typeId: string) => AppItem[];
  iconByKeyRef: MutableRefObject<Record<string, string>>;
  setIconByKey: IconMapSetter;
  applyCalcResults: (currentCalcItem: AppItem | null, preservePath?: string) => void;
  MAX_PENDING_APPEND_ITEMS: number;
  SEARCH_DEBOUNCE_INDEXING_MS: number;
  SEARCH_DEBOUNCE_READY_MS: number;
};

/** 归一化 IPC 搜索返回，避免运行期空值干扰 */
function normalizeSearchFilesResponse(raw: unknown): SearchFilesResponse {
  if (!raw || typeof raw !== "object") return {};
  return raw as SearchFilesResponse;
}

export function useSearchControllerSearchEffects(params: SearchControllerSearchEffectsParams) {
  const scoreDebugLoggerRef = useRef<SearchScoreDebugLogger>(new SearchScoreDebugLogger(1000));

  const mergeScoreDebugRows = (rows: SearchScoreDebugRow[] | undefined) => {
    scoreDebugLoggerRef.current.mergeRows(rows);
  };

  const mergeIconMap = (next: Record<string, string>) => {
    if (!next || typeof next !== "object") return;
    params.setIconByKey((prev) => {
      const merged = { ...(prev || {}) };
      let changed = false;
      for (const [key, value] of Object.entries(next)) {
        if (!key || typeof value !== "string" || !value) continue;
        if (merged[key] === value) continue;
        merged[key] = value;
        changed = true;
      }
      if (!changed) return prev;
      params.iconByKeyRef.current = merged;
      return merged;
    });
  };

  const requestIconsByKeys = async (keys: string[]) => {
    if (!window.ipcRenderer) return;
    const normalized = Array.from(
      new Set(
        (keys || [])
          .map((key) => (typeof key === "string" ? key.trim().toLowerCase() : ""))
          .filter(Boolean),
      ),
    ).slice(0, 180);
    if (normalized.length <= 0) return;
    const resp = await window.ipcRenderer.invoke(IPC_GET_ICONS_BY_KEYS, {
      keys: normalized,
      cacheOnly: false,
      max: normalized.length,
    });
    if (!resp || typeof resp !== "object") return;
    mergeIconMap(resp as Record<string, string>);
  };

  const requestIconsForItems = (items: AppItem[]) => {
    const known = params.iconByKeyRef.current || {};
    const keys = (items || [])
      .map((item) => (typeof item?.iconKey === "string" ? item.iconKey.trim().toLowerCase() : ""))
      .filter((key) => key && !known[key]);
    if (keys.length <= 0) return;
    void requestIconsByKeys(keys);
  };

  const clearFlushAppendTimer = () => {
    if (params.flushAppendTimerRef.current != null) {
      window.clearTimeout(params.flushAppendTimerRef.current);
      params.flushAppendTimerRef.current = null;
    }
  };

  const resetPendingAppends = () => {
    params.pendingAppendRef.current = [];
    clearFlushAppendTimer();
  };

  const flushPendingAppends = () => {
    clearFlushAppendTimer();
    const batch = params.pendingAppendRef.current;
    if (!batch || batch.length === 0) return;
    resetPendingAppends();
    startTransition(() => {
      params.setResults((prev) => {
        const next = mergeResultsStable(prev, batch);
        params.setTotalCount(next.length);
        return next;
      });
    });
  };

  useEffect(() => {
    const handler = (_event: unknown, payload?: MoreResultsPayload) => {
      const currentQuery = params.parseDrivePrefix(params.queryRef.current).term;
      const currentTypeId = params.searchTypeIdRef.current;
      const currentSessionId = params.searchSessionIdRef.current;
      const payloadQuery = typeof payload?.query === "string" ? payload.query : "";
      const payloadTypeId = typeof payload?.searchTypeId === "string" ? payload.searchTypeId : "";
      const payloadSessionId = typeof payload?.searchSessionId === "string" ? payload.searchSessionId : "";
      if (!currentQuery) return;
      if (!currentSessionId) return;
      if (payloadQuery !== currentQuery) return;
      if (payloadTypeId !== currentTypeId) return;
      if (payloadSessionId !== currentSessionId) return;
      mergeScoreDebugRows(payload?.scoreDebugRows);

      const strictMore = params.filterItemsBySearchType(
        Array.isArray(payload?.results) ? payload.results : [],
        currentTypeId,
      );
      if (strictMore.length <= 0) return;
      const hadPending = params.pendingAppendRef.current.length > 0;
      params.pendingAppendRef.current.push(...strictMore);
      if (params.pendingAppendRef.current.length > params.MAX_PENDING_APPEND_ITEMS) {
        params.pendingAppendRef.current.length = params.MAX_PENDING_APPEND_ITEMS;
      }
      if (!hadPending) {
        flushPendingAppends();
        return;
      }
      if (params.flushAppendTimerRef.current == null) {
        params.flushAppendTimerRef.current = window.setTimeout(() => flushPendingAppends(), 24);
      }
    };
    window.ipcRenderer?.on<[payload?: MoreResultsPayload]>(IPC_EVENT_MORE_RESULTS, handler);
    return () => {
      flushPendingAppends();
      window.ipcRenderer?.off<[payload?: MoreResultsPayload]>(IPC_EVENT_MORE_RESULTS, handler);
    };
  }, []);

  useEffect(() => {
    return () => {
      scoreDebugLoggerRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    requestIconsForItems(Array.isArray(params.results) ? params.results : []);
  }, [params.results]);

  useEffect(() => {
    const handler = (_event: unknown, payload?: IconsUpdatedPayload) => {
      const currentQuery = params.parseDrivePrefix(params.queryRef.current).term;
      const currentTypeId = params.searchTypeIdRef.current;
      const currentSessionId = params.searchSessionIdRef.current;
      if (!currentQuery || !currentTypeId || !currentSessionId) return;
      if ((payload?.query || "") !== currentQuery) return;
      if ((payload?.searchTypeId || "") !== currentTypeId) return;
      if ((payload?.searchSessionId || "") !== currentSessionId) return;
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      if (keys.length <= 0) return;
      void requestIconsByKeys(keys);
    };
    window.ipcRenderer?.on<[payload?: IconsUpdatedPayload]>(IPC_EVENT_ICONS_UPDATED, handler);
    return () => {
      window.ipcRenderer?.off<[payload?: IconsUpdatedPayload]>(IPC_EVENT_ICONS_UPDATED, handler);
    };
  }, []);

  useEffect(() => {
    const { term, drive } = params.parseDrivePrefix(params.query);
    const trimmed = term.trim();
    const calcMode = params.parseCalcMode(trimmed);
    params.calcItemRef.current = params.buildCalcItem(trimmed);
    if (calcMode.isCalcMode) {
      params.searchRequestIdRef.current += 1;
      params.searchSessionIdRef.current = "";
      params.typeSwitchRequestedRef.current = false;
      resetPendingAppends();
      params.applyCalcResults(params.calcItemRef.current, params.selectedPathRef.current);
      return;
    }
    if (!trimmed || trimmed.length < 1) {
      params.searchRequestIdRef.current += 1;
      if (trimmed.length === 0) {
        void params.refreshHistory();
      } else {
        params.setResults([]);
        params.setTotalCount(0);
        params.setIsSearching(false);
        params.setHasMore(false);
      }
      return;
    }

    params.searchRequestIdRef.current += 1;
    const requestId = params.searchRequestIdRef.current;
    const searchSessionId = `${Date.now()}-${requestId}`;
    params.searchSessionIdRef.current = searchSessionId;
    params.setHasMore(false);
    params.setTotalCount(0);
    params.setHoveredKey("");
    resetPendingAppends();
    const delay = params.typeSwitchRequestedRef.current
      ? 0
      : params.isIndexing
        ? params.SEARCH_DEBOUNCE_INDEXING_MS
        : params.SEARCH_DEBOUNCE_READY_MS;
    params.typeSwitchRequestedRef.current = false;
    const timer = setTimeout(async () => {
      if (params.searchRequestIdRef.current !== requestId) return;
      params.setIsSearching(true);
      try {
        const resp = normalizeSearchFilesResponse(
          await window.ipcRenderer?.invoke(IPC_SEARCH_FILES, trimmed, {
            searchTypeId: params.searchTypeId,
            searchSessionId,
            drive,
          }),
        );
        if (params.searchRequestIdRef.current !== requestId) return;
        if (params.parseDrivePrefix(params.queryRef.current).term !== trimmed) return;
        if (params.searchTypeIdRef.current !== params.searchTypeId) return;
        mergeScoreDebugRows(resp.scoreDebugRows);
        const strictMatched = params.filterItemsBySearchType(resp.results ?? [], params.searchTypeId);
        const serverOrdered = dedupeResults(strictMatched);
        params.setSelectedIndex(0);
        startTransition(() => {
          params.setResults((prev) => {
            const replaced = mergeByServerOrder(prev, serverOrdered, serverOrdered.length);
            params.setTotalCount((count) => (count === replaced.length ? count : replaced.length));
            return replaced;
          });
          const nextHasMore = Boolean(resp.hasMore);
          params.setHasMore((value) => (value === nextHasMore ? value : nextHasMore));
        });
      } finally {
        if (params.searchRequestIdRef.current === requestId) params.setIsSearching(false);
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [params.query, params.searchTypeId, params.isIndexing, params.applyCalcResults]);

  useEffect(() => {
    const trimmed = params.parseDrivePrefix(params.query).term;
    if (params.parseCalcMode(trimmed).isCalcMode) return;
    if (!trimmed || trimmed.length < 1) return;
    if (!params.isIndexing) return;
    if (params.isSearching) return;

    let cancelled = false;
    const refreshOnce = async () => {
      if (cancelled) return;
      if (!window.ipcRenderer) return;
      if (!params.isIndexing) return;
      if (params.isSearching) return;

      const currentQuery = params.parseDrivePrefix(params.queryRef.current).term;
      if (currentQuery !== trimmed) return;

      const currentTypeId = params.searchTypeIdRef.current;
      const currentSessionId = params.searchSessionIdRef.current;
      if (!currentSessionId) return;
      const currentDrive = params.parseDrivePrefix(params.queryRef.current).drive;
      try {
        const resp = normalizeSearchFilesResponse(
          await window.ipcRenderer.invoke(IPC_SEARCH_FILES, trimmed, {
            searchTypeId: currentTypeId,
            searchSessionId: currentSessionId,
            drive: currentDrive,
          }),
        );

        if (cancelled) return;
        if (params.parseDrivePrefix(params.queryRef.current).term !== trimmed) return;
        if (params.searchTypeIdRef.current !== currentTypeId) return;
        mergeScoreDebugRows(resp.scoreDebugRows);

        const strictMatched = params.filterItemsBySearchType(resp.results ?? [], currentTypeId);
        const serverOrdered = dedupeResults(strictMatched);
        startTransition(() => {
          params.setResults((prev) => {
            const merged = mergeResultsStable(prev, serverOrdered);
            params.setTotalCount((count) => (count === merged.length ? count : merged.length));
            return merged;
          });
          params.setHasMore((value) => value || Boolean(resp.hasMore));
        });
      } catch {}
    };

    const timerId = window.setTimeout(() => {
      void refreshOnce();
    }, 800);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [params.query, params.isIndexing, params.isSearching]);

  useEffect(() => {
    scoreDebugLoggerRef.current.schedule({
      sessionId: params.searchSessionIdRef.current || "",
      query: params.parseDrivePrefix(params.queryRef.current).term,
      searchTypeId: params.searchTypeIdRef.current || params.searchTypeId,
      isSearching: Boolean(params.isSearching),
      hasMore: Boolean(params.hasMore),
      results: Array.isArray(params.results) ? params.results : [],
    });
  }, [params.results, params.isSearching, params.hasMore, params.query, params.searchTypeId]);
}
