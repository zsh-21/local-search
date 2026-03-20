import { getWindowsSettingsItems, searchSettingsItems } from "../settingsSearch";
import type { SearchExecResult, SearchStrategy } from "./types";

export const settingsStrategy: SearchStrategy = {
  id: "settings",
  async execute(ctx): Promise<SearchExecResult> {
    const settingsItems = getWindowsSettingsItems();
    const { settingsResults, settingsOnly } = searchSettingsItems({
      searchTypeId: ctx.searchTypeId,
      settingsItems,
      computeWeightedNameMatch: ctx.nameScorer.computeWeightedNameMatch,
      computeCombinedScore: ctx.scoreComputer.computeCombinedScore,
    });

    if (settingsOnly) {
      return {
        kind: "return",
        response: {
          results: settingsOnly.results,
          isIndexing: false,
          hasMore: false,
          searchSessionId: ctx.searchSessionId,
          totalCount: settingsOnly.totalCount,
        },
      };
    }

    return { kind: "continue", items: settingsResults };
  },
};
