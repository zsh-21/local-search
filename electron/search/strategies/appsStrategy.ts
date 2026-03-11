import { searchApps } from "../appSearch";
import type { SearchExecResult, SearchStrategy, SearchStrategyDeps } from "./types";

export const appsStrategy: SearchStrategy = {
  id: "apps",
  async execute(ctx, deps: SearchStrategyDeps): Promise<SearchExecResult> {
    const appResults: any[] = await searchApps({
      searchTypeId: ctx.searchTypeId,
      lowerQuery: ctx.lowerQuery,
      getInstalledApps: deps.getInstalledApps,
      normalizeAppGroupKey: deps.normalizeAppGroupKey,
      iconDataCache: deps.iconDataCache,
      isTooSmallAppIconDataUrl: deps.isTooSmallAppIconDataUrl,
      getAppIconDataStable: deps.getAppIconDataStable,
      scoreRecentName: ctx.nameScorer.scoreRecentName,
      computeWeightedNameMatch: ctx.nameScorer.computeWeightedNameMatch,
      computeCombinedScore: ctx.scoreComputer.computeCombinedScore,
      getLastUsedMs: ctx.scoreComputer.getLastUsedMs,
      event: ctx.event,
      query: ctx.query,
      searchSessionId: ctx.searchSessionId,
      iconPrefetchToken: deps.currentIconPrefetchToken,
      getCurrentIconPrefetchToken: deps.getCurrentIconPrefetchToken,
    });

    if (ctx.searchTypeId === "app") {
      const isIndexing = (await deps.fileIndex.getStatus()).isIndexing;
      return {
        kind: "return",
        response: {
          results: appResults,
          isIndexing,
          hasMore: false,
          searchSessionId: ctx.searchSessionId,
          totalCount: appResults.length,
        },
      };
    }

    return { kind: "continue", items: appResults };
  },
};

