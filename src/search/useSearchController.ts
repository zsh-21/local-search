import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppItem, AppSettings, SearchResponse } from "../appTypes";
import { refreshUserStatusSilently } from "../membership";
import { getBootstrapHistoryCache, getSearchTypeOptions, loadBootstrapState, setBootstrapHistoryCache, useSettings } from "../settingsStore";
import {
  DEFAULT_SETTINGS,
  SEARCH_ITEM_HEIGHT_COMPACT,
  SEARCH_ITEM_HEIGHT_NORMAL,
  SEARCH_LIST_MIN_HEIGHT,
  SEARCH_WINDOW_BOTTOM_BAR_HEIGHT,
  SEARCH_WINDOW_MIN_HEIGHT,
  SEARCH_WINDOW_TOP_BAR_HEIGHT,
  TYPE_MENU_MIN_LIST_SPACE,
} from "../constants/initialValues";
import {
  dedupeResults,
  filterItemsBySearchType as filterItemsBySearchTypeUtil,
  limitResults as limitResultsUtil,
  mergeResultsStable,
} from "./searchResultUtils";

type RefreshHistoryOpts = { typeId?: string; preserveSelectedPath?: string };
type CalcHistoryRecord = { expression: string; result: string; lastUsed: number };

const CALC_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};
const SEARCH_STATUS_DELAY_MS = 120;
const SEARCH_DEBOUNCE_READY_MS = 0;
const SEARCH_DEBOUNCE_INDEXING_MS = 120;

function ensureArity(name: string, args: number[], min: number, max = min) {
  if (args.length < min || args.length > max) {
    throw new Error(`Function ${name} expects ${min}${min === max ? "" : `-${max}`} arguments`);
  }
}

function ensureMinArity(name: string, args: number[], min: number) {
  if (args.length < min) throw new Error(`Function ${name} expects at least ${min} arguments`);
}

function callCalcFunction(name: string, args: number[]) {
  const key = name.toLowerCase();
  switch (key) {
    case "sin":
      ensureArity(key, args, 1);
      return Math.sin(args[0]);
    case "cos":
      ensureArity(key, args, 1);
      return Math.cos(args[0]);
    case "tan":
      ensureArity(key, args, 1);
      return Math.tan(args[0]);
    case "log":
      ensureArity(key, args, 1, 2);
      return args.length === 1 ? Math.log10(args[0]) : Math.log(args[0]) / Math.log(args[1]);
    case "ln":
      ensureArity(key, args, 1);
      return Math.log(args[0]);
    case "sqrt":
      ensureArity(key, args, 1);
      return Math.sqrt(args[0]);
    case "abs":
      ensureArity(key, args, 1);
      return Math.abs(args[0]);
    case "pow":
      ensureArity(key, args, 2);
      return Math.pow(args[0], args[1]);
    case "min":
      ensureMinArity(key, args, 1);
      return Math.min(...args);
    case "max":
      ensureMinArity(key, args, 1);
      return Math.max(...args);
    case "round":
      ensureArity(key, args, 1, 2);
      if (args.length === 1) return Math.round(args[0]);
      return Math.round(args[0] * Math.pow(10, args[1])) / Math.pow(10, args[1]);
    case "floor":
      ensureArity(key, args, 1);
      return Math.floor(args[0]);
    case "ceil":
      ensureArity(key, args, 1);
      return Math.ceil(args[0]);
    default:
      throw new Error(`Unsupported function: ${name}`);
  }
}

function evaluateCalcExpression(rawExpr: string) {
  const source = (rawExpr || "").replace(/\s+/g, "");
  if (!source) return null;

  let index = 0;
  const peek = () => source[index] || "";
  const consume = (ch: string) => {
    if (source[index] === ch) {
      index += 1;
      return true;
    }
    return false;
  };

  const parseNumber = () => {
    const rest = source.slice(index);
    const match = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("Invalid number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("Invalid number");
    return value;
  };

  const parseIdentifier = () => {
    const rest = source.slice(index);
    const match = rest.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (!match) throw new Error("Invalid identifier");
    index += match[0].length;
    return match[0];
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (true) {
      if (consume("+")) value += parseTerm();
      else if (consume("-")) value -= parseTerm();
      else break;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parsePower();
    while (true) {
      if (consume("*")) value *= parsePower();
      else if (consume("/")) value /= parsePower();
      else if (consume("%")) value %= parsePower();
      else break;
    }
    return value;
  };

  const parsePower = (): number => {
    const left = parseUnary();
    if (consume("^")) return Math.pow(left, parsePower());
    return left;
  };

  const parseUnary = (): number => {
    if (consume("+")) return parseUnary();
    if (consume("-")) return -parseUnary();
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    if (consume("(")) {
      const value = parseExpression();
      if (!consume(")")) throw new Error("Missing closing parenthesis");
      return value;
    }

    const ch = peek();
    if (/[0-9.]/.test(ch)) return parseNumber();
    if (/[a-zA-Z_]/.test(ch)) {
      const id = parseIdentifier();
      if (consume("(")) {
        const args: number[] = [];
        if (!consume(")")) {
          while (true) {
            args.push(parseExpression());
            if (consume(")")) break;
            if (!consume(",")) throw new Error("Invalid argument separator");
          }
        }
        return callCalcFunction(id, args);
      }
      const constValue = CALC_CONSTANTS[id.toLowerCase()];
      if (typeof constValue !== "number") throw new Error("Unsupported identifier");
      return constValue;
    }

    throw new Error("Unexpected token");
  };

  try {
    const value = parseExpression();
    if (index !== source.length) return null;
    if (!Number.isFinite(value) || Number.isNaN(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function formatCalcNumber(value: number) {
  const normalized = Number.parseFloat(value.toPrecision(15));
  if (Object.is(normalized, -0)) return "0";
  return `${normalized}`;
}

function buildCalcItem(queryTerm: string): AppItem | null {
  const trimmed = (queryTerm || "").trim();
  if (!trimmed.startsWith("=")) return null;
  const expression = trimmed.slice(1).trim();
  if (!expression) return null;
  const result = evaluateCalcExpression(expression);
  if (result == null) return null;
  return createCalcItem(expression, formatCalcNumber(result));
}

function createCalcItem(expression: string, result: string): AppItem {
  return {
    // 计算项内部仍保留“结果”和“表达式”两个字段，便于复制结果与删除历史。
    name: result,
    path: expression,
    type: "calc",
    description: `= ${expression}`,
  };
}

function parseCalcMode(rawQuery: string) {
  const trimmed = (rawQuery || "").trim();
  const isCalcMode = trimmed.startsWith("=");
  const expression = isCalcMode ? trimmed.slice(1).trim() : "";
  return { isCalcMode, expression };
}

function normalizeCalcHistoryPayload(payload: unknown): CalcHistoryRecord[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((it) => ({
      expression: typeof (it as any)?.expression === "string" ? (it as any).expression.trim() : "",
      result: typeof (it as any)?.result === "string" ? (it as any).result.trim() : "",
      lastUsed: typeof (it as any)?.lastUsed === "number" ? (it as any).lastUsed : 0,
    }))
    .filter((it) => it.expression && it.result)
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

function mapCalcHistoryToItems(records: CalcHistoryRecord[]): AppItem[] {
  return records.map((it) => createCalcItem(it.expression, it.result));
}

export function useSearchController() {
  // 缁熶竴璇诲彇璁剧疆锛氭悳绱㈤〉浼氱敤鍒伴粯璁ょ被鍨嬨€佺被鍨嬮『搴忋€佷富棰樹笌鑳屾櫙鐩稿叧閰嶇疆
  const { settings, loaded } = useSettings();

  const parseDrivePrefix = (raw: string) => {
    // ?? E: / E:  / E? / E? ?????????????
    const s = typeof raw === "string" ? raw.trim() : "";
    // ????????? E:\\foo ? E:/foo????????? + ????
    const m = s.match(/^([a-zA-Z])\s*(?::|\uFF1A)\s*(?![\\/])/);
    if (!m) return { term: s, drive: "" };
    const drive = (m[1] || "").toLowerCase();
    const term = s.slice(m[0].length).trim();
    return { term, drive };
  };

  // 鎼滅储杈撳叆涓庣被鍨嬮€夋嫨锛氶┍鍔ㄦ煡璇笌缁撴灉杩囨护
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
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [hoveredKey, setHoveredKey] = useState("");
  const [toast, setToast] = useState<null | { kind: "success" | "error" | "info"; message: string }>(null);
  // 计算器图标缓存：只在会话内保存一次 dataUrl，供“= 当前项/历史项”统一复用。
  const [calculatorIconDataUrl, setCalculatorIconDataUrl] = useState("");
  // 搜索面板固定状态：仅保存在当前会话内，不落盘。
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

  // 鍏抽敭鍏冪礌寮曠敤锛氳緭鍏ユ鑱氱劍銆佸垪琛ㄦ粴鍔ㄣ€佷笅鎷夎彍鍗曠偣鍑诲閮ㄥ叧闂瓑
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<any>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const typeSelectRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 窗口高度自适应：减少高频 resize 带来的抖动与重复调用。
  // 记录上一次发送到主进程的高度与边界，避免高频重复 IPC 导致抖动。
  const lastResizePayloadRef = useRef<null | {
    height: number;
    minHeight: number;
    maxHeight: number;
  }>(null);
  const resizeRafRef = useRef<number | null>(null);
  const searchingIndicatorTimerRef = useRef<number | null>(null);
  // 搜索请求防抖与竞态控制依赖的引用状态。
  // 绔炴€佷繚鎶わ細寮傛鎼滅储杩斿洖鏃跺榻愨€滃綋鍓?query/type鈥濓紝閬垮厤鏃ц姹傝鐩栨柊缁撴灉
  const queryRef = useRef("");
  const searchTypeIdRef = useRef(searchTypeId);
  const selectedPathRef = useRef("");
  const isPanelPinnedRef = useRef(isPanelPinned);
  const searchRequestIdRef = useRef(0);
  // 鎼滅储浼氳瘽 ID锛氱敤浜庡叧鑱斾富杩涚▼鍒嗘壒鎺ㄩ€佺殑 more-results锛岄伩鍏嶅垏鎹㈢被鍨?閲嶅鎼滅储瀵艰嚧閲嶅椤逛笌鏁伴噺涓嶄竴鑷?
  const searchSessionIdRef = useRef("");
  const pendingAppendRef = useRef<AppItem[]>([]);
  const flushAppendTimerRef = useRef<number | null>(null);
  const calcItemRef = useRef<AppItem | null>(null);
  const calcHistoryItemsRef = useRef<AppItem[]>([]);
  // Tab/Shift+Tab 鍒囨崲绫诲瀷鏃朵笉璧?120ms 闃叉姈锛屼繚璇佸垏鎹㈠悗绔嬪嵆鐪嬪埌鏂扮被鍨嬬粨鏋?
  const typeSwitchRequestedRef = useRef(false);
  const historyItemsRef = useRef<AppItem[]>(getBootstrapHistoryCache());
  const bootstrapTypeSyncedRef = useRef(false);

  const resizeWindowToContent = useCallback(
    (opts?: { includeTypeMenu?: boolean }) => {
      const c = containerRef.current;
      if (!c) return;

      // 高度计算统一使用真实文档内容高度，避免把当前窗口高度误判为内容高度。
      const htmlEl = document.documentElement;
      const bodyEl = document.body;
      const containerRect = c.getBoundingClientRect();
      const docHeight = Math.max(htmlEl?.scrollHeight ?? 0, bodyEl?.scrollHeight ?? 0);
      // 以容器滚动高度为主，文档高度仅作为兜底，避免窗口被手动拉大时反向污染内容高度判断。
      let contentHeight = Math.ceil(c.scrollHeight > 0 ? c.scrollHeight : docHeight);
      const shouldIncludeMenu = opts?.includeTypeMenu ?? typeMenuOpen;
      const menuEl = shouldIncludeMenu ? typeMenuRef.current : null;
      if (menuEl) {
        const menuRect = menuEl.getBoundingClientRect();
        const needed = Math.ceil(menuRect.bottom - containerRect.top + 10);
        contentHeight = Math.max(contentHeight, needed, TYPE_MENU_MIN_LIST_SPACE);
      }

      const clamp = (v: number, min: number, max: number) =>
        Math.min(max, Math.max(min, v));
      const itemHeight = settings.compactMode
        ? SEARCH_ITEM_HEIGHT_COMPACT
        : SEARCH_ITEM_HEIGHT_NORMAL;
      const deviceMaxHeight = Math.floor((window.screen as any)?.availHeight || 0);
      const settingMaxHeight =
        typeof settings.searchWindowMaxHeight === "number"
          ? settings.searchWindowMaxHeight
          : DEFAULT_SETTINGS.searchWindowMaxHeight;
      const hardUpper = Math.max(
        SEARCH_WINDOW_MIN_HEIGHT,
        Math.round(
          Math.min(
            settingMaxHeight,
            deviceMaxHeight > 0 ? deviceMaxHeight : settingMaxHeight,
          ),
        ),
      );
      const maxListHeight = Math.max(
        SEARCH_LIST_MIN_HEIGHT,
        Math.round(hardUpper) -
          SEARCH_WINDOW_TOP_BAR_HEIGHT -
          SEARCH_WINDOW_BOTTOM_BAR_HEIGHT,
      );
      const hasResults = results.length > 0;
      const renderedListHeight = hasResults
        ? Math.max(itemHeight, Math.min(results.length * itemHeight, maxListHeight))
        : 0;

      const resultsEl = c.querySelector(".results") as HTMLElement | null;
      const searchBoxEl = c.querySelector(".search-box") as HTMLElement | null;
      const statusEl = c.querySelector(".status") as HTMLElement | null;
      const anchorEl = statusEl ?? searchBoxEl;

      // 无结果时最小高度只保留搜索区域；若存在空态区，需要从总高度中扣除结果容器高度。
      let minHeightBySearchArea = SEARCH_WINDOW_MIN_HEIGHT;
      if (resultsEl) {
        const resultsRect = resultsEl.getBoundingClientRect();
        minHeightBySearchArea = Math.max(
          SEARCH_WINDOW_MIN_HEIGHT,
          Math.ceil(contentHeight - Math.max(0, resultsRect.height)),
        );
      } else if (anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        minHeightBySearchArea = Math.max(
          SEARCH_WINDOW_MIN_HEIGHT,
          Math.ceil(anchorRect.bottom - containerRect.top),
        );
      }

      // 有结果时最小高度至少展示 1 条结果 + 底部信息；无结果时退化为搜索区域高度。
      const minHeightByOneResult = hasResults
        ? Math.max(
            SEARCH_WINDOW_MIN_HEIGHT,
            Math.ceil(contentHeight - renderedListHeight + itemHeight),
          )
        : minHeightBySearchArea;

      let boundedMaxHeight = clamp(
        Math.ceil(contentHeight),
        SEARCH_WINDOW_MIN_HEIGHT,
        hardUpper,
      );
      let boundedMinHeight = clamp(
        Math.ceil(minHeightByOneResult),
        SEARCH_WINDOW_MIN_HEIGHT,
        boundedMaxHeight,
      );

      if (menuEl) {
        const menuRect = menuEl.getBoundingClientRect();
        const menuNeeded = clamp(
          Math.ceil(menuRect.bottom - containerRect.top + 10),
          SEARCH_WINDOW_MIN_HEIGHT,
          hardUpper,
        );
        boundedMaxHeight = Math.max(boundedMaxHeight, menuNeeded);
        boundedMinHeight = Math.min(
          boundedMaxHeight,
          Math.max(boundedMinHeight, menuNeeded),
        );
      }

      const nextHeight = clamp(
        Math.ceil(contentHeight),
        boundedMinHeight,
        boundedMaxHeight,
      );
      const nextPayload = {
        height: nextHeight,
        minHeight: boundedMinHeight,
        maxHeight: boundedMaxHeight,
      };
      const prevPayload = lastResizePayloadRef.current;
      if (
        prevPayload &&
        prevPayload.height === nextPayload.height &&
        prevPayload.minHeight === nextPayload.minHeight &&
        prevPayload.maxHeight === nextPayload.maxHeight
      ) {
        return;
      }
      lastResizePayloadRef.current = nextPayload;
      window.ipcRenderer?.invoke("resize-window", nextHeight, undefined, {
        minHeight: boundedMinHeight,
        maxHeight: boundedMaxHeight,
      });
    },
    [results.length, settings.compactMode, settings.searchWindowMaxHeight, typeMenuOpen],
  );

  const syncWindowHeight = useCallback(
    (opts?: { includeTypeMenu?: boolean }) => {
      // 先在当前帧同步一次，避免窗口层与 HTML 内容层出现短暂高度错位。
      resizeWindowToContent(opts);
      // 下一帧再复核一次，覆盖虚拟列表与异步渲染带来的延迟高度变化。
      if (resizeRafRef.current != null) cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeWindowToContent(opts);
      });
    },
    [resizeWindowToContent],
  );

  const setQueryAndInputValue = (next: string) => {
    setQuery(next);
    setInputValue(next);
    setGhostInputValue("");
    setSelectedActionIndex((prev) => (prev >= 0 ? -1 : prev));
  };

  const clearGhostInputValue = useCallback(() => {
    setGhostInputValue("");
  }, []);

  const syncBlurHideByPinnedState = useCallback((pinned: boolean) => {
    // 固定开启时禁用“失焦自动隐藏”，取消固定后恢复旧逻辑。
    void window.ipcRenderer?.invoke("set-search-blur-hide-enabled", !pinned);
  }, []);

  const notifySearchViewReady = useCallback(() => {
    // 渲染层每次握手都带上当前固定状态，确保主进程 blur 策略与 UI 一致。
    void window.ipcRenderer?.invoke("search-view-ready", {
      allowBlurHide: !isPanelPinnedRef.current,
    });
  }, []);

  // 鎼滅储鍒楄〃鐨勫崟椤归珮搴﹀凡鎶界锛氫究浜庝綘缁熶竴璋冩暣绱у噾/鏅€氭ā寮忕殑甯冨眬瀵嗗害
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
  const lastVisibleStartIndexRef = useRef(0);

  useEffect(() => {
    void refreshUserStatusSilently();
  }, []);

  useEffect(() => {
    let mounted = true;

    // 鍚姩闃舵鍏堟嬁涓昏繘绋嬮鐑ソ鐨勫揩鐓э細棣栧紑鎼滅储闈㈡澘鏃剁洿鎺ュ鐢ㄨ繖浠藉巻鍙蹭笌榛樿绫诲瀷銆?
    void loadBootstrapState().then((snapshot) => {
      if (!mounted) return;
      historyItemsRef.current = Array.isArray(snapshot.history) ? snapshot.history : [];
      setBootstrapHistoryCache(historyItemsRef.current);

      if (!bootstrapTypeSyncedRef.current && loaded) {
        const nextTypeId = snapshot.settings.defaultSearchTypeId || "all";
        bootstrapTypeSyncedRef.current = true;
        setSearchTypeId(nextTypeId);
        if (queryRef.current.trim().length === 0) {
          applyHistoryResults(historyItemsRef.current, { typeId: nextTypeId });
        }
      } else if (queryRef.current.trim().length === 0) {
        applyHistoryResults(historyItemsRef.current, {
          typeId: searchTypeIdRef.current,
          preserveSelectedPath: selectedPathRef.current,
        });
      }
    });

    const handleHistoryUpdated = (_event: any, payload?: { results?: AppItem[] }) => {
      const nextHistory = Array.isArray(payload?.results) ? payload.results : [];
      historyItemsRef.current = nextHistory;
      setBootstrapHistoryCache(nextHistory);
      if (queryRef.current.trim().length === 0) {
        applyHistoryResults(nextHistory, {
          typeId: searchTypeIdRef.current,
          preserveSelectedPath: selectedPathRef.current,
        });
      }
    };

    window.ipcRenderer?.on("history-updated", handleHistoryUpdated as any);
    return () => {
      mounted = false;
      window.ipcRenderer?.off("history-updated", handleHistoryUpdated as any);
    };
  }, [loaded]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (searchingIndicatorTimerRef.current != null) {
        window.clearTimeout(searchingIndicatorTimerRef.current);
        searchingIndicatorTimerRef.current = null;
      }
      if (resizeRafRef.current != null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (searchingIndicatorTimerRef.current != null) {
      window.clearTimeout(searchingIndicatorTimerRef.current);
      searchingIndicatorTimerRef.current = null;
    }
    if (!isSearching) {
      setShowSearchingIndicator(false);
      return;
    }
    // 浠呭湪鎱㈡煡璇㈡椂鏄剧ず鈥滄鍦ㄦ悳绱⑩€濓紝閬垮厤绱㈠紩瀹屾垚鍚庣殑浼姞杞芥劅銆?    setShowSearchingIndicator(false);
    searchingIndicatorTimerRef.current = window.setTimeout(() => {
      setShowSearchingIndicator(true);
      searchingIndicatorTimerRef.current = null;
    }, SEARCH_STATUS_DELAY_MS);
    return () => {
      if (searchingIndicatorTimerRef.current != null) {
        window.clearTimeout(searchingIndicatorTimerRef.current);
        searchingIndicatorTimerRef.current = null;
      }
    };
  }, [isSearching]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    searchTypeIdRef.current = searchTypeId;
  }, [searchTypeId]);

  useEffect(() => {
    // 固定状态变化时同步到 ref，供跨回调读取最新值。
    isPanelPinnedRef.current = isPanelPinned;
    syncBlurHideByPinnedState(isPanelPinned);
  }, [isPanelPinned, syncBlurHideByPinnedState]);

  useEffect(() => {
    selectedPathRef.current = results[selectedIndex]?.path || "";
  }, [results, selectedIndex]);

  useEffect(() => {
    // 鐪熷疄鏌ヨ鍙樺寲鎴栧垏鎹㈢被鍨嬪悗锛屾竻绌衡€滃菇鐏垫彁绀衡€濋伩鍏嶈瀵?
    setGhostInputValue("");
  }, [query, searchTypeId]);

  useEffect(() => {
    if (results.length > 0) return;
    setGhostInputValue("");
  }, [results.length]);

  useEffect(() => {
    // 输入联想优先展示“当前首条结果”的后缀，保持输入时有稳定的幽灵提示。
    if (!inputValue || results.length === 0) {
      setGhostInputValue("");
      return;
    }
    // 用户键盘下移选择其它项时，保留现有键盘导航幽灵提示，不被首条结果覆盖。
    if (lastSelectedBy === "keyboard" && selectedIndex > 0) return;
    const firstName = typeof results[0]?.name === "string" ? results[0].name.trim() : "";
    if (!firstName) {
      setGhostInputValue("");
      return;
    }
    const inputLower = inputValue.toLocaleLowerCase();
    const firstLower = firstName.toLocaleLowerCase();
    if (!firstLower.startsWith(inputLower) || firstName.length <= inputValue.length) {
      setGhostInputValue("");
      return;
    }
    setGhostInputValue(firstName);
  }, [inputValue, results, lastSelectedBy, selectedIndex]);

  useEffect(() => {
    // 缁撴灉闆嗗彉鍖栨椂淇濇姢 selectedIndex锛氶伩鍏嶆寚鍚戣秺鐣屽鑷村垪琛ㄦ粴鍔?娓叉煋寮傚父
    if (results.length === 0) return;
    if (selectedIndex < 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex > results.length - 1) {
      setSelectedIndex(results.length - 1);
    }
  }, [results.length, selectedIndex]);
  // 鏍规嵁褰撳墠閫夋嫨鐨勬悳绱㈢被鍨嬪缁撴灉鍋氫簩娆¤繃婊わ紙鍘嗗彶/澧為噺缁撴灉閮戒細璧拌繖閲岋級
  const filterItemsBySearchType = (items: AppItem[], typeId: string) => {
    return filterItemsBySearchTypeUtil(items, typeId, settings.customSearchTypes || []);
  };

  const limitResults = (items: AppItem[]) => limitResultsUtil(items, DISPLAY_LIMIT);
  const applyCalcResults = useCallback((currentCalcItem: AppItem | null, preservePath?: string) => {
    // 纯计算模式：只显示计算相关结果，避免与文件搜索结果混排。
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

  useEffect(() => {
    let mounted = true;

    // 计算历史独立订阅：进入“=”模式时直接切换为纯计算结果面板。
    const applyPayload = (payload?: { results?: unknown }) => {
      const records = normalizeCalcHistoryPayload(payload?.results);
      calcHistoryItemsRef.current = mapCalcHistoryToItems(records);
      if (!mounted) return;
      const { isCalcMode } = parseCalcMode(queryRef.current);
      if (!isCalcMode) return;
      applyCalcResults(calcItemRef.current, selectedPathRef.current);
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
  }, [applyCalcResults]);

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
    // 鐐瑰嚮涓嬫媺閫夋嫨鍣ㄤ箣澶栨椂鍏抽棴鑿滃崟锛岄伩鍏嶈彍鍗曟偓娴奖鍝嶉敭鐩樻搷浣?
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

  useEffect(() => {
    // 会话内只拉取一次系统计算器图标：与应用搜索走同一主进程取图能力。
    let cancelled = false;
    void window.ipcRenderer
      ?.invoke("get-result-icon", { type: "calc", name: "计算器", path: "" })
      .then((icon: unknown) => {
        if (cancelled) return;
        if (typeof icon !== "string") return;
        const normalized = icon.trim();
        if (!normalized) return;
        setCalculatorIconDataUrl(normalized);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
    // 鎼滅储绫诲瀷寮€鍏筹細璁剧疆闈㈡澘鍙叧闂煇浜涚被鍨嬶紙鈥滄墍鏈夌被鍨嬧€濇案杩滀繚鐣欙級
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

  // 鍒锋柊鍘嗗彶璁板綍锛氱敤浜庘€滅┖杈撳叆鈥濇ā寮忎笅灞曠ず鏈€杩戞墦寮€椤?
  const applyHistoryResults = (historyItems: AppItem[], opts?: RefreshHistoryOpts) => {
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
      // 删除入口统一分流：文件历史与计算历史各走各自通道，避免误删。
      if (parseCalcMode(queryRef.current).isCalcMode && item.type === "calc") {
        await deleteCalcHistoryItem(item.path);
        return;
      }
      await deleteHistoryItem(item.path);
    },
    [],
  );

  useEffect(() => {
    inputRef.current?.focus();
    // 涓昏繘绋嬮€氱煡鈥滈渶瑕侀噸缃悳绱㈤〉鈥濇椂瑙﹀彂锛氭寜鐢ㄦ埛璁剧疆鍐冲畾鏄惁淇濈暀涓婃鐘舵€?
    const handleReset = async () => {
      void refreshUserStatusSilently();
      // 面板生命周期切换后重置去重缓存，确保下次显示会强制同步真实高度与边界。
      lastResizePayloadRef.current = null;
      if (settings.keepStateOnClose) {
        setTimeout(() => {
          inputRef.current?.focus();
          notifySearchViewReady();
        }, 50);
        return;
      }
      const nextTypeId = settings.defaultSearchTypeId || "all";
      setSearchTypeId(nextTypeId);
      setQueryAndInputValue("");
      applyHistoryResults(historyItemsRef.current, { typeId: nextTypeId });
      syncWindowHeight({ includeTypeMenu: false });
      setTimeout(() => {
        inputRef.current?.focus();
        notifySearchViewReady();
      }, 50);
    };
    window.ipcRenderer?.on("reset-search", handleReset);
    return () => {
      window.ipcRenderer?.off("reset-search", handleReset as any);
    };
  }, [settings, syncWindowHeight, notifySearchViewReady]);

  useEffect(() => {
    const handler = () => {
      setTypeMenuOpen(false);
      // 隐藏窗口时重置去重缓存，避免下次打开沿用旧的高度边界。
      lastResizePayloadRef.current = null;
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
      notifySearchViewReady();
      // 重新打开窗口前重置去重缓存，确保首帧高度按当前内容重新计算。
      lastResizePayloadRef.current = null;
      const queryMode = parseCalcMode(queryRef.current);
      const p = queryMode.isCalcMode
        ? Promise.resolve(applyCalcResults(calcItemRef.current, selectedPathRef.current))
        : queryRef.current.trim().length === 0
          ? refreshHistory({
              typeId: searchTypeIdRef.current,
              preserveSelectedPath: selectedPathRef.current,
            })
          : Promise.resolve();
      void p.finally(() => {
        syncWindowHeight({ includeTypeMenu: true });
      });
    };
    window.ipcRenderer?.on("search-window-opened", handler as any);
    return () => {
      window.ipcRenderer?.off("search-window-opened", handler as any);
    };
  }, [syncWindowHeight, applyCalcResults, notifySearchViewReady]);

  useEffect(() => {
    // more-results 浜嬩欢鐢ㄤ簬涓昏繘绋嬧€滃閲忓洖濉浘鏍?鏇村缁撴灉鈥?
    // 杩欓噷蹇呴』甯搁┗鐩戝惉锛堜笉瑕侀殢 query/searchTypeId 鍙嶅瑙ｇ粦/缁戝畾锛夛紝鍚﹀垯鏋佹槗鍦ㄩ鎼滈樁娈典涪浜嬩欢锛岃〃鐜颁负鈥滅涓€娆℃病鍥炬爣锛岀浜屾鎵嶆湁鈥?
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
      const hadPending = pendingAppendRef.current.length > 0;
      pendingAppendRef.current = [...pendingAppendRef.current, ...filteredMore];
      if (!hadPending) {
        flushPendingAppends();
        return;
      }
      if (flushAppendTimerRef.current == null) {
        flushAppendTimerRef.current = window.setTimeout(() => flushPendingAppends(), 24);
      }
    };
    window.ipcRenderer?.on("more-results", handler);
    return () => {
      flushPendingAppends();
      window.ipcRenderer?.off("more-results", handler);
    };
  }, []);

  useEffect(() => {
    const { term, drive } = parseDrivePrefix(query);
    const trimmed = term.trim();
    const calcMode = parseCalcMode(trimmed);
    calcItemRef.current = buildCalcItem(trimmed);
    if (calcMode.isCalcMode) {
      // 鈥?鈥濇ā寮忕洿鎺ヨ繘鍏ョ函璁＄畻鍒楄〃锛屼笉瑙﹀彂鏂囦欢鎼滅储銆?      searchRequestIdRef.current += 1;
      searchSessionIdRef.current = "";
      typeSwitchRequestedRef.current = false;
      pendingAppendRef.current = [];
      if (flushAppendTimerRef.current != null) {
        window.clearTimeout(flushAppendTimerRef.current);
        flushAppendTimerRef.current = null;
      }
      applyCalcResults(calcItemRef.current, selectedPathRef.current);
      return;
    }
    if (!trimmed || trimmed.length < 1) {
      // 绌鸿緭鍏ヤ笉瑙﹀彂鎼滅储锛氭樉绀哄巻鍙诧紱鍏朵綑浜ょ敱鍚庣画娴佺▼澶勭悊锛堟敮鎸佸崟瀛楃鎼滅储锛?
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
    setHasMore(false);
    setTotalCount(0);
    setHoveredKey("");
    pendingAppendRef.current = [];
    if (flushAppendTimerRef.current != null) {
      window.clearTimeout(flushAppendTimerRef.current);
      flushAppendTimerRef.current = null;
    }
    // 闃叉姈锛氶伩鍏嶈繛缁緭鍏ヨЕ鍙戣繃澶?IPC 鎼滅储璇锋眰
    // 绱㈠紩鏈熷姞澶ч槻鎶栵紝浼樺厛淇濊瘉杈撳叆娴佺晠銆?
    const delay = typeSwitchRequestedRef.current
      ? 0
      : isIndexing
        ? SEARCH_DEBOUNCE_INDEXING_MS
        : SEARCH_DEBOUNCE_READY_MS;
    typeSwitchRequestedRef.current = false;
    const timer = setTimeout(async () => {
      if (searchRequestIdRef.current !== requestId) return;
      setIsSearching(true);
      try {
        const resp = (await window.ipcRenderer?.invoke(
          "search-files",
          trimmed,
          { searchTypeId, searchSessionId, drive },
        )) as (SearchResponse & { hasMore?: boolean }) | undefined;
        // 绔炴€佷繚鎶わ細鍙帴鍙椻€滄渶鏂拌姹?+ 褰撳墠 query/type鈥濆搴旂殑缁撴灉
        if (searchRequestIdRef.current !== requestId) return;
        if (parseDrivePrefix(queryRef.current).term !== trimmed) return;
        if (searchTypeIdRef.current !== searchTypeId) return;
        const nextResults = filterItemsBySearchType(resp?.results ?? [], searchTypeId);
        setSelectedIndex(0);
        startTransition(() => {
          const limited = limitResults(dedupeResults(nextResults));
          setResults(limited);
          const rawTotal = typeof resp?.totalCount === "number" ? resp.totalCount : limited.length;
          // 濡傛灉娌℃湁鏇村缁撴灉锛屼笖褰撳墠缁撴灉鏁伴噺灏忎簬鍚庣杩斿洖鐨勬€绘暟锛堣鏄庡墠绔幓閲嶄簡锛夛紝鍒欎互褰撳墠缁撴灉鏁伴噺涓哄噯锛岄伩鍏嶇晫闈㈡樉绀衡€?2鏉＄粨鏋溾€濅絾鍒楄〃鍙湁3椤?
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
  }, [query, searchTypeId, isIndexing, applyCalcResults]);

  useEffect(() => {
    // 娓叉煋灞傚浘鏍囪ˉ鎶撳凡涓嬫矇鍒颁富杩涚▼缂撳瓨閾捐矾锛岃繖閲岀洿鎺ョ鐢紝閬垮厤鍓嶅悗绔噸澶嶆姄鍙栥€?    return;
    /*
    if (searchTypeId !== "app") return;
    // 鎼滅储杩涜涓椂缁撴灉浼氶绻佸彉鍖栵細姝ゆ椂鎶㈠崰寮忚ˉ榻愬浘鏍囦細瀵艰嚧棰戠箒 setState锛屽紩鍙戝垪琛ㄧ煭鏆傚崱椤?闂姩
    // 杩欓噷绛夋湰杞悳绱㈢粨鏉熷悗鍐嶆媺鍙栭灞忕己澶卞浘鏍囷紝骞舵壒閲忓悎骞跺埌 results锛屽噺灏戞覆鏌撳帇鍔?
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
          // 灏嗗浘鏍囧洖濉粺涓€璧扳€滄壒閲忓悎骞垛€濋槦鍒楋細閬垮厤姣忎釜 icon 閮借Е鍙戜竴娆″垪琛ㄩ噸娓叉煋瀵艰嚧鍗￠】
          pendingAppendRef.current = [...pendingAppendRef.current, { ...it, icon }];
          if (flushAppendTimerRef.current == null) {
            flushAppendTimerRef.current = window.setTimeout(() => flushPendingAppends(), 24);
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
    */
  }, [results, searchTypeId, isSearching]);

  useEffect(() => {
    const trimmed = parseDrivePrefix(query).term;
    if (parseCalcMode(trimmed).isCalcMode) return;
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
            // 澧為噺鍥炲～/绱㈠紩鍒锋柊鏃跺彧鈥滆ˉ榻?鏇存柊鈥濇暟鎹紝涓嶉噸鎺掑凡鍔犺浇鐨勫垪琛ㄩ『搴忥紝閬垮厤鎷栨嫿/鎿嶄綔鏃跺嚭鐜拌烦鍔?
            const merged = limitResults(mergeResultsStable(prev, serverOrdered));
            setTotalCount((c) => Math.max(c, respTotal, merged.length));
            return merged;
          });
          setIsIndexing(Boolean(resp?.isIndexing));
          setHasMore((v) => v || Boolean(resp?.hasMore));
        });
      } catch {}
    };

    // 绱㈠紩鏈熶笉鍋氶珮棰戣疆璇㈠埛鏂帮紝鏀逛负杈撳叆绋冲畾鍚庤Е鍙戜竴娆¤交閲忓埛鏂般€?
    const timerId = window.setTimeout(() => {
      void refreshOnce();
    }, 800);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
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

  const hideWindow = () => {
    setTypeMenuOpen(false);
    window.ipcRenderer?.invoke("hide-window");
  };

  const togglePanelPinned = useCallback(() => {
    setIsPanelPinned((prev) => {
      const next = !prev;
      // 固定按钮点击后立即同步主进程，避免等待下一轮事件导致短暂行为不一致。
      syncBlurHideByPinnedState(next);
      isPanelPinnedRef.current = next;
      return next;
    });
  }, [syncBlurHideByPinnedState]);

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

  const copyCalcResult = (item: AppItem | undefined) => {
    if (!item || item.type !== "calc") return;
    const expressionText = String(item.path || "").trim();
    const resultText = String(item.name || "").trim();
    if (!expressionText || !resultText) return;
    // 复制或确认计算结果时写入独立计算历史，便于“=”模式快速回看。
    void window.ipcRenderer?.invoke("record-calc-history-item", {
      expression: expressionText,
      result: resultText,
    });
    navigator.clipboard
      .writeText(resultText)
      .then(() => showToast("已复制计算结果", "success"))
      .catch(() => showToast("复制失败", "error"));
  };

  const openFolder = (app: AppItem) => {
    if (app.type === "calc") return;
    if (app.type === "settings") {
      window.ipcRenderer?.invoke("open-item", {
        name: app.name,
        path: app.path,
        type: app.type || "file",
      });
      return;
    }
    // 鈥滄墦寮€鐩綍鈥濋渶瑕佸湪涓昏繘绋嬪尯鍒?app/file/folder锛氬簲鐢ㄤ紭鍏堝畾浣嶅埌寮€濮嬭彍鍗曞揩鎹锋柟寮忔墍鍦ㄧ洰褰曪紝鑰屼笉鏄墦寮€ AppsFolder 铏氭嫙鐩綍
    window.ipcRenderer?.invoke("open-folder", { type: app.type, path: app.path, name: app.name });
  };

  const launchApp = (app: AppItem) => {
    if (app.type === "calc") {
      copyCalcResult(app);
      return;
    }
    window.ipcRenderer?.invoke("open-item", {
      name: app.name,
      path: app.path,
      type: app.type || "file",
    });
  };

  const runAsAdmin = (app: AppItem) => {
    // 以管理员身份运行可能失败（UAC 拒绝或目标类型不支持），这里统一给出明确反馈。
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

  const isCalcMode = parseCalcMode(query).isCalcMode;
  const isHistoryMode = !isCalcMode && query.trim().length === 0;

  const getVisibleActionIdsForItem = useCallback(
    (item: AppItem | undefined) => {
      if (!item) return [] as AppSettings["resultActionButtons"];
      // 计算模式仅保留“删除历史”动作，满足右侧 × 删除需求。
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

  const normalizeShortcutMainKey = (raw: string) => {
    const key = String(raw || "").trim();
    if (!key) return "";
    if (key === " ") return "Space";
    if (key.length === 1) return key.toUpperCase();
    if (key === "ArrowUp") return "Up";
    if (key === "ArrowDown") return "Down";
    if (key === "ArrowLeft") return "Left";
    if (key === "ArrowRight") return "Right";
    return key;
  };

  const parseShortcut = (shortcut: string) => {
    const parts = String(shortcut || "")
      .split("+")
      .map((x) => x.trim())
      .filter(Boolean);
    const parsed = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "ctrl" || lower === "control" || lower === "commandorcontrol") {
        parsed.ctrl = true;
        continue;
      }
      if (lower === "alt" || lower === "option") {
        parsed.alt = true;
        continue;
      }
      if (lower === "shift") {
        parsed.shift = true;
        continue;
      }
      if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") {
        parsed.meta = true;
        continue;
      }
      parsed.key = normalizeShortcutMainKey(part);
    }
    return parsed;
  };

  const isShortcutPressed = (
    e: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
    shortcut: string,
  ) => {
    const parsed = parseShortcut(shortcut);
    if (!parsed.key) return false;
    if (Boolean(e.ctrlKey) !== parsed.ctrl) return false;
    if (Boolean(e.altKey) !== parsed.alt) return false;
    if (Boolean(e.shiftKey) !== parsed.shift) return false;
    if (Boolean(e.metaKey) !== parsed.meta) return false;
    return normalizeShortcutMainKey(e.key) === parsed.key;
  };

  const acceptSelectedResultToInput = () => {
    const selected = results[selectedIndex];
    if (!selected?.name) return false;
    setQueryAndInputValue(selected.name);
    setGhostInputValue("");
    inputRef.current?.focus();
    return true;
  };

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
      code?: string;
    }) => {
      if ((e as any).isComposing) return;

      // Alt+T 固定切换统一放在核心入口：保证窗口级和 React 级监听行为一致。
      const keyLower = String(e.key || "").toLowerCase();
      const isTogglePinShortcut =
        e.altKey && (keyLower === "t" || String(e.code || "") === "KeyT");
      if (isTogglePinShortcut) {
        e.preventDefault();
        e.stopPropagation();
        togglePanelPinned();
        return;
      }

      // 浠绘剰闈炲乏鍙抽敭鎿嶄綔閮戒細璁┾€滃乏鍙抽敭閫変腑鍙充晶鎸夐挳鈥濈殑鏁堟灉澶辨晥锛岄伩鍏嶇姸鎬佹畫鐣欓€犳垚璇Е
      if (selectedActionIndex >= 0 && e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
        setSelectedActionIndex(-1);
      }

      if (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (results.length === 0) return;
        const item = results[selectedIndex];
        const ids = getVisibleActionIdsForItem(item);
        if (ids.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        setLastSelectedBy("keyboard");
        setSelectedActionIndex((prev) => {
          const nextPrev = typeof prev === "number" ? prev : -1;

          // 绗竴娆″乏鍙冲垏鎹細蹇呴』鍏堥€変腑绗竴涓寜閽紝鍐嶆牴鎹柟鍚戠户缁垏
          if (nextPrev < 0) return 0;

          const delta = e.key === "ArrowRight" ? 1 : -1;
          const next = (nextPrev + delta + ids.length) % ids.length;
          return next;
        });
        return;
      }else{
        setSelectedActionIndex(-1);
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
        else if (id === "deleteHistory") void deleteResultItem(item);
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
      togglePanelPinned,
      deleteResultItem,
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

  // 统一搜索清空入口：复用给快捷键与清空按钮，保证行为一致且不改变当前搜索类型。
  const clearSearchInput = useCallback(() => {
    setQueryAndInputValue("");
    setGhostInputValue("");
    setSelectedIndex(0);
    setSelectedActionIndex(-1);
    setTypeMenuOpen(false);
    inputRef.current?.focus();
  }, [setQueryAndInputValue]);

  const handleKeyDownCapture = (e: React.KeyboardEvent) => {
    const lowerKey = e.key.toLowerCase();

    // Ctrl+L：清空搜索内容并保留焦点；Ctrl+K：仅聚焦输入框，保持原语义不变。
    if (e.ctrlKey && lowerKey === "l") {
      e.preventDefault();
      e.stopPropagation();
      clearSearchInput();
      return;
    }

    if (e.ctrlKey && lowerKey === "k") {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      return;
    }

    if (e.key === "Escape") {
      hideWindow();
      return;
    }

    // Alt+T: 固定/取消固定搜索面板
    if (e.altKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      e.stopPropagation();
      togglePanelPinned();
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
      setGhostInputValue("");
      setSelectedActionIndex(-1);
      if (next) setSearchTypeId(next.id);
      setTypeMenuOpen(false);
      return;
    }

    if (results.length === 0) return;

    const acceptShortcut = settings.acceptSelectedResultShortcut || DEFAULT_SETTINGS.acceptSelectedResultShortcut;
    if (isShortcutPressed(e as any, acceptShortcut)) {
      if (acceptSelectedResultToInput()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => {
        const next = (prev + 1) % results.length;
        setGhostInputValue(results[next]?.name || "");
        return next;
      });
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => {
        const next = (prev - 1 + results.length) % results.length;
        setGhostInputValue(results[next]?.name || "");
        return next;
      });
      e.preventDefault();
    } else if (e.key === "Home") {
      setLastSelectedBy("keyboard");
      setGhostInputValue(results[0]?.name || "");
      setSelectedIndex(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setLastSelectedBy("keyboard");
      const next = Math.max(0, results.length - 1);
      setGhostInputValue(results[next]?.name || "");
      setSelectedIndex(next);
      e.preventDefault();
    } else if (e.key === "PageDown") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => {
        const next = Math.min(results.length - 1, prev + 10);
        setGhostInputValue(results[next]?.name || "");
        return next;
      });
      e.preventDefault();
    } else if (e.key === "PageUp") {
      setLastSelectedBy("keyboard");
      setSelectedIndex((prev) => {
        const next = Math.max(0, prev - 10);
        setGhostInputValue(results[next]?.name || "");
        return next;
      });
      e.preventDefault();
    } else if (e.key === "Enter") {
      const selected = results[selectedIndex];
      if (!selected) return;
      if (selected.type === "calc") {
        e.preventDefault();
        e.stopPropagation();
        copyCalcResult(selected);
        return;
      }
      if (e.ctrlKey) openFolder(selected);
      else launchApp(selected);
    }
  };

  // 鍒楄〃浣跨敤铏氭嫙婊氬姩锛坮eact-window v2锛夛紝杩欓噷鐩存帴浣跨敤鍏ㄩ噺 results锛岄伩鍏嶁€滈€変腑绱㈠紩瓒呭嚭鍙鍒囩墖鈥濆鑷寸┖鐧芥覆鏌?
  const visibleResults = results;
  const currentTypeLabel = useMemo(() => {
    return enabledSearchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有类型";
  }, [searchTypeId, enabledSearchTypeOptions]);

  const currentTypeLabelSafe =
    enabledSearchTypeOptions.find((t) => t.id === searchTypeId)?.label || "所有类型";
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
  // 幽灵提示仅显示后缀补全：候选不以前缀匹配时不显示。
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

  const statusText = showSearchingIndicator
    ? "正在搜索..."
    : isIndexing
      ? "正在建立本地文件索引..."
      : "";

  return {
    settings,
    query,
    setQuery: setQueryAndInputValue,
    inputValue,
    ghostInputValue,
    ghostSuffixValue,
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
    isCalcMode,
    isPanelPinned,
    placeholder,
    searchTypeOptions: enabledSearchTypeOptions,
    currentTypeLabel: currentTypeLabelSafe,
    visibleResults,
    listHeight,
    showEmptyState,
    showInputHint,
    statusText: showSearchingIndicator ? "正在搜索..." : isIndexing ? "正在建立本地文件索引..." : "",
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
    openSettings,
    openFolder,
    launchApp,
    runAsAdmin,
    copyPath,
    hideWindow,
    togglePanelPinned,
    refreshHistory,
    deleteHistoryItem,
    deleteResultItem,
    scrollToTop,
    onItemsRendered,
    trimmedQuery,
    showBackToTop,
    hoveredKey,
    setHoveredKey,
    toast,
    showToast,
    calculatorIconDataUrl,
    selectedActionId,
    clearActionSelection,
    clearSearchInput,
    clearGhostInputValue,
  };
}


