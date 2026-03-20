export async function searchApps(input: {
  searchTypeId: string;
  lowerQuery: string;
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

  if (searchTypeId !== 'all' && searchTypeId !== 'file' && searchTypeId !== 'app') return [];
  // “文件(file)”类型不混入应用结果：应用仅在“全部/应用”中展示
  if (searchTypeId === 'file') return [];

  // 过滤快捷方式：.lnk/.url 往往只指向目标应用，会导致重复展示
  const isShortcutAppId = (appId: string) => {
    const lower = String(appId || '').toLowerCase();
    return lower.endsWith('.lnk') || lower.endsWith('.url');
  };

  const installedApps = getInstalledApps();
  const actionTokens = ['卸载', 'uninstall', 'remove', '删除', '移除'];
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
    if (isShortcutAppId(appItem.AppID)) continue;
    const weighted = computeWeightedNameMatch(appItem.Name);
    if (weighted.staticScore <= 0) continue;

    const cacheKey = `app:${appItem.AppID}`;
    const iconData = iconDataCache.get(cacheKey) || '';

    const groupKey = normalizeAppGroupKey(appItem.Name);
    if (groupKey) matchedGroupKeys.add(groupKey);
    matchedAppIds.add(String(appItem.AppID || '').toLowerCase());

    const score = computeCombinedScore({
      staticScore: weighted.staticScore,
      type: 'app',
      rawPath: appItem.AppID,
      timeMs: input.getLastUsedMs(appItem.AppID),
    });

    results.push({
      name: appItem.Name,
      path: appItem.AppID,
      type: 'app',
      icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : '',
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
      if (isShortcutAppId(appItem.AppID)) continue;
      if (added >= MAX_RELATED) break;
      const appIdLower = String(appItem.AppID || '').toLowerCase();
      if (!appIdLower) continue;
      if (matchedAppIds.has(appIdLower)) continue;

      const groupKey = normalizeAppGroupKey(appItem.Name);
      if (!groupKey || !matchedGroupKeys.has(groupKey)) continue;

      const nameLower = appItem.Name.toLowerCase();
      if (isActionQuery && !actionTokens.some((t) => nameLower.includes(t))) continue;

      const cacheKey = `app:${appItem.AppID}`;
      const iconData = iconDataCache.get(cacheKey) || '';
      const weighted = computeWeightedNameMatch(appItem.Name);

      // 关联召回时允许低静态分兜底，避免同组应用完全缺席
      const fallbackStatic = weighted.staticScore > 0 ? weighted.staticScore : 0.22;
      const score = computeCombinedScore({
        staticScore: fallbackStatic,
        type: 'app',
        rawPath: appItem.AppID,
        timeMs: input.getLastUsedMs(appItem.AppID),
      });

      results.push({
        name: appItem.Name,
        path: appItem.AppID,
        type: 'app',
        icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : '',
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

  if (searchTypeId !== 'app') return results;

  // 同分时继续按匹配位置与名称长度打破平局，保证应用页结果稳定
  const sorted = results.sort((a, b) => {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const matchDiff = (a.matchIndex || 1_000_000) - (b.matchIndex || 1_000_000);
    if (matchDiff !== 0) return matchDiff;
    return (a.nameLen || 1_000_000) - (b.nameLen || 1_000_000);
  });
  // 应用分类首屏优先“立刻返回结果”，缺失图标交给后续异步回填
  const merged = sorted
    .slice(0, 100)
    .map(({ score, staticScore, weightedScore, matchIndex, nameLen, ...rest }) => rest);
  (async () => {
    const batchSize = 20;
    for (let i = 0; i < merged.length; i += batchSize) {
      if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;
      const batch = merged.slice(i, i + batchSize);
      const updates: Array<{ name: string; path: string; type: string; icon: string }> = [];
      for (const it of batch) {
        if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;
        if (!it?.path || it.type !== 'app') continue;
        if (typeof (it as any).icon === 'string' && (it as any).icon) continue;
        const cached = iconDataCache.get(`app:${it.path}`) || '';
        if (cached) {
          updates.push({ ...it, icon: cached });
          continue;
        }
        const icon = await getAppIconDataStable(it.name, it.path, 3);
        if (icon) updates.push({ ...it, icon });
      }
      if (updates.length > 0) {
        event.sender.send('more-results', {
          query,
          searchTypeId,
          searchSessionId,
          results: updates,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  })();

  return merged as any;
}
