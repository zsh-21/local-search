import { prefetchIconsInBackground } from "./iconPrefetch";
import type { SearchContext, SearchStrategyDeps } from "./strategies/types";
import { parseSearchMatchIntent } from "../../shared/utils/searchMatch";
import { beginSearchSession } from "./sessionRegistry";
import { createSearchResultId, serializeSearchResult } from "./resultSerializer";
import { createSearchLaneProfile } from "./searchLaneProfile";
import { createLaneContext, runFileAndRecentLane } from "./searchLaneRuntime";
import {
  cancelSearchWorkerSession,
  rankCandidatesFast,
  rankCandidatesFull,
  syncSearchWorkerAppsSnapshot,
} from "./searchMatchWorkerClient";
import type { SearchWorkerCandidate, SearchWorkerRankPayload, SearchWorkerRankResult } from "./searchMatchProtocol";
import type { SearchScoreDebugRow } from "../../shared/types/searchScoreDebug";
import { IPC_EVENT_MORE_RESULTS } from "../../shared/ipc/channels";
import { tryResolveExistingOrRenamedPath } from "../file/pathRecovery";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };
type SearchSerializedResult = ReturnType<typeof serializeSearchResult>;
type SearchIndexHealer = {
  removePath?: (targetPath: string) => Promise<void> | void;
  ingestPath?: (targetPath: string, isDirectory: boolean, timeMs?: number) => Promise<void> | void;
};
type SearchDirectCandidate = SearchWorkerCandidate & {
  isDirectory: boolean;
  source: string;
  rawSource: string;
  sourceScore: number;
  metaFlags: { directPath: true };
};

export type SearchFilesDeps = Omit<SearchStrategyDeps, "getCurrentIconPrefetchToken" | "currentIconPrefetchToken">;

let iconPrefetchToken = 0;
let syncedAppsSnapshotRef: Array<{ Name: string; AppID: string; installTimeMs?: number }> | null = null;

const DISPLAY_LIMIT = 240;
const MORE_BATCH_SIZE = 30;

/** 清理查询文本中的不可见字符。 */
function stripInvisibleChars(input: string) {
  return String(input || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 尝试把输入解析为直接路径候选。 */
async function tryResolveDirectPathCandidate(rawInput: string): Promise<SearchDirectCandidate | null> {
  const s = stripInvisibleChars(rawInput);
  if (!s) return null;
  const normalized = s.replace(/\//g, "\\").trim();
  if (!normalized) return null;
  const isWinAbs = /^[a-zA-Z]:\\/.test(normalized) || normalized.startsWith("\\\\");
  if (!isWinAbs) return null;
  if (!existsSync(normalized)) return null;

  try {
    const st = await fs.stat(normalized);
    const isDirectory = st.isDirectory();
    const timeMs = Math.max(st.mtimeMs || 0, st.birthtimeMs || 0);
    return {
      name: path.win32.basename(normalized),
      path: normalized,
      type: isDirectory ? "folder" : "file",
      isDirectory,
      timeMs,
      source: "pathResolver",
      rawSource: "pathResolver",
      sourceScore: 120,
      metaFlags: { directPath: true },
    };
  } catch {
    return null;
  }
}

/** 规范化搜索类型标识。 */
function normalizeSearchTypeId(raw: unknown) {
  return typeof raw === "string" && raw.trim() ? raw.trim() : "all";
}

/** 规范化会话标识。 */
function normalizeSessionId(raw: unknown) {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 规范化磁盘过滤条件。 */
function normalizeDriveFilter(raw: unknown) {
  const text = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z]$/i.test(text) ? text.toLowerCase() : "";
}

/** 规范化扩展名过滤条件。 */
function normalizeExtFilter(searchTypeId: string) {
  return searchTypeId.startsWith("ext:") ? searchTypeId.slice(4).toLowerCase() : "";
}

/** 搜索下发前修正离线改后缀导致的陈旧路径 */
async function normalizeResultPathForDelivery(
  item: unknown,
  deps: SearchFilesDeps,
  recoverCache: Map<string, Promise<Awaited<ReturnType<typeof tryResolveExistingOrRenamedPath>>>>,
  healedPathSet: Set<string>,
) {
  if (!item || typeof item !== "object") return item;
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type !== "file" && type !== "folder") return item;
  const rawPath = typeof record.path === "string" ? record.path : "";
  if (!rawPath) return item;
  const normalizedPath = rawPath.replace(/\//g, "\\");
  if (existsSync(normalizedPath)) return item;

  const expectedType = type === "folder" ? "folder" : "file";
  const cacheKey = `${expectedType}:${normalizedPath.toLowerCase()}`;
  let task = recoverCache.get(cacheKey);
  if (!task) {
    task = tryResolveExistingOrRenamedPath(normalizedPath, { expectedType });
    recoverCache.set(cacheKey, task);
  }
  const recovered = await task;
  if (!recovered?.resolvedPath) return item;

  if (recovered.recovered && !healedPathSet.has(cacheKey)) {
    healedPathSet.add(cacheKey);
    const fileIndex = deps.fileIndex as SearchStrategyDeps["fileIndex"] & SearchIndexHealer;
    const removePath = fileIndex.removePath;
    const ingestPath = fileIndex.ingestPath;
    try {
      if (typeof removePath === "function") await removePath(normalizedPath);
    } catch {}
    try {
      if (typeof ingestPath === "function") {
        await ingestPath(recovered.resolvedPath, recovered.isDirectory, recovered.timeMs);
      }
    } catch {}
  }

  return {
    ...item,
    path: recovered.resolvedPath,
    name: recovered.name || (typeof record.name === "string" ? record.name : path.basename(recovered.resolvedPath)),
    type: recovered.isDirectory ? "folder" : "file",
    isDirectory: recovered.isDirectory,
    timeMs: recovered.timeMs || (typeof record.timeMs === "number" ? record.timeMs : 0),
  };
}

/** 将安装应用快照同步到 worker。 */
async function ensureAppsSnapshotSynced(getInstalledApps: () => Array<{ Name: string; AppID: string; installTimeMs?: number }>) {
  const apps = getInstalledApps();
  if (apps === syncedAppsSnapshotRef) return;
  const payload = apps.map((app) => ({
    Name: typeof app?.Name === "string" ? app.Name : "",
    AppID: typeof app?.AppID === "string" ? app.AppID : "",
    installTimeMs: typeof app?.installTimeMs === "number" && Number.isFinite(app.installTimeMs) ? app.installTimeMs : 0,
  }));
  await syncSearchWorkerAppsSnapshot(payload);
  syncedAppsSnapshotRef = apps;
}

/** 空评分结果，避免查询命中时出现空对象分支。 */
const NOOP_MATCH = { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };

/** 构建评分明细索引，便于按结果 ID 快速回填。 */
function buildScoreDebugRowMap(rows: SearchScoreDebugRow[] | undefined) {
  const out = new Map<string, SearchScoreDebugRow>();
  if (!Array.isArray(rows) || rows.length <= 0) return out;
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim().toLowerCase() : "";
    if (!id) continue;
    out.set(id, row);
  }
  return out;
}

/** 从当前批次结果中挑选对应的评分明细。 */
function pickScoreDebugRows(results: SearchSerializedResult[], rowsById: Map<string, SearchScoreDebugRow>) {
  if (!Array.isArray(results) || results.length <= 0) return [] as SearchScoreDebugRow[];
  if (rowsById.size <= 0) return [] as SearchScoreDebugRow[];
  const out: SearchScoreDebugRow[] = [];
  const seen = new Set<string>();
  for (const item of results) {
    const key = createSearchResultId(item).toLowerCase();
    if (!key || seen.has(key)) continue;
    const row = rowsById.get(key);
    if (!row) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export async function handleSearchFiles(
  event: Electron.IpcMainInvokeEvent,
  query: string,
  options: SearchFilesOptions | undefined,
  deps: SearchFilesDeps
) {
  const { fileIndex, loadHistoryStats } = deps;
  const rawQueryForEvents = typeof query === "string" ? query : "";
  const searchIntent = parseSearchMatchIntent(rawQueryForEvents);
  const queryForSearch = searchIntent.term;
  const isPathQuery = searchIntent.matchTarget === "path";
  const searchTypeId = normalizeSearchTypeId(options?.searchTypeId);
  const searchSessionId = normalizeSessionId(options?.searchSessionId);

  const session = beginSearchSession({
    event,
    sessionId: searchSessionId,
    cancelSearchSession: (id) => {
      void deps.fileIndex.cancelSearchSession?.(id);
      void cancelSearchWorkerSession(id);
    },
  });
  const isSessionCancelled = session.isCancelled;

  const buildCancelledResponse = (isIndexing: boolean) => ({
    results: [],
    scoreDebugRows: [],
    isIndexing,
    hasMore: false,
    searchSessionId,
    totalCount: 0,
  });

  const status = await fileIndex.getStatus();
  if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);

  if (!queryForSearch || queryForSearch.trim().length < 1) {
    return { results: [], scoreDebugRows: [], isIndexing: status.isIndexing, hasMore: false, searchSessionId, totalCount: 0 };
  }

  const lowerQuery = queryForSearch.trim().toLowerCase();
  if (searchIntent.matchTarget !== "path" && lowerQuery === "clear:cache") {
    const commandResult = {
      name: "\u6e05\u7a7a\u7f13\u5b58\u5e76\u91cd\u5efa\u7d22\u5f15",
      path: "clear:cache",
      type: "command",
      description: "\u6e05\u7a7a\u914d\u7f6e\u3001\u7f13\u5b58\u4e0e\u7d22\u5f15\uff0c\u4e0b\u6b21\u542f\u52a8\u4f1a\u91cd\u65b0\u751f\u6210",
      source: "command",
      rawSource: "command",
      metaFlags: { command: true },
    };
    return {
      results: [serializeSearchResult(commandResult)],
      scoreDebugRows: [],
      isIndexing: false,
      hasMore: false,
      searchSessionId,
      totalCount: 1,
    };
  }

  try {
    await ensureAppsSnapshotSynced(deps.getInstalledApps);
  } catch {
    // apps 快照同步失败时保留上一版快照，不阻断本次搜索
  }

  const currentIconPrefetchToken = ++iconPrefetchToken;
  const driveFilter = normalizeDriveFilter(options?.drive);
  const extFilter = normalizeExtFilter(searchTypeId);
  const now = Date.now();
  const historyStats = loadHistoryStats();
  const runtimeSettings = deps.loadSettings();

  const queryLength = queryForSearch.trim().length;
  const laneProfile = createSearchLaneProfile({
    queryLength,
    isIndexingHint: status.isIndexing,
    searchTypeId,
  });

  const getCurrentIconPrefetchToken = () => iconPrefetchToken;
  const baseCtx: Omit<SearchContext, "lane" | "fileSearchLimit" | "recentLimit"> = {
    event,
    query: queryForSearch,
    lowerQuery,
    isIndexingHint: status.isIndexing,
    isPathQuery,
    searchTypeId,
    searchSessionId,
    isSessionCancelled,
    queryLength,
    driveFilter,
    extFilter,
    now,
    nameScorer: {
      computeWeightedNameMatch: () => NOOP_MATCH,
    },
    scoreComputer: {
      getLastUsedMs: () => 0,
      computeCombinedScore: () => 0,
    },
  };

  /** 装配策略依赖，复用现有输入并补上车道令牌。 */
  const strategyDeps: SearchStrategyDeps = {
    ...deps,
    getCurrentIconPrefetchToken,
    currentIconPrefetchToken,
  };

  const directPathCandidate = await tryResolveDirectPathCandidate(rawQueryForEvents);
  if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);

  const shouldRunFileLanes = searchTypeId !== "app" && searchTypeId !== "settings";

  const fastLaneOutput = shouldRunFileLanes
    ? await runFileAndRecentLane({
        ctx: createLaneContext({
          base: baseCtx,
          lane: "fast",
          fileSearchLimit: laneProfile.fastFileLimit,
          recentLimit: laneProfile.fastRecentLimit,
        }),
        deps: { normalizeRecentKey: deps.normalizeRecentKey },
        strategyDeps,
        isSessionCancelled,
      })
    : { fileItems: [] as SearchWorkerCandidate[], recentItems: [] as SearchWorkerCandidate[], isIndexing: status.isIndexing };

  if (isSessionCancelled()) return buildCancelledResponse(fastLaneOutput.isIndexing);

  /** 构造 worker 排序载荷，保持字段和值语义不变。 */
  const buildRankPayload = (input: {
    lane: "fast" | "full";
    fileItems: SearchWorkerCandidate[];
    recentItems: SearchWorkerCandidate[];
    displayLimit: number;
  }): SearchWorkerRankPayload => ({
    sessionId: searchSessionId,
    query: queryForSearch,
    searchTypeId,
    lane: input.lane,
    matchMode: laneProfile.matchMode,
    isPathQuery,
    displayLimit: input.displayLimit,
    now,
    historyStats,
    searchRanking: runtimeSettings.searchRanking,
    fileItems: Array.isArray(input.fileItems) ? input.fileItems : [],
    recentItems: Array.isArray(input.recentItems) ? input.recentItems : [],
    directItems: directPathCandidate ? [directPathCandidate] : [],
  });

  const fastRank = await rankCandidatesFast(
    buildRankPayload({
      lane: "fast",
      fileItems: fastLaneOutput.fileItems,
      recentItems: fastLaneOutput.recentItems,
      displayLimit: DISPLAY_LIMIT,
    }),
  );

  if (isSessionCancelled() || fastRank.cancelled) return buildCancelledResponse(fastLaneOutput.isIndexing);

  const topCandidates = Array.isArray(fastRank.items) ? fastRank.items : [];
  const fastRowsById = buildScoreDebugRowMap(fastRank.scoreDebugRows);
  const firstBatchLimit = 10;
  const isShortQuery = queryLength <= 2;
  const firstBatch = topCandidates.slice(0, firstBatchLimit);
  const fastRemainingBatch = topCandidates.slice(firstBatchLimit);
  const recoverCache = new Map<string, Promise<Awaited<ReturnType<typeof tryResolveExistingOrRenamedPath>>>>();
  const healedPathSet = new Set<string>();
  const normalizedFirstBatch: SearchWorkerCandidate[] = [];
  for (const candidate of firstBatch) {
    const normalizedCandidate = await normalizeResultPathForDelivery(candidate, deps, recoverCache, healedPathSet);
    if (normalizedCandidate && typeof normalizedCandidate === "object") {
      normalizedFirstBatch.push(normalizedCandidate as SearchWorkerCandidate);
    }
  }
  const firstPayload = normalizedFirstBatch.map(serializeSearchResult);
  const firstScoreDebugRows = pickScoreDebugRows(firstPayload, fastRowsById);

  if (!isSessionCancelled()) {
    prefetchIconsInBackground({
      event,
      query: rawQueryForEvents,
      searchTypeId,
      searchSessionId,
      items: topCandidates.map((it) => serializeSearchResult(it)),
      getCurrentIconPrefetchToken,
      iconPrefetchToken: currentIconPrefetchToken,
      shouldCancel: isSessionCancelled,
    });
  }

  const shouldRunFullLane = !isShortQuery && laneProfile.enableFullLane && shouldRunFileLanes;
  const hasMore = fastRemainingBatch.length > 0 || shouldRunFullLane;

  if (hasMore) {
    const alreadySent = new Set(firstPayload.map((item) => createSearchResultId(item)));
    (async () => {
      /** 发送增量批次结果，避免一次性输出过多。 */
      const emitBatch = async (batchItems: SearchWorkerCandidate[]) => {
        const payload: SearchSerializedResult[] = [];
        for (const item of batchItems) {
          if (isSessionCancelled()) return false;
          const normalizedItem = await normalizeResultPathForDelivery(item, deps, recoverCache, healedPathSet);
          if (!normalizedItem || typeof normalizedItem !== "object") continue;
          const serialized = serializeSearchResult(normalizedItem);
          const key = createSearchResultId(serialized);
          if (!key || alreadySent.has(key)) continue;
          alreadySent.add(key);
          payload.push(serialized);
        }

        if (payload.length > 0 && !isSessionCancelled()) {
          event.sender.send(IPC_EVENT_MORE_RESULTS, {
            query: rawQueryForEvents,
            searchTypeId,
            searchSessionId,
            results: payload,
            scoreDebugRows: pickScoreDebugRows(payload, fastRowsById),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
        return true;
      };

      for (let i = 0; i < fastRemainingBatch.length; i += MORE_BATCH_SIZE) {
        if (currentIconPrefetchToken !== iconPrefetchToken) return;
        const ok = await emitBatch(fastRemainingBatch.slice(i, i + MORE_BATCH_SIZE));
        if (!ok) return;
      }

      if (!shouldRunFullLane) return;
      if (isSessionCancelled()) return;

      const fullLaneOutput = await runFileAndRecentLane({
        ctx: createLaneContext({
          base: baseCtx,
          lane: "full",
          fileSearchLimit: laneProfile.fullFileLimit,
          recentLimit: laneProfile.fullRecentLimit,
        }),
        deps: { normalizeRecentKey: deps.normalizeRecentKey },
        strategyDeps,
        isSessionCancelled,
      });
      if (isSessionCancelled()) return;

      const fullRank = await rankCandidatesFull(
        buildRankPayload({
          lane: "full",
          fileItems: fullLaneOutput.fileItems,
          recentItems: fullLaneOutput.recentItems,
          displayLimit: DISPLAY_LIMIT,
        }),
      );
      if (isSessionCancelled() || fullRank.cancelled) return;

      const fullTop = Array.isArray(fullRank.items) ? fullRank.items : [];
      const fullRowsById = buildScoreDebugRowMap(fullRank.scoreDebugRows);
      for (let i = 0; i < fullTop.length; i += MORE_BATCH_SIZE) {
        if (currentIconPrefetchToken !== iconPrefetchToken) return;
        const payload: SearchSerializedResult[] = [];
        for (const item of fullTop.slice(i, i + MORE_BATCH_SIZE)) {
          if (isSessionCancelled()) return;
          const normalizedItem = await normalizeResultPathForDelivery(item, deps, recoverCache, healedPathSet);
          if (!normalizedItem || typeof normalizedItem !== "object") continue;
          const serialized = serializeSearchResult(normalizedItem);
          const key = createSearchResultId(serialized);
          if (!key || alreadySent.has(key)) continue;
          alreadySent.add(key);
          payload.push(serialized);
        }
        if (payload.length > 0 && !isSessionCancelled()) {
          event.sender.send(IPC_EVENT_MORE_RESULTS, {
            query: rawQueryForEvents,
            searchTypeId,
            searchSessionId,
            results: payload,
            scoreDebugRows: pickScoreDebugRows(payload, fullRowsById),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    })();
  }

  return {
    results: firstPayload,
    scoreDebugRows: firstScoreDebugRows,
    isIndexing: fastLaneOutput.isIndexing,
    hasMore,
    searchSessionId,
    totalCount: Number.isFinite(fastRank.totalCount) ? Math.max(0, Number(fastRank.totalCount)) : 0,
  };
}

