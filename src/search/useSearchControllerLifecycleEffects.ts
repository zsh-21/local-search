import { useEffect } from "react";
import { refreshUserStatusSilently } from "../membership";
import { loadBootstrapState, setBootstrapHistoryCache } from "../settingsStore";

export function useSearchControllerLifecycleEffects(params: any) {
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
      params.historyItemsRef.current = Array.isArray(snapshot.history) ? snapshot.history : [];
      setBootstrapHistoryCache(params.historyItemsRef.current);

      if (!params.bootstrapTypeSyncedRef.current && params.loaded) {
        const nextTypeId = snapshot.settings.defaultSearchTypeId || "all";
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

    const handleHistoryUpdated = (_event: any, payload?: { results?: any[] }) => {
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

    window.ipcRenderer?.on("history-updated", handleHistoryUpdated as any);
    return () => {
      mounted = false;
      window.ipcRenderer?.off("history-updated", handleHistoryUpdated as any);
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
    /** 轮询取消标记 */
    let cancelled = false;
    /** 当前轮询定时器句柄 */
    let timerId: number | null = null;
    /** 搜索窗口可见状态 */
    let searchWindowVisible = true;
    /** 稳态索引状态 */
    let stableIsIndexing = false;
    /** 连续非索引计数 */
    let falseStreak = 0;
    /** 索引中的快速轮询频率：保证进度条与状态变化反馈及时 */
    const POLL_FAST_INDEXING_MS = 500;
    /** 稳定空闲时的降频轮询：减少无收益 IPC 调用 */
    const POLL_IDLE_MS = 5000;
    /** 失败重试间隔：避免异常场景高频重试 */
    const POLL_ERROR_RETRY_MS = 3000;
    const FALSE_STREAK_THRESHOLD = 3;
    /** 统一下一次调度入口，避免重复 setTimeout 泄漏 */
    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      if (!searchWindowVisible) return;
      if (timerId != null) {
        window.clearTimeout(timerId);
      }
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
      /** 本轮拉取是否出错 */
      let hasError = false;
      try {
        const resp = (await window.ipcRenderer.invoke("get-index-progress")) as
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
          params.setIndexProgress((prev: number) => (prev === normalized ? prev : normalized));
        } else {
          if (!stableIsIndexing) {
            params.setIsIndexing(false);
            params.setIndexProgress((prev: number) => (prev === 0 ? prev : 0));
          } else {
            falseStreak += 1;
            if (falseStreak >= FALSE_STREAK_THRESHOLD) {
              stableIsIndexing = false;
              falseStreak = 0;
              params.setIsIndexing(false);
              params.setIndexProgress(0);
            }
          }
        }
        const nextDelayMs =
          isIndexing || stableIsIndexing ? POLL_FAST_INDEXING_MS : POLL_IDLE_MS;
        scheduleNext(nextDelayMs);
      } catch {
        hasError = true;
      }
      if (hasError && !cancelled && searchWindowVisible) {
        scheduleNext(POLL_ERROR_RETRY_MS);
      }
    };


    /** 搜索窗口隐藏时暂停轮询，避免后台无意义拉取 */
    const handleSearchWindowHidden = () => {
      searchWindowVisible = false;
      if (timerId != null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    /** 搜索窗口重新打开时立即恢复轮询，避免首屏状态滞后 */
    const handleSearchWindowOpened = () => {
      if (cancelled) return;
      searchWindowVisible = true;
      if (timerId != null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      void poll();
    };

    window.ipcRenderer?.on("search-window-hidden", handleSearchWindowHidden as any);
    window.ipcRenderer?.on("search-window-opened", handleSearchWindowOpened as any);
    void poll();
    return () => {
      cancelled = true;
      if (timerId != null) window.clearTimeout(timerId);
      window.ipcRenderer?.off("search-window-hidden", handleSearchWindowHidden as any);
      window.ipcRenderer?.off("search-window-opened", handleSearchWindowOpened as any);
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
      if (
        ghostLower.startsWith(inputLower) &&
        params.ghostInputValue.length > params.inputValue.length
      ) {
        return;
      }
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
      const { isCalcMode } = params.parseCalcMode(params.queryRef.current);
      if (!isCalcMode) return;
      params.applyCalcResults(params.calcItemRef.current, params.selectedPathRef.current);
    };

    void window.ipcRenderer
      ?.invoke("get-calc-history")
      .then((resp: any) => {
        applyPayload(resp as { results?: unknown });
      })
      .catch(() => {});

    const handleCalcHistoryUpdated = (_event: any, payload?: { results?: unknown }) => {
      applyPayload(payload);
    };
    window.ipcRenderer?.on("calc-history-updated", handleCalcHistoryUpdated as any);
    return () => {
      mounted = false;
      window.ipcRenderer?.off("calc-history-updated", handleCalcHistoryUpdated as any);
    };
  }, [params.applyCalcResults]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (params.typeSelectRef.current && !params.typeSelectRef.current.contains(e.target as Node)) {
        params.setTypeMenuOpen(false);
      }
    };
    if (params.typeMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [params.typeMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    void window.ipcRenderer
      ?.invoke("get-result-icon", { type: "calc", name: "计算器", path: "" })
      .then((icon: unknown) => {
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
    const valid = params.enabledSearchTypeOptions.some((t: any) => t.id === params.searchTypeId);
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
    window.ipcRenderer?.on("reset-search", handleReset);
    return () => {
      window.ipcRenderer?.off("reset-search", handleReset as any);
    };
  }, [params.settings, params.syncWindowHeight, params.notifySearchViewReady]);

  useEffect(() => {
    const handler = () => {
      params.setTypeMenuOpen(false);
      params.lastResizePayloadRef.current = null;
    };
    window.ipcRenderer?.on("search-window-hidden", handler as any);
    return () => {
      window.ipcRenderer?.off("search-window-hidden", handler as any);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      void refreshUserStatusSilently();
      params.inputRef.current?.focus();
      params.notifySearchViewReady();
      params.lastResizePayloadRef.current = null;
      const queryMode = params.parseCalcMode(params.queryRef.current);
      const p = queryMode.isCalcMode
        ? Promise.resolve(params.applyCalcResults(params.calcItemRef.current, params.selectedPathRef.current))
        : params.queryRef.current.trim().length === 0
          ? params.refreshHistory({
              typeId: params.searchTypeIdRef.current,
              preserveSelectedPath: params.selectedPathRef.current,
            })
          : Promise.resolve();
      void p.finally(() => {
        params.syncWindowHeight({ includeTypeMenu: true });
      });
    };
    window.ipcRenderer?.on("search-window-opened", handler as any);
    return () => {
      window.ipcRenderer?.off("search-window-opened", handler as any);
    };
  }, [params.syncWindowHeight, params.applyCalcResults, params.notifySearchViewReady]);

  useEffect(() => {
    if (params.listRef.current && params.lastSelectedBy === "keyboard") {
      if (typeof params.listRef.current.scrollToItem === "function") {
        const align =
          params.results.length > 0 && params.selectedIndex >= params.results.length - 1
            ? "end"
            : params.selectedIndex <= 0
              ? "start"
              : "smart";
        params.listRef.current.scrollToItem(params.selectedIndex, align);
      } else if (typeof params.listRef.current.scrollToRow === "function") {
        params.listRef.current.scrollToRow({ index: params.selectedIndex, align: "auto" });
      }
    }
  }, [params.selectedIndex, params.lastSelectedBy]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        params.hideWindow();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);
}
