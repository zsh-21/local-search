import { startTransition, useEffect, useRef } from "react";
import { dedupeResults, mergeByServerOrder, mergeResultsStable } from "./searchResultUtils";
import { SearchScoreDebugLogger } from "./searchScoreDebugLogger";
import type { SearchScoreDebugRow } from "../../shared/searchScoreDebug";

export function useSearchControllerSearchEffects(params: any) {
  const scoreDebugLoggerRef = useRef<SearchScoreDebugLogger>(new SearchScoreDebugLogger(1000));

  const mergeScoreDebugRows = (rows: SearchScoreDebugRow[] | undefined) => {
    scoreDebugLoggerRef.current.mergeRows(rows);
  };

  const mergeIconMap = (next: Record<string, string>) => {
    if (!next || typeof next !== "object") return;
    params.setIconByKey((prev: Record<string, string>) => {
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
          .map((k) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
          .filter(Boolean),
      ),
    ).slice(0, 180);
    if (normalized.length <= 0) return;
    const resp = (await window.ipcRenderer.invoke("get-icons-by-keys", {
      keys: normalized,
      cacheOnly: false,
      max: normalized.length,
    })) as Record<string, string> | undefined;
    if (!resp || typeof resp !== "object") return;
    mergeIconMap(resp);
  };

  const requestIconsForItems = (items: any[]) => {
    const known = params.iconByKeyRef.current || {};
    const keys = (items || [])
      .map((it) => (typeof it?.iconKey === "string" ? it.iconKey.trim().toLowerCase() : ""))
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
      params.setResults((prev: any[]) => {
        const next = mergeResultsStable(prev, batch);
        params.setTotalCount(next.length);
        return next;
      });
    });
  };

  useEffect(() => {
    const handler = (_event: any, payload: { query: string; results: any[]; scoreDebugRows?: SearchScoreDebugRow[] }) => {
      const currentQuery = params.parseDrivePrefix(params.queryRef.current).term;
      const currentTypeId = params.searchTypeIdRef.current;
      const currentSessionId = params.searchSessionIdRef.current;
      const payloadQuery = typeof payload?.query === "string" ? payload.query : "";
      const payloadTypeId =
        typeof (payload as any)?.searchTypeId === "string" ? (payload as any).searchTypeId : "";
      const payloadSessionId =
        typeof (payload as any)?.searchSessionId === "string" ? (payload as any).searchSessionId : "";
      if (!currentQuery) return;
      if (!currentSessionId) return;
      if (payloadQuery !== currentQuery) return;
      if (payloadTypeId !== currentTypeId) return;
      if (payloadSessionId !== currentSessionId) return;
      mergeScoreDebugRows(payload?.scoreDebugRows);

      const filteredMore = params.filterItemsBySearchType(payload.results, currentTypeId);
      const strictMore = params.applyStrictSearchResults(filteredMore, currentQuery);
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
    window.ipcRenderer?.on("more-results", handler);
    return () => {
      flushPendingAppends();
      window.ipcRenderer?.off("more-results", handler);
    };
  }, []);

  useEffect(() => {
    return () => {
      scoreDebugLoggerRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    requestIconsForItems(params.results || []);
  }, [params.results]);

  useEffect(() => {
    const handler = (_event: any, payload: { query?: string; searchTypeId?: string; searchSessionId?: string; keys?: string[] }) => {
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
    window.ipcRenderer?.on("icons-updated", handler);
    return () => {
      window.ipcRenderer?.off("icons-updated", handler);
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
        params.refreshHistory();
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
        const resp = (await window.ipcRenderer?.invoke("search-files", trimmed, {
          searchTypeId: params.searchTypeId,
          searchSessionId,
          drive,
        })) as { results?: any[]; isIndexing?: boolean; hasMore?: boolean; scoreDebugRows?: SearchScoreDebugRow[] } | undefined;
        if (params.searchRequestIdRef.current !== requestId) return;
        if (params.parseDrivePrefix(params.queryRef.current).term !== trimmed) return;
        if (params.searchTypeIdRef.current !== params.searchTypeId) return;
        mergeScoreDebugRows(resp?.scoreDebugRows);
        const nextResults = params.filterItemsBySearchType(resp?.results ?? [], params.searchTypeId);
        const strictMatched = params.applyStrictSearchResults(nextResults, trimmed);
        const serverOrdered = dedupeResults(strictMatched);
        params.setSelectedIndex(0);
        startTransition(() => {
          params.setResults((prev: any[]) => {
            const replaced = mergeByServerOrder(prev, serverOrdered, serverOrdered.length);
            params.setTotalCount((count: number) => (count === replaced.length ? count : replaced.length));
            return replaced;
          });
          const nextHasMore = Boolean(resp?.hasMore);
          params.setHasMore((v: boolean) => (v === nextHasMore ? v : nextHasMore));
        });
      } finally {
        if (params.searchRequestIdRef.current === requestId) params.setIsSearching(false);
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [
    params.query,
    params.searchTypeId,
    params.isIndexing,
    params.applyCalcResults,
    params.applyStrictSearchResults,
  ]);

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
        const resp = (await window.ipcRenderer.invoke("search-files", trimmed, {
          searchTypeId: currentTypeId,
          searchSessionId: currentSessionId,
          drive: currentDrive,
        })) as { results?: any[]; isIndexing?: boolean; hasMore?: boolean; scoreDebugRows?: SearchScoreDebugRow[] } | undefined;

        if (cancelled) return;
        if (params.parseDrivePrefix(params.queryRef.current).term !== trimmed) return;
        if (params.searchTypeIdRef.current !== currentTypeId) return;
        mergeScoreDebugRows(resp?.scoreDebugRows);

        const nextResults = params.filterItemsBySearchType(resp?.results ?? [], currentTypeId);
        const strictMatched = params.applyStrictSearchResults(nextResults, trimmed);
        const serverOrdered = dedupeResults(strictMatched);
        startTransition(() => {
          params.setResults((prev: any[]) => {
            const merged = mergeResultsStable(prev, serverOrdered);
            params.setTotalCount((count: number) => (count === merged.length ? count : merged.length));
            return merged;
          });
          params.setHasMore((v: boolean) => v || Boolean(resp?.hasMore));
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
  }, [params.query, params.isIndexing, params.isSearching, params.applyStrictSearchResults]);

  useEffect(() => {
    scoreDebugLoggerRef.current.schedule({
      sessionId: typeof params.searchSessionIdRef?.current === "string" ? params.searchSessionIdRef.current : "",
      query: params.parseDrivePrefix(params.queryRef.current).term,
      searchTypeId: typeof params.searchTypeIdRef?.current === "string" ? params.searchTypeIdRef.current : params.searchTypeId,
      isSearching: Boolean(params.isSearching),
      hasMore: Boolean(params.hasMore),
      results: Array.isArray(params.results) ? params.results : [],
    });
  }, [params.results, params.isSearching, params.hasMore, params.query, params.searchTypeId]);
}
