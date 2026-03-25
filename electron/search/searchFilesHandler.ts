import { createNameScorer, createScoreComputer } from "./scoring";
import { prefetchIconsInBackground } from "./iconPrefetch";
import { appsStrategy } from "./strategies/appsStrategy";
import { settingsStrategy } from "./strategies/settingsStrategy";
import type { SearchContext, SearchStrategyDeps } from "./strategies/types";
import { isStrictSearchMatch, parseSearchMatchIntent, pickSearchMatchTargetText } from "../../shared/searchMatch";
import { beginSearchSession } from "./sessionRegistry";
import { createSearchResultId, serializeSearchResult } from "./resultSerializer";
import { createSearchLaneProfile } from "./searchLaneProfile";
import { buildCommandResults, collectTopCandidates, createLaneContext, runFileAndRecentLane } from "./searchLaneRuntime";
import type { SearchScoreDebugRow } from "../../shared/searchScoreDebug";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };

export type SearchFilesDeps = Omit<SearchStrategyDeps, "getCurrentIconPrefetchToken" | "currentIconPrefetchToken">;

let iconPrefetchToken = 0;

const DISPLAY_LIMIT = 240;
const MORE_BATCH_SIZE = 30;
const FAST_COMMAND_LIMIT = 5;
const FULL_COMMAND_LIMIT = 12;
const FAST_SETTINGS_LIMIT = 10;
const FULL_SETTINGS_LIMIT = 20;
const FAST_APPS_LIMIT = 12;
const FULL_APPS_LIMIT = 50;

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

function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function tagSource(items: any[], source: string) {
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (typeof item.source === "string" && item.source) return item;
    return { ...item, source };
  });
}

function sliceSource(items: any[], limit: number) {
  if (limit <= 0) return [] as any[];
  if (!Array.isArray(items)) return [] as any[];
  return items.length > limit ? items.slice(0, limit) : items;
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

export async function handleSearchFiles(
  event: Electron.IpcMainInvokeEvent,
  query: string,
  options: SearchFilesOptions | undefined,
  deps: SearchFilesDeps
) {
  const { fileIndex, loadHistoryStats, normalizeHistoryKey, normalizeExtKey } = deps;
  const rawQueryForEvents = typeof query === "string" ? query : "";
  const searchIntent = parseSearchMatchIntent(rawQueryForEvents);
  const queryForSearch = searchIntent.term;
  const isPathQuery = searchIntent.matchTarget === "path";
  const searchTypeId = normalizeSearchTypeId(options?.searchTypeId);
  const searchSessionId = normalizeSessionId(options?.searchSessionId);

  const session = beginSearchSession({
    event,
    sessionId: searchSessionId,
    cancelSearchSession: (id) => void deps.fileIndex.cancelSearchSession?.(id),
  });
  const isSessionCancelled = session.isCancelled;

  const buildCancelledResponse = (isIndexing: boolean) => ({
    results: [],
    isIndexing,
    hasMore: false,
    searchSessionId,
    totalCount: 0,
  });

  const status = await fileIndex.getStatus();
  if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);

  if (!queryForSearch || queryForSearch.trim().length < 1) {
    return { results: [], isIndexing: status.isIndexing, hasMore: false, searchSessionId, totalCount: 0 };
  }

  const queryLength = queryForSearch.trim().length;
  const laneProfile = createSearchLaneProfile({
    queryLength,
    isIndexingHint: status.isIndexing,
    searchTypeId,
  });

  const nameScorer = createNameScorer(queryForSearch, { mode: laneProfile.matchMode });
  const { lowerQuery, computeWeightedNameMatch, scoreRecentName } = nameScorer;
  const filterStrictResults = <T extends { name?: string; path?: string }>(items: T[]) =>
    items.filter((item) => {
      const target = pickSearchMatchTargetText(item, searchIntent);
      return isStrictSearchMatch(target, searchIntent);
    });

  if (searchIntent.matchTarget !== "path" && lowerQuery === "clear:cache") {
    const commandResult = {
      name: "\u6e05\u7a7a\u7f13\u5b58\u5e76\u91cd\u5efa\u7d22\u5f15",
      path: "clear:cache",
      type: "command",
      description: "\u6e05\u7a7a\u914d\u7f6e\u3001\u7f13\u5b58\u4e0e\u7d22\u5f15\uff0c\u4e0b\u6b21\u542f\u52a8\u4f1a\u91cd\u65b0\u751f\u6210",
      source: "command",
      metaFlags: { command: true },
    };
    return {
      results: [serializeSearchResult(commandResult)],
      isIndexing: false,
      hasMore: false,
      searchSessionId,
      totalCount: 1,
    };
  }

  const currentIconPrefetchToken = ++iconPrefetchToken;
  const driveFilter = normalizeDriveFilter(options?.drive);
  const extFilter = normalizeExtFilter(searchTypeId);

  const now = Date.now();
  const historyStats = loadHistoryStats();
  const runtimeSettings = deps.loadSettings();
  const { getLastUsedMs, computeCombinedScore, computeCombinedScoreDetail } = createScoreComputer({
    now,
    historyStats,
    normalizeHistoryKey,
    normalizeExtKey,
    searchRanking: runtimeSettings.searchRanking,
  });

  const commandResults = buildCommandResults({
    searchTypeId,
    isPathQuery,
    lowerQuery,
    computeWeightedNameMatch,
    computeCombinedScore,
    getLastUsedMs,
  });

  const buildScoreDebugRow = (item: any): SearchScoreDebugRow | null => {
    if (!item || typeof item !== "object") return null;
    const name = typeof item.name === "string" ? item.name : "";
    const path = typeof item.path === "string" ? item.path : "";
    const type = typeof item.type === "string" ? item.type : "file";
    const id = createSearchResultId({ type, path, name });
    if (!id) return null;

    const staticScore =
      typeof item.staticScore === "number" && Number.isFinite(item.staticScore)
        ? clamp01(item.staticScore)
        : clamp01(computeWeightedNameMatch(name).staticScore);
    const timeMs = Number.isFinite(item.timeMs as number) ? Math.max(0, Number(item.timeMs)) : 0;
    const sourceScore = Number.isFinite(item.sourceScore as number) ? Number(item.sourceScore) : 0;
    const detail = computeCombinedScoreDetail({
      staticScore,
      type,
      rawPath: path,
      timeMs,
      sourceScore,
    });

    return {
      id,
      name,
      path,
      type,
      source: typeof item.source === "string" ? item.source : "",
      totalScore: detail.totalScore,
      sourceBonusScore: detail.sourceBonusScore,
      extBonusScore: detail.extBonusScore,
      extKey: detail.extKey,
      scoreByMatch: detail.scoreByMatch,
      scoreByFrequency: detail.scoreByFrequency,
      scoreByRecency: detail.scoreByRecency,
      scoreByFileMtime: detail.scoreByFileMtime,
      staticScore: detail.staticScore,
      staticWithType: detail.staticWithType,
      frequencyScore: detail.frequencyScore,
      recencyScore: detail.recencyScore,
      fileMtimeScore: detail.fileMtimeScore,
      weightMatch: detail.weightMatch,
      weightFrequency: detail.weightFrequency,
      weightRecency: detail.weightRecency,
      weightFileMtime: detail.weightFileMtime,
      priorityType: detail.priorityType,
      priorityValue: detail.priorityValue,
      priorityNorm: detail.priorityNorm,
      historyCount: detail.historyCount,
      historyLastUsedMs: detail.historyLastUsedMs,
      itemTimeMs: detail.itemTimeMs,
      effectiveRecencyTimeMs: detail.effectiveRecencyTimeMs,
      fileMtimeSource: detail.fileMtimeSource,
    };
  };

  const buildScoreDebugRows = (items: any[]): SearchScoreDebugRow[] => {
    const rows: SearchScoreDebugRow[] = [];
    for (const item of items || []) {
      const row = buildScoreDebugRow(item);
      if (row) rows.push(row);
    }
    return rows;
  };

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
    nameScorer: { computeWeightedNameMatch, scoreRecentName },
    scoreComputer: { getLastUsedMs, computeCombinedScore },
  };

  const strategyDeps: SearchStrategyDeps = {
    ...(deps as any),
    getCurrentIconPrefetchToken,
    currentIconPrefetchToken,
  };

  const directPathCandidate = await tryResolveDirectPathCandidate(rawQueryForEvents);
  if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);

  const fastCtx = createLaneContext({
    base: baseCtx,
    lane: "fast",
    fileSearchLimit: laneProfile.fastFileLimit,
    recentLimit: laneProfile.fastRecentLimit,
  });

  const resultFromSettings = await settingsStrategy.execute(fastCtx, strategyDeps);
  if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);
  if (resultFromSettings.kind === "return") {
    const strictSettings = filterStrictResults(asArray(resultFromSettings.response.results));
    return {
      ...resultFromSettings.response,
      results: strictSettings.map(serializeSearchResult),
      scoreDebugRows: buildScoreDebugRows(strictSettings),
      totalCount: strictSettings.length,
      hasMore: false,
    };
  }
  const settingsResults = tagSource(resultFromSettings.items, "settings");

  const resultFromApps = await appsStrategy.execute(fastCtx, strategyDeps);
  if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);
  if (resultFromApps.kind === "return") {
    const strictApps = filterStrictResults(asArray(resultFromApps.response.results));
    return {
      ...resultFromApps.response,
      results: strictApps.map(serializeSearchResult),
      scoreDebugRows: buildScoreDebugRows(strictApps),
      totalCount: strictApps.length,
      hasMore: false,
    };
  }
  const appResults = tagSource(resultFromApps.items, "apps");

  const { fileItems: fastFileItems, recentItems: fastRecentItems, isIndexing } = await runFileAndRecentLane({
    ctx: fastCtx,
    deps: { normalizeRecentKey: deps.normalizeRecentKey },
    strategyDeps,
    isSessionCancelled,
  });
  if (isSessionCancelled()) return buildCancelledResponse(isIndexing);

  const directCandidates = (() => {
    if (!directPathCandidate) return [] as any[];
    const score = computeCombinedScore({
      staticScore: 1,
      type: directPathCandidate.type,
      rawPath: directPathCandidate.path,
      timeMs: directPathCandidate.timeMs || 0,
    });
    return [
      {
        ...directPathCandidate,
        score,
        staticScore: 1,
        weightedScore: 10_000,
        matchIndex: 0,
        nameLen: 1,
      },
    ];
  })();

  const fastCollected = collectTopCandidates({
    limit: DISPLAY_LIMIT,
    searchIntent,
    isSessionCancelled,
    buckets: [
      directCandidates,
      sliceSource(commandResults, FAST_COMMAND_LIMIT),
      sliceSource(settingsResults, FAST_SETTINGS_LIMIT),
      sliceSource(appResults, FAST_APPS_LIMIT),
      fastFileItems,
      fastRecentItems,
    ],
  });
  if (isSessionCancelled()) return buildCancelledResponse(isIndexing);

  const topCandidates = fastCollected.topCandidates;
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

  const shouldRunFullLane = !isShortQuery && laneProfile.enableFullLane;
  const hasMore = !isShortQuery && (fastRemainingBatch.length > 0 || shouldRunFullLane);

  if (hasMore) {
    const alreadySent = new Set(firstPayload.map((item) => createSearchResultId(item)));
    (async () => {
      const emitBatch = async (batchItems: any[]) => {
        const payload: any[] = [];
        const scoreDebugRows: SearchScoreDebugRow[] = [];
        for (const item of batchItems) {
          if (isSessionCancelled()) return false;
          const serialized = serializeSearchResult(item);
          const key = createSearchResultId(serialized);
          if (!key || alreadySent.has(key)) continue;
          alreadySent.add(key);

          payload.push(serialized);
          const row = buildScoreDebugRow(item);
          if (row) scoreDebugRows.push(row);
        }

        if (payload.length > 0 && !isSessionCancelled()) {
          event.sender.send("more-results", {
            query: rawQueryForEvents,
            searchTypeId,
            searchSessionId,
            results: payload,
            scoreDebugRows,
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

      const fullCtx = createLaneContext({
        base: baseCtx,
        lane: "full",
        fileSearchLimit: laneProfile.fullFileLimit,
        recentLimit: laneProfile.fullRecentLimit,
      });

      const { fileItems: fullFileItems, recentItems: fullRecentItems } = await runFileAndRecentLane({
        ctx: fullCtx,
        deps: { normalizeRecentKey: deps.normalizeRecentKey },
        strategyDeps,
        isSessionCancelled,
      });
      if (isSessionCancelled()) return;

      const fullCollected = collectTopCandidates({
        limit: DISPLAY_LIMIT,
        searchIntent,
        isSessionCancelled,
        buckets: [
          directCandidates,
          sliceSource(commandResults, FULL_COMMAND_LIMIT),
          sliceSource(settingsResults, FULL_SETTINGS_LIMIT),
          sliceSource(appResults, FULL_APPS_LIMIT),
          fullFileItems,
          fullRecentItems,
        ],
      });

      const fullTop = fullCollected.topCandidates;
      for (let i = 0; i < fullTop.length; i += MORE_BATCH_SIZE) {
        if (currentIconPrefetchToken !== iconPrefetchToken) return;
        const ok = await emitBatch(fullTop.slice(i, i + MORE_BATCH_SIZE));
        if (!ok) return;
      }
    })();
  }

  return {
    results: firstPayload,
    scoreDebugRows: buildScoreDebugRows(firstBatch),
    isIndexing,
    hasMore,
    searchSessionId,
    totalCount: fastCollected.totalSeenKeys.size,
  };
}
