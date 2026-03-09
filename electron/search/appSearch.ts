export async function searchApps(input: {
	searchTypeId: string;
	lowerQuery: string;
	getInstalledApps: () => Array<{ Name: string; AppID: string }>;
	normalizeAppGroupKey: (name: string) => string;
	iconDataCache: Map<string, string>;
	isTooSmallAppIconDataUrl: (value: string) => boolean;
	getAppIconDataStable: (appName: string, appId: string, maxAttempts?: number) => Promise<string>;
	scoreRecentName: (name: string) => number;
	computeWeightedNameMatch: (name: string) => { weightedScore: number; matchIndex: number };
	computeCombinedScore: (baseScore: number, type: string, rawPath: string, timeMs: number) => number;
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
		scoreRecentName,
		computeWeightedNameMatch,
		computeCombinedScore,
		getLastUsedMs,
		event,
		query,
		searchSessionId,
		iconPrefetchToken,
		getCurrentIconPrefetchToken,
	} = input;

	if (searchTypeId !== 'all' && searchTypeId !== 'file' && searchTypeId !== 'app') return [];

	const installedApps = getInstalledApps();
	const actionTokens = ['卸载', 'uninstall', 'remove', '删除', '移除'];
	const isActionQuery = actionTokens.some((t) => lowerQuery.includes(t));

	const matchedGroupKeys = new Set<string>();
	const matchedAppIds = new Set<string>();
	const results: Array<{ name: string; path: string; type: string; icon?: string; score: number }> = [];

	for (const appItem of installedApps) {
		const legacyScore = scoreRecentName(appItem.Name);
		const weighted = computeWeightedNameMatch(appItem.Name);
		const nameMatchScore =
			legacyScore > 0 ? legacyScore : weighted.weightedScore > 0 ? Math.round(weighted.weightedScore * 25) : 0;
		if (nameMatchScore <= 0) continue;

		const cacheKey = `app:${appItem.AppID}`;
		const iconData = iconDataCache.get(cacheKey) || '';

		const groupKey = normalizeAppGroupKey(appItem.Name);
		if (groupKey) matchedGroupKeys.add(groupKey);
		matchedAppIds.add(String(appItem.AppID || '').toLowerCase());

		results.push({
			name: appItem.Name,
			path: appItem.AppID,
			type: 'app',
			icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : '',
			score: computeCombinedScore(10_000 + nameMatchScore, 'app', appItem.AppID, getLastUsedMs(appItem.AppID)),
		});

		if (!iconData) void getAppIconDataStable(appItem.Name, appItem.AppID, 2);
	}

	if (matchedGroupKeys.size > 0) {
		let added = 0;
		const MAX_RELATED = 80;
		for (const appItem of installedApps) {
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
			const legacyScore = scoreRecentName(appItem.Name);
			const weighted = computeWeightedNameMatch(appItem.Name);
			const relatedMatchScore =
				legacyScore > 0 ? legacyScore : weighted.weightedScore > 0 ? Math.round(weighted.weightedScore * 25) : 0;
			const baseScore = relatedMatchScore > 0 ? 9_500 : 7_000;
			results.push({
				name: appItem.Name,
				path: appItem.AppID,
				type: 'app',
				icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : '',
				score: computeCombinedScore(baseScore + Math.max(0, relatedMatchScore), 'app', appItem.AppID, getLastUsedMs(appItem.AppID)),
			});
			matchedAppIds.add(appIdLower);
			added += 1;
			if (!iconData) void getAppIconDataStable(appItem.Name, appItem.AppID, 2);
		}
	}

	if (searchTypeId !== 'app') return results;

	const sorted = results.sort((a, b) => (b.score || 0) - (a.score || 0));
	const head = sorted.slice(0, 60);
	if (head.length > 0) {
		const deadline = Date.now() + 1800;
		const queue = head.slice();
		const worker = async () => {
			while (queue.length > 0) {
				if (Date.now() >= deadline) return;
				const it = queue.shift();
				if (!it || it.icon) continue;
				const icon = await getAppIconDataStable(it.name, it.path, 3);
				if (icon) it.icon = icon;
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
	}
	const merged = sorted.slice(0, 100).map(({ score, ...rest }) => rest);
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

