import { deriveIconKey } from "../icon/iconKey";

export async function searchApps(input: {
  searchTypeId: string;
  lowerQuery: string;
  lane?: "fast" | "full";
  getInstalledApps: () => Array<{ Name: string; AppID: string }>;
  normalizeAppGroupKey: (name: string) => string;
  computeWeightedNameMatch: (name: string) => { weightedScore: number; staticScore: number; matchIndex: number; nameLen: number };
  computeCombinedScore: (input: { staticScore: number; type: string; rawPath: string; timeMs?: number; sourceScore?: number }) => number;
  getLastUsedMs: (rawPath: string) => number;
}) {
  const {
    searchTypeId,
    lowerQuery,
    lane,
    getInstalledApps,
    normalizeAppGroupKey,
    computeWeightedNameMatch,
    computeCombinedScore,
    getLastUsedMs,
  } = input;

  if (searchTypeId !== "all" && searchTypeId !== "app") return [];
  const isShortcutAppId = (appId: string) => {
    const lower = String(appId || "").toLowerCase();
    return lower.endsWith(".lnk") || lower.endsWith(".url");
  };

  const installedApps = getInstalledApps();
  const laneLimit = lane === "fast" ? 12 : 50;
  const actionTokens = ["卸载", "uninstall", "remove", "删除", "移除"];
  const isActionQuery = actionTokens.some((t) => lowerQuery.includes(t));

  const matchedGroupKeys = new Set<string>();
  const matchedAppIds = new Set<string>();
  const results: Array<{
    name: string;
    path: string;
    type: string;
    iconKey: string;
    score: number;
    staticScore: number;
    weightedScore: number;
    matchIndex: number;
    nameLen: number;
  }> = [];

  for (const appItem of installedApps) {
    if (isShortcutAppId(appItem.AppID)) continue;

    const weighted = computeWeightedNameMatch(appItem.Name);
    if (weighted.staticScore <= 0) continue;

    const groupKey = normalizeAppGroupKey(appItem.Name);
    if (groupKey) matchedGroupKeys.add(groupKey);
    matchedAppIds.add(String(appItem.AppID || "").toLowerCase());

    const score = computeCombinedScore({
      staticScore: weighted.staticScore,
      type: "app",
      rawPath: appItem.AppID,
      timeMs: getLastUsedMs(appItem.AppID),
    });

    results.push({
      name: appItem.Name,
      path: appItem.AppID,
      type: "app",
      iconKey: deriveIconKey({ type: "app", path: appItem.AppID, name: appItem.Name }),
      score,
      staticScore: weighted.staticScore,
      weightedScore: weighted.weightedScore,
      matchIndex: weighted.matchIndex,
      nameLen: weighted.nameLen,
    });
  }

  if (matchedGroupKeys.size > 0) {
    let added = 0;
    const maxRelated = 80;
    for (const appItem of installedApps) {
      if (added >= maxRelated) break;
      if (isShortcutAppId(appItem.AppID)) continue;

      const appIdLower = String(appItem.AppID || "").toLowerCase();
      if (!appIdLower || matchedAppIds.has(appIdLower)) continue;

      const groupKey = normalizeAppGroupKey(appItem.Name);
      if (!groupKey || !matchedGroupKeys.has(groupKey)) continue;

      const nameLower = appItem.Name.toLowerCase();
      if (isActionQuery && !actionTokens.some((t) => nameLower.includes(t))) continue;

      const weighted = computeWeightedNameMatch(appItem.Name);
      const fallbackStatic = weighted.staticScore > 0 ? weighted.staticScore : 0.22;
      const score = computeCombinedScore({
        staticScore: fallbackStatic,
        type: "app",
        rawPath: appItem.AppID,
        timeMs: getLastUsedMs(appItem.AppID),
      });

      results.push({
        name: appItem.Name,
        path: appItem.AppID,
        type: "app",
        iconKey: deriveIconKey({ type: "app", path: appItem.AppID, name: appItem.Name }),
        score,
        staticScore: fallbackStatic,
        weightedScore: weighted.weightedScore,
        matchIndex: weighted.matchIndex,
        nameLen: weighted.nameLen,
      });
      matchedAppIds.add(appIdLower);
      added += 1;
    }
  }

  const sorted = results.sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const matchDiff = (a.matchIndex || 1_000_000) - (b.matchIndex || 1_000_000);
    if (matchDiff !== 0) return matchDiff;
    return (a.nameLen || 1_000_000) - (b.nameLen || 1_000_000);
  });

  if (searchTypeId === "app") {
    return sorted
      .slice(0, 100)
      .map(({ score, staticScore, weightedScore, matchIndex, nameLen, ...rest }) => rest);
  }
  return sorted.slice(0, laneLimit);
}

