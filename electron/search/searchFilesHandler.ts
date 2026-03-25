import { prefetchIconsInBackground } from "./iconPrefetch";
import type { SearchContext, SearchStrategyDeps } from "./strategies/types";
import { parseSearchMatchIntent } from "../../shared/searchMatch";
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
import type { SearchWorkerRankPayload } from "./searchMatchProtocol";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };

export type SearchFilesDeps = Omit<SearchStrategyDeps, "getCurrentIconPrefetchToken" | "currentIconPrefetchToken">;

let iconPrefetchToken = 0;
let syncedAppsSnapshotRef: Array<{ Name: string; AppID: string; installTimeMs?: number }> | null = null;

const DISPLAY_LIMIT = 240;
const MORE_BATCH_SIZE = 30;

function stripInvisibleChars(input: string) {
  return String(input || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function tryResolveDirectPathCandidate(rawInput: string) {
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
    const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
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

function normalizeSearchTypeId(raw: unknown) {
  return typeof raw === "string" && raw.trim() ? raw.trim() : "all";
}

function normalizeSessionId(raw: unknown) {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeDriveFilter(raw: unknown) {
  const text = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z]$/i.test(text) ? text.toLowerCase() : "";
}

function normalizeExtFilter(searchTypeId: string) {
  return searchTypeId.startsWith("ext:") ? searchTypeId.slice(4).toLowerCase() : "";
}

async function ensureAppsSnapshotSynced(getInstalledApps: () => Array<{ Name: string; AppID: string; installTimeMs?: number }>) {
  const apps = getInstalledApps();
  if (apps === syncedAppsSnapshotRef) return;
  const payload = apps.map((app) => ({
    Name: typeof app?.Name === "string" ? app.Name : "",
    AppID: typeof app?.AppID === "string" ? app.AppID : "",
    installTimeMs: Number.isFinite(app?.installTimeMs as number) ? Number(app.installTimeMs) : 0,
  }));
  await syncSearchWorkerAppsSnapshot(payload);
  syncedAppsSnapshotRef = apps;
}

const NOOP_MATCH = { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };

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

  const strategyDeps: SearchStrategyDeps = {
    ...(deps as any),
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
    : { fileItems: [] as any[], recentItems: [] as any[], isIndexing: status.isIndexing };

  if (isSessionCancelled()) return buildCancelledResponse(fastLaneOutput.isIndexing);

  const buildRankPayload = (input: {
    lane: "fast" | "full";
    fileItems: any[];
    recentItems: any[];
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
  const firstBatchLimit = 10;
  const isShortQuery = queryLength <= 2;
  const firstBatch = topCandidates.slice(0, firstBatchLimit);
  const fastRemainingBatch = topCandidates.slice(firstBatchLimit);
  const firstPayload = firstBatch.map(serializeSearchResult);

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
      const emitBatch = async (batchItems: any[]) => {
        const payload: any[] = [];
        for (const item of batchItems) {
          if (isSessionCancelled()) return false;
          const serialized = serializeSearchResult(item);
          const key = createSearchResultId(serialized);
          if (!key || alreadySent.has(key)) continue;
          alreadySent.add(key);
          payload.push(serialized);
        }

        if (payload.length > 0 && !isSessionCancelled()) {
          event.sender.send("more-results", {
            query: rawQueryForEvents,
            searchTypeId,
            searchSessionId,
            results: payload,
            scoreDebugRows: [],
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
      for (let i = 0; i < fullTop.length; i += MORE_BATCH_SIZE) {
        if (currentIconPrefetchToken !== iconPrefetchToken) return;
        const ok = await emitBatch(fullTop.slice(i, i + MORE_BATCH_SIZE));
        if (!ok) return;
      }
    })();
  }

  return {
    results: firstPayload,
    scoreDebugRows: [],
    isIndexing: fastLaneOutput.isIndexing,
    hasMore,
    searchSessionId,
    totalCount: Number.isFinite(fastRank.totalCount) ? Math.max(0, Number(fastRank.totalCount)) : 0,
  };
}
