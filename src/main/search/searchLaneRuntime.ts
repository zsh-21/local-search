import { fileIndexStrategy } from "./strategies/fileIndexStrategy";
import { createRecentIndexStrategy } from "./strategies/recentIndexStrategy";
import type { SearchCandidate, SearchContext, SearchStrategyDeps } from "./strategies/types";

/** 带来源字段的搜索结果类型。 */
type SearchTaggedCandidate = SearchCandidate & {
  source?: string;
  rawSource?: string;
};

/** 构建单个搜索车道上下文，保持公共字段一致。 */
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

/** 将未知值收敛为数组，避免把运行时返回值直接扩散为宽类型。 */
function asArray(value: unknown): SearchTaggedCandidate[] {
  return Array.isArray(value) ? (value as SearchTaggedCandidate[]) : [];
}

/** 为结果补充来源字段，保持原有结构不变。 */
function tagSource(items: ReadonlyArray<unknown>, source: string): SearchTaggedCandidate[] {
  return items.map((item) => {
    if (!item || typeof item !== "object") return item as SearchCandidate;
    const record = item as SearchTaggedCandidate;
    if (typeof record.source === "string" && record.source) return record;
    return { ...record, source, rawSource: source };
  });
}

/** 运行文件与最近记录两个车道，并合并去重后的结果。 */
export async function runFileAndRecentLane(input: {
  ctx: SearchContext;
  deps: { normalizeRecentKey: (rawPath: string) => string };
  strategyDeps: SearchStrategyDeps;
  isSessionCancelled: () => boolean;
}) {
  const resultFromFileIndex = await fileIndexStrategy.execute(input.ctx, input.strategyDeps);
  if (input.isSessionCancelled()) return { fileItems: [] as SearchTaggedCandidate[], recentItems: [] as SearchTaggedCandidate[], isIndexing: false };

  if (resultFromFileIndex.kind === "return") {
    return {
      fileItems: tagSource(asArray(resultFromFileIndex.response.results), "fileIndex"),
      recentItems: [] as SearchTaggedCandidate[],
      isIndexing: Boolean(resultFromFileIndex.response.isIndexing),
    };
  }

  const fileItems = tagSource(resultFromFileIndex.items, "fileIndex");
  const isIndexing = Boolean(resultFromFileIndex.meta?.isIndexing);

  const seen = new Set(
    fileItems
      .map((item) => (item && typeof item.path === "string" ? input.deps.normalizeRecentKey(item.path) : ""))
      .filter(Boolean),
  );
  const recentStrategy = createRecentIndexStrategy(seen);
  const resultFromRecent = await recentStrategy.execute(input.ctx, input.strategyDeps);
  if (input.isSessionCancelled()) return { fileItems: [] as SearchTaggedCandidate[], recentItems: [] as SearchTaggedCandidate[], isIndexing };

  const recentItems = resultFromRecent.kind === "continue" ? tagSource(resultFromRecent.items, "recentIndex") : [];
  return { fileItems, recentItems, isIndexing };
}
