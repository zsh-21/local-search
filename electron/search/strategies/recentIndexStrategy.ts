import type { SearchCandidate, SearchContext, SearchExecResult, SearchStrategy, SearchStrategyDeps } from "./types";

function isShortcutPath(p: string) {
  const lower = String(p || "").toLowerCase();
  return lower.endsWith(".lnk") || lower.endsWith(".url");
}

export function createRecentIndexStrategy(seenPathKeys: Set<string>): SearchStrategy {
  return {
    id: "recentIndex",
    async execute(ctx: SearchContext, deps: SearchStrategyDeps): Promise<SearchExecResult> {
      const items = Array.from(deps.recentIndex.values());
      items.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));

      const out: SearchCandidate[] = [];
      for (const it of items) {
        const key = deps.normalizeRecentKey(it.path);
        if (!key || seenPathKeys.has(key)) continue;
        if (isShortcutPath(it.path)) continue;
        if (deps.isIgnoredPathByCache(it.path)) continue;
        if (ctx.driveFilter && !it.path.toLowerCase().startsWith(`${ctx.driveFilter}:\\`)) continue;
        if (ctx.extFilter && !String(it.path).toLowerCase().endsWith(ctx.extFilter)) continue;
        if (ctx.searchTypeId === "file" && String(it.path).toLowerCase().endsWith(".exe")) continue;
        if (process.platform === "win32" && !/^[a-zA-Z]:/.test(it.path) && !it.path.startsWith("\\\\")) continue;

        const weighted = ctx.nameScorer.computeWeightedNameMatch(it.name);
        const legacy = ctx.nameScorer.scoreRecentName(it.name);
        const baseWeighted = legacy > 0 ? legacy / 25 : weighted.weightedScore > 0 ? weighted.weightedScore : 0;
        if (baseWeighted <= 0) continue;

        const type = it.isDirectory ? "folder" : "file";
        const score = ctx.scoreComputer.computeCombinedScore(baseWeighted * 100, type, it.path, it.timeMs || 0);
        out.push({ name: it.name, path: it.path, type, score, timeMs: it.timeMs || 0 });

        seenPathKeys.add(key);
        if (out.length >= 350) break;
      }

      return { kind: "continue", items: out };
    },
  };
}

