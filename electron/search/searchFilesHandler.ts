import { createNameScorer, createScoreComputer } from "./scoring";
import { prefetchIconsInBackground } from "./iconPrefetch";
import { appsStrategy } from "./strategies/appsStrategy";
import { fileIndexStrategy } from "./strategies/fileIndexStrategy";
import { createRecentIndexStrategy } from "./strategies/recentIndexStrategy";
import { settingsStrategy } from "./strategies/settingsStrategy";
import type { SearchContext, SearchStrategyDeps } from "./strategies/types";
import { isStrictSearchMatch, parseSearchMatchIntent, pickSearchMatchTargetText } from "../../shared/searchMatch";
import { beginSearchSession } from "./sessionRegistry";
import { TopKCollector } from "./topKCollector";
import { createSearchResultId, serializeSearchResult } from "./resultSerializer";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };

export type SearchFilesDeps = Omit<SearchStrategyDeps, "getCurrentIconPrefetchToken" | "currentIconPrefetchToken">;

let iconPrefetchToken = 0;

const DISPLAY_LIMIT = 500;
const FIRST_BATCH_LIMIT = 70;
const MORE_BATCH_SIZE = 50;

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

function compareCandidates(a: any, b: any) {
  const sa = typeof a?.score === "number" ? a.score : 0;
  const sb = typeof b?.score === "number" ? b.score : 0;
  if (sa > sb) return -1;
  if (sa < sb) return 1;

  const ia = typeof a?.matchIndex === "number" ? a.matchIndex : 1_000_000;
  const ib = typeof b?.matchIndex === "number" ? b.matchIndex : 1_000_000;
  if (ia < ib) return -1;
  if (ia > ib) return 1;

  const na = typeof a?.nameLen === "number" ? a.nameLen : 1_000_000;
  const nb = typeof b?.nameLen === "number" ? b.nameLen : 1_000_000;
  if (na < nb) return -1;
  if (na > nb) return 1;

  return 0;
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

export async function handleSearchFiles(
  event: Electron.IpcMainInvokeEvent,
  query: string,
  options: SearchFilesOptions | undefined,
  deps: SearchFilesDeps
) {
  const { fileIndex, loadHistoryStats, normalizeHistoryKey, normalizeExtKey, iconDataCache } = deps;
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

  try {
    const status = await fileIndex.getStatus();
    if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);

    if (!queryForSearch || queryForSearch.trim().length < 1) {
      return { results: [], isIndexing: status.isIndexing, hasMore: false, searchSessionId, totalCount: 0 };
    }

    fileIndex.pauseIndexingFor(status.isIndexing ? 2000 : 900);

    const nameScorer = createNameScorer(queryForSearch);
    const { lowerQuery, computeWeightedNameMatch, scoreRecentName } = nameScorer;
    const filterStrictResults = <T extends { name?: string; path?: string }>(items: T[]) =>
      items.filter((item) => {
        const target = pickSearchMatchTargetText(item, searchIntent);
        return isStrictSearchMatch(target, searchIntent);
      });

    if (searchIntent.matchTarget !== "path" && lowerQuery === "clear:cache") {
      const commandResult = {
        name: "清空缓存并重建索引",
        path: "clear:cache",
        type: "command",
        description: "清空配置、缓存与索引，下次启动会重新生成",
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
    const { getLastUsedMs, computeCombinedScore } = createScoreComputer({
      now,
      historyStats,
      normalizeHistoryKey,
      normalizeExtKey,
      searchRanking: runtimeSettings.searchRanking,
    });

    const commandResults = (() => {
      if (searchIntent.matchTarget === "path") return [] as any[];
      if (searchTypeId !== "all") return [] as any[];

      const items = [
        {
          name: "关机",
          path: "system:shutdown",
          description: "Shut down the computer",
          keywords: ["shutdown", "poweroff", "关机"],
        },
        {
          name: "重启电脑",
          path: "system:restart",
          description: "Restart the computer",
          keywords: ["restart", "reboot", "重启", "重启电脑"],
        },
      ];

      const out: any[] = [];
      for (const it of items) {
        let best = { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };
        const candidates = [it.name, ...(it.keywords || [])];
        for (const c of candidates) {
          const r = computeWeightedNameMatch(c);
          if (r.weightedScore > best.weightedScore) best = r;
          else if (r.weightedScore === best.weightedScore) {
            if (r.matchIndex < best.matchIndex) best = r;
            else if (r.matchIndex === best.matchIndex && r.nameLen < best.nameLen) best = r;
          }
        }
        if (best.weightedScore <= 0) continue;
        const score = computeCombinedScore({
          staticScore: best.staticScore,
          type: "command",
          rawPath: it.path,
          timeMs: getLastUsedMs(it.path),
        });
        out.push({
          name: it.name,
          path: it.path,
          type: "command",
          description: it.description,
          score,
          staticScore: best.staticScore,
          weightedScore: best.weightedScore,
          matchIndex: best.matchIndex,
          nameLen: best.nameLen,
          source: "command",
          metaFlags: { command: true },
        });
      }
      return out;
    })();

    const getCurrentIconPrefetchToken = () => iconPrefetchToken;
    const ctx: SearchContext = {
      event,
      query: queryForSearch,
      lowerQuery,
      isIndexingHint: status.isIndexing,
      isPathQuery,
      searchTypeId,
      searchSessionId,
      isSessionCancelled,
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

    const resultFromSettings = await settingsStrategy.execute(ctx, strategyDeps);
    if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);
    if (resultFromSettings.kind === "return") {
      const strictSettings = filterStrictResults(asArray(resultFromSettings.response.results));
      return {
        ...resultFromSettings.response,
        results: strictSettings.map(serializeSearchResult),
        totalCount: strictSettings.length,
        hasMore: false,
      };
    }
    const settingsResults = tagSource(resultFromSettings.items, "settings");

    const resultFromApps = await appsStrategy.execute(ctx, strategyDeps);
    if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);
    if (resultFromApps.kind === "return") {
      const strictApps = filterStrictResults(asArray(resultFromApps.response.results));
      return {
        ...resultFromApps.response,
        results: strictApps.map(serializeSearchResult),
        totalCount: strictApps.length,
        hasMore: false,
      };
    }
    const appResults = tagSource(resultFromApps.items, "apps");

    const resultFromFileIndex = await fileIndexStrategy.execute(ctx, strategyDeps);
    if (isSessionCancelled()) return buildCancelledResponse(status.isIndexing);
    if (resultFromFileIndex.kind === "return") {
      return {
        ...resultFromFileIndex.response,
        results: asArray(resultFromFileIndex.response.results).map(serializeSearchResult),
      };
    }
    const scoredFiles = tagSource(resultFromFileIndex.items, "fileIndex");
    const isIndexing = Boolean(resultFromFileIndex.meta?.isIndexing);

    const seen = new Set(scoredFiles.map((x: any) => deps.normalizeRecentKey(x.path)));
    const recentStrategy = createRecentIndexStrategy(seen);
    const resultFromRecent = await recentStrategy.execute(ctx, strategyDeps);
    if (isSessionCancelled()) return buildCancelledResponse(isIndexing);
    if (resultFromRecent.kind === "return") {
      return {
        ...resultFromRecent.response,
        results: asArray(resultFromRecent.response.results).map(serializeSearchResult),
      };
    }
    const recentBoostCandidates = tagSource(resultFromRecent.items, "recentIndex");

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

    const collector = new TopKCollector<any>({
      limit: DISPLAY_LIMIT,
      getKey: (item) => createSearchResultId(item),
      compare: compareCandidates,
    });

    const totalSeenKeys = new Set<string>();
    const pushCandidates = (items: any[]) => {
      for (const item of items) {
        if (isSessionCancelled()) break;
        if (!item || typeof item !== "object") continue;
        const target = pickSearchMatchTargetText(item, searchIntent);
        if (!isStrictSearchMatch(target, searchIntent)) continue;

        const key = createSearchResultId(item);
        if (!key) continue;
        totalSeenKeys.add(key);
        collector.add(item);
      }
    };

    pushCandidates(directCandidates);
    pushCandidates(commandResults);
    pushCandidates(settingsResults);
    pushCandidates(appResults);
    pushCandidates(scoredFiles);
    pushCandidates(recentBoostCandidates);

    if (isSessionCancelled()) return buildCancelledResponse(isIndexing);

    const topCandidates = collector.toArray();
    const firstBatch = topCandidates.slice(0, FIRST_BATCH_LIMIT);
    const remainingBatch = topCandidates.slice(FIRST_BATCH_LIMIT);

    const firstPayload = firstBatch.map(serializeSearchResult);

    if (!status.isIndexing && !isSessionCancelled()) {
      prefetchIconsInBackground({
        event,
        query: rawQueryForEvents,
        searchTypeId,
        searchSessionId,
        items: topCandidates.map((it) => ({
          name: String(it?.name || ""),
          path: String(it?.path || ""),
          type: String(it?.type || ""),
        })),
        iconDataCache,
        getFileIconData: deps.getFileIconData,
        getAppIconDataStable: deps.getAppIconDataStable,
        getCurrentIconPrefetchToken,
        iconPrefetchToken: currentIconPrefetchToken,
        shouldCancel: isSessionCancelled,
      });
    }

    if (remainingBatch.length > 0) {
      (async () => {
        for (let i = 0; i < remainingBatch.length; i += MORE_BATCH_SIZE) {
          if (isSessionCancelled()) return;
          if (currentIconPrefetchToken !== iconPrefetchToken) return;

          const batch = remainingBatch.slice(i, i + MORE_BATCH_SIZE);
          const backgroundResults = batch
            .filter(Boolean)
            .map((r: any) => {
              const serialized = serializeSearchResult(r);
              if (serialized.type === "file" || serialized.type === "folder") {
                const cached = iconDataCache.get(`file:${serialized.path}`) || "";
                return cached ? { ...serialized, icon: cached } : serialized;
              }
              if (serialized.type === "app") {
                const cached = iconDataCache.get(`app:${serialized.path}`) || "";
                return cached ? { ...serialized, icon: cached } : serialized;
              }
              return serialized;
            });

          if (!isSessionCancelled() && backgroundResults.length > 0) {
            event.sender.send("more-results", {
              query: rawQueryForEvents,
              searchTypeId,
              searchSessionId,
              results: backgroundResults,
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      })();
    }

    return {
      results: firstPayload,
      isIndexing,
      hasMore: remainingBatch.length > 0,
      searchSessionId,
      totalCount: totalSeenKeys.size,
    };
  } finally {
    session.finish();
  }
}
