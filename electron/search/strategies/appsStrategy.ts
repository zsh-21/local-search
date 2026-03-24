import { searchApps } from "../appSearch";
import type { SearchExecResult, SearchStrategy, SearchStrategyDeps } from "./types";

export const appsStrategy: SearchStrategy = {
  id: "apps",
  async execute(ctx, deps: SearchStrategyDeps): Promise<SearchExecResult> {
    if (ctx.isSessionCancelled()) return { kind: "continue", items: [] };

    const appResults: any[] = await searchApps({
      searchTypeId: ctx.searchTypeId,
      lowerQuery: ctx.lowerQuery,
      lane: ctx.lane,
      getInstalledApps: deps.getInstalledApps,
      normalizeAppGroupKey: deps.normalizeAppGroupKey,
      computeWeightedNameMatch: ctx.nameScorer.computeWeightedNameMatch,
      computeCombinedScore: ctx.scoreComputer.computeCombinedScore,
      getLastUsedMs: ctx.scoreComputer.getLastUsedMs,
    });

    if (ctx.isSessionCancelled()) return { kind: "continue", items: [] };

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
