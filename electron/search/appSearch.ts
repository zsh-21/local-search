export async function searchApps(input: {
  searchTypeId: string;
  lowerQuery: string;
  lane?: "fast" | "full";
  getInstalledApps: () => Array<{ Name: string; AppID: string }>;
  normalizeAppGroupKey: (name: string) => string;
  iconDataCache: Map<string, string>;
  isTooSmallAppIconDataUrl: (value: string) => boolean;
  getAppIconDataStable: (appName: string, appId: string, maxAttempts?: number) => Promise<string>;
  computeWeightedNameMatch: (name: string) => { weightedScore: number; staticScore: number; matchIndex: number; nameLen: number };
  computeCombinedScore: (input: { staticScore: number; type: string; rawPath: string; timeMs?: number; sourceScore?: number }) => number;
  getLastUsedMs: (rawPath: string) => number;
  event: Electron.IpcMainInvokeEvent;
  query: string;
  searchSessionId: string;
  iconPrefetchToken: number;
  getCurrentIconPrefetchToken: () => number;
  shouldCancel?: () => boolean;
}) {
  const {
    searchTypeId,
    lowerQuery,
    getInstalledApps,
    normalizeAppGroupKey,
    iconDataCache,
    isTooSmallAppIconDataUrl,
    getAppIconDataStable,
    computeWeightedNameMatch,
    computeCombinedScore,
    event,
    query,
    searchSessionId,
    iconPrefetchToken,
    getCurrentIconPrefetchToken,
  } = input;

  const shouldCancel = () => Boolean(input.shouldCancel?.());
  const lane = input.lane === "fast" ? "fast" : "full";
  const laneLimit = lane === "fast" ? 20 : 50;

  if (searchTypeId !== "all" && searchTypeId !== "file" && searchTypeId !== "app") return [];
  if (searchTypeId === "file") return [];
  if (shouldCancel()) return [];

  const isShortcutAppId = (appId: string) => {
    const lower = String(appId || "").toLowerCase();
    return lower.endsWith(".lnk") || lower.endsWith(".url");
  };

  const installedApps = getInstalledApps();
  const actionTokens = ["\u5378\u8f7d", "uninstall", "remove", "\u5220\u9664", "\u79fb\u9664"];
  const isActionQuery = actionTokens.some((t) => lowerQuery.includes(t));

  const matchedGroupKeys = new Set<string>();
  const matchedAppIds = new Set<string>();
  const results: Array<{
    name: string;
    path: string;
    type: string;
    icon?: string;
    score: number;
    staticScore: number;
    weightedScore: number;
    matchIndex: number;
    nameLen: number;
  }> = [];

  for (const appItem of installedApps) {
    if (shouldCancel()) return [];
    if (isShortcutAppId(appItem.AppID)) continue;

    const weighted = computeWeightedNameMatch(appItem.Name);
    if (weighted.staticScore <= 0) continue;

    const cacheKey = `app:${appItem.AppID}`;
    const iconData = iconDataCache.get(cacheKey) || "";

    const groupKey = normalizeAppGroupKey(appItem.Name);
    if (groupKey) matchedGroupKeys.add(groupKey);
    matchedAppIds.add(String(appItem.AppID || "").toLowerCase());

    const score = computeCombinedScore({
      staticScore: weighted.staticScore,
      type: "app",
      rawPath: appItem.AppID,
      timeMs: input.getLastUsedMs(appItem.AppID),
    });

    results.push({
      name: appItem.Name,
      path: appItem.AppID,
      type: "app",
      icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : "",
      score,
      staticScore: weighted.staticScore,
      weightedScore: weighted.weightedScore,
      matchIndex: weighted.matchIndex,
      nameLen: weighted.nameLen,
    });

    if (!iconData) void getAppIconDataStable(appItem.Name, appItem.AppID, 2);
  }

  if (matchedGroupKeys.size > 0) {
    let added = 0;
    const MAX_RELATED = 80;
    for (const appItem of installedApps) {
      if (shouldCancel()) return [];
      if (isShortcutAppId(appItem.AppID)) continue;
      if (added >= MAX_RELATED) break;

      const appIdLower = String(appItem.AppID || "").toLowerCase();
      if (!appIdLower) continue;
      if (matchedAppIds.has(appIdLower)) continue;

      const groupKey = normalizeAppGroupKey(appItem.Name);
      if (!groupKey || !matchedGroupKeys.has(groupKey)) continue;

      const nameLower = appItem.Name.toLowerCase();
      if (isActionQuery && !actionTokens.some((t) => nameLower.includes(t))) continue;

      const cacheKey = `app:${appItem.AppID}`;
      const iconData = iconDataCache.get(cacheKey) || "";
      const weighted = computeWeightedNameMatch(appItem.Name);

      const fallbackStatic = weighted.staticScore > 0 ? weighted.staticScore : 0.22;
      const score = computeCombinedScore({
        staticScore: fallbackStatic,
        type: "app",
        rawPath: appItem.AppID,
        timeMs: input.getLastUsedMs(appItem.AppID),
      });

      results.push({
        name: appItem.Name,
        path: appItem.AppID,
        type: "app",
        icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : "",
        score,
        staticScore: fallbackStatic,
        weightedScore: weighted.weightedScore,
        matchIndex: weighted.matchIndex,
        nameLen: weighted.nameLen,
      });
      matchedAppIds.add(appIdLower);
      added += 1;
      if (!iconData) void getAppIconDataStable(appItem.Name, appItem.AppID, 2);
    }
  }

  const sorted = results.sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const matchDiff = (a.matchIndex || 1_000_000) - (b.matchIndex || 1_000_000);
    if (matchDiff !== 0) return matchDiff;
    return (a.nameLen || 1_000_000) - (b.nameLen || 1_000_000);
  });

  if (searchTypeId !== "app") {
    return shouldCancel() ? [] : sorted.slice(0, laneLimit);
  }

  const merged = sorted
    .slice(0, 100)
    .map(({ score, staticScore, weightedScore, matchIndex, nameLen, ...rest }) => rest);

  (async () => {
    const batchSize = 20;
    for (let i = 0; i < merged.length; i += batchSize) {
      if (shouldCancel()) return;
      if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;

      const batch = merged.slice(i, i + batchSize);
      const updates: Array<{ name: string; path: string; type: string; icon: string }> = [];
      for (const it of batch) {
        if (shouldCancel()) return;
        if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;
        if (!it?.path || it.type !== "app") continue;
        if (typeof (it as any).icon === "string" && (it as any).icon) continue;

        const cached = iconDataCache.get(`app:${it.path}`) || "";
        if (cached) {
          updates.push({ ...it, icon: cached });
          continue;
        }

        const icon = await getAppIconDataStable(it.name, it.path, 3);
        if (icon) updates.push({ ...it, icon });
      }

      if (!shouldCancel() && updates.length > 0) {
        event.sender.send("more-results", {
          query,
          searchTypeId,
          searchSessionId,
          results: updates,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  })();

  return shouldCancel() ? [] : (merged as any);
}
