import { fileIndexStrategy } from "./strategies/fileIndexStrategy";
import { createRecentIndexStrategy } from "./strategies/recentIndexStrategy";
import type { SearchContext, SearchStrategyDeps } from "./strategies/types";

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
    return { ...item, source, rawSource: source };
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
