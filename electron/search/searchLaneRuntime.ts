import { fileIndexStrategy } from "./strategies/fileIndexStrategy";
import { createRecentIndexStrategy } from "./strategies/recentIndexStrategy";
import { createSearchResultId } from "./resultSerializer";
import { TopKCollector } from "./topKCollector";
import type { SearchContext, SearchStrategyDeps } from "./strategies/types";
import { isStrictSearchMatch, pickSearchMatchTargetText, type SearchMatchIntent } from "../../shared/searchMatch";

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

export function buildCommandResults(input: {
  searchTypeId: string;
  isPathQuery: boolean;
  lowerQuery: string;
  computeWeightedNameMatch: (name: string) => { weightedScore: number; staticScore: number; matchIndex: number; nameLen: number };
  computeCombinedScore: (args: { staticScore: number; type: string; rawPath: string; timeMs?: number }) => number;
  getLastUsedMs: (rawPath: string) => number;
}) {
  if (input.isPathQuery) return [] as any[];
  if (input.searchTypeId !== "all") return [] as any[];
  if (!input.lowerQuery) return [] as any[];

  const items = [
    {
      name: "\u5173\u673a",
      path: "system:shutdown",
      description: "Shut down the computer",
      keywords: ["shutdown", "poweroff", "\u5173\u673a"],
    },
    {
      name: "\u91cd\u542f\u7535\u8111",
      path: "system:restart",
      description: "Restart the computer",
      keywords: ["restart", "reboot", "\u91cd\u542f", "\u91cd\u542f\u7535\u8111"],
    },
  ];

  const out: any[] = [];
  for (const it of items) {
    let best = { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };
    const candidates = [it.name, ...(it.keywords || [])];
    for (const c of candidates) {
      const r = input.computeWeightedNameMatch(c);
      if (r.weightedScore > best.weightedScore) best = r;
      else if (r.weightedScore === best.weightedScore) {
        if (r.matchIndex < best.matchIndex) best = r;
        else if (r.matchIndex === best.matchIndex && r.nameLen < best.nameLen) best = r;
      }
    }
    if (best.weightedScore <= 0) continue;
    const score = input.computeCombinedScore({
      staticScore: best.staticScore,
      type: "command",
      rawPath: it.path,
      timeMs: input.getLastUsedMs(it.path),
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
}

export function collectTopCandidates(input: {
  limit: number;
  searchIntent: SearchMatchIntent;
  isSessionCancelled: () => boolean;
  buckets: any[][];
}) {
  const collector = new TopKCollector<any>({
    limit: input.limit,
    getKey: (item) => createSearchResultId(item),
    compare: compareCandidates,
  });

  const totalSeenKeys = new Set<string>();
  for (const bucket of input.buckets) {
    for (const item of bucket) {
      if (input.isSessionCancelled()) break;
      if (!item || typeof item !== "object") continue;
      const target = pickSearchMatchTargetText(item, input.searchIntent);
      if (!isStrictSearchMatch(target, input.searchIntent)) continue;
      const key = createSearchResultId(item);
      if (!key) continue;
      totalSeenKeys.add(key);
      collector.add(item);
    }
    if (input.isSessionCancelled()) break;
  }

  return {
    topCandidates: collector.toArray(),
    totalSeenKeys,
  };
}

export function createLaneContext(input: {
  base: Omit<SearchContext, "lane" | "fileSearchLimit" | "recentLimit">;
  lane: "fast" | "full";
  fileSearchLimit: number;
  recentLimit: number;
}): SearchContext {
  return {
    ...input.base,
    lane: input.lane,
    fileSearchLimit: input.fileSearchLimit,
    recentLimit: input.recentLimit,
  };
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

export async function runFileAndRecentLane(input: {
  ctx: SearchContext;
  deps: { normalizeRecentKey: (rawPath: string) => string };
  strategyDeps: SearchStrategyDeps;
  isSessionCancelled: () => boolean;
}) {
  const resultFromFileIndex = await fileIndexStrategy.execute(input.ctx, input.strategyDeps);
  if (input.isSessionCancelled()) return { fileItems: [] as any[], recentItems: [] as any[], isIndexing: false };

  if (resultFromFileIndex.kind === "return") {
    return {
      fileItems: tagSource(asArray(resultFromFileIndex.response.results), "fileIndex"),
      recentItems: [] as any[],
      isIndexing: Boolean(resultFromFileIndex.response.isIndexing),
    };
  }

  const fileItems = tagSource(resultFromFileIndex.items, "fileIndex");
  const isIndexing = Boolean(resultFromFileIndex.meta?.isIndexing);

  const seen = new Set(fileItems.map((x: any) => input.deps.normalizeRecentKey(x.path)));
  const recentStrategy = createRecentIndexStrategy(seen);
  const resultFromRecent = await recentStrategy.execute(input.ctx, input.strategyDeps);
  if (input.isSessionCancelled()) return { fileItems: [] as any[], recentItems: [] as any[], isIndexing };

  const recentItems = resultFromRecent.kind === "continue" ? tagSource(resultFromRecent.items, "recentIndex") : [];
  return { fileItems, recentItems, isIndexing };
}
