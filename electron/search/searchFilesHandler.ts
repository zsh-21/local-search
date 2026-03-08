import { createNameScorer, createScoreComputer } from './scoring';
import { getWindowsSettingsItems, searchSettingsItems } from './settingsSearch';
import { searchApps } from './appSearch';
import { prefetchIconsInBackground } from './iconPrefetch';

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };

export type SearchFilesDeps = {
	fileIndex: {
		getStatus: () => Promise<{ isIndexing: boolean }>;
		pauseIndexingFor: (ms: number) => void | Promise<void>;
		search: (query: string, limit: number, options?: { where?: any }) => Promise<any>;
		buildIfEmpty: () => Promise<void>;
	};
	reconcileRecentIndex: () => void;
	loadSettings: () => { customSearchTypes?: string[]; ignoredPaths?: string[] };
	loadHistoryStats: () => any;
	normalizeHistoryKey: (rawPath: string) => string;
	normalizeExtKey: (rawPath: string) => string;
	getInstalledApps: () => Array<{ Name: string; AppID: string }>;
	normalizeAppGroupKey: (name: string) => string;
	iconDataCache: Map<string, string>;
	isTooSmallAppIconDataUrl: (value: string) => boolean;
	getAppIconDataStable: (appName: string, appId: string, maxAttempts?: number) => Promise<string>;
	getFileIconData: (filePath: string) => Promise<string>;
	isIgnoredPathByCache: (targetPath: string) => boolean;
	normalizeRecentKey: (rawPath: string) => string;
	recentIndex: Map<string, { path: string; name: string; isDirectory: boolean; timeMs: number }>;
	shouldSkipWatchPath: (fullPath: string) => boolean;
	getWindowsFileSystemRoots: () => Promise<string[]>;
};

let iconPrefetchToken = 0;

export async function handleSearchFiles(
	event: Electron.IpcMainInvokeEvent,
	query: string,
	options: SearchFilesOptions | undefined,
	deps: SearchFilesDeps
) {
	const {
		fileIndex,
		reconcileRecentIndex,
		loadSettings,
		loadHistoryStats,
		normalizeHistoryKey,
		normalizeExtKey,
		getInstalledApps,
		normalizeAppGroupKey,
		iconDataCache,
		isTooSmallAppIconDataUrl,
		getAppIconDataStable,
		getFileIconData,
		isIgnoredPathByCache,
		normalizeRecentKey,
		recentIndex,
		shouldSkipWatchPath,
		getWindowsFileSystemRoots,
	} = deps;
	// 支持单字符搜索：由渲染端控制防抖与噪声；主进程这里仅做空值拦截
	if (!query || query.trim().length < 1) return { results: [], isIndexing: (await fileIndex.getStatus()).isIndexing };
	fileIndex.pauseIndexingFor(900);
	// 搜索时顺带触发一次轻量兜底扫描：提高新建/改动文件被检索到的概率（不阻塞当前请求）
	void reconcileRecentIndex();

	const nameScorer = createNameScorer(query);
	const { lowerQuery, queryParts, computeWeightedNameMatch, scoreRecentName } = nameScorer;
	const aliases: Record<string, string[]> = {
		wechat: ['wechat', 'weixin', '微信'],
		微信: ['wechat', 'weixin', '微信'],
		google: ['google', 'chrome'],
		chrome: ['google', 'chrome'],
		edge: ['edge', 'microsoft edge'],
	};
	const keywords = aliases[lowerQuery] || [lowerQuery];

	const searchTypeId = typeof options?.searchTypeId === 'string' ? options.searchTypeId : 'all';
	// 搜索会话 ID：用于将后台分批推送的 more-results 与当前搜索绑定，避免切换类型后出现重复项/数量不一致
	const searchSessionId =
		typeof options?.searchSessionId === 'string' && options.searchSessionId.trim()
			? options.searchSessionId.trim()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	// 内置命令：通过搜索框触发“清空缓存与索引”，保留登录态与设置
	if (lowerQuery === 'clear:cache') {
		return {
			results: [
				{
					name: '清空缓存并重新建立索引',
					path: 'clear:cache',
					type: 'command',
					description: '保留登录账户与设置；下次呼出面板会自动重建索引',
				},
			],
			isIndexing: false,
			hasMore: false,
			searchSessionId,
			totalCount: 1,
		};
	}
	const currentIconPrefetchToken = ++iconPrefetchToken;
	const driveFilterRaw = typeof options?.drive === 'string' ? options.drive.trim() : '';
	const driveFilter = /^[a-z]$/i.test(driveFilterRaw) ? driveFilterRaw.toLowerCase() : '';
	const extFilter = searchTypeId.startsWith('ext:') ? searchTypeId.slice(4).toLowerCase() : '';
	// 综合排序权重：①名称匹配度 > ④访问频次 > ③常用类型 > ②时间（新建/改动更近）
	const now = Date.now();
	const historyStats = loadHistoryStats();
	const { getLastUsedMs, computeCombinedScore } = createScoreComputer({
		now,
		historyStats,
		normalizeHistoryKey,
		normalizeExtKey,
	});
	const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);
	const videoExts = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v']);
	const settingsItems = getWindowsSettingsItems();
	const { settingsResults, settingsOnly } = searchSettingsItems({
		searchTypeId,
		settingsItems,
		computeWeightedNameMatch,
		computeCombinedScore,
		getLastUsedMs,
	});
	if (settingsOnly) return { results: settingsOnly.results, isIndexing: false, hasMore: false, searchSessionId, totalCount: settingsOnly.totalCount };

	const getCurrentIconPrefetchToken = () => iconPrefetchToken;
	const appResults: any[] = await searchApps({
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
		iconPrefetchToken: currentIconPrefetchToken,
		getCurrentIconPrefetchToken,
	});
	if (searchTypeId === 'app') {
		const isIndexing = (await fileIndex.getStatus()).isIndexing;
		return { results: appResults, isIndexing, hasMore: false, searchSessionId, totalCount: appResults.length };
	}

	const fileSearchLimit = searchTypeId === 'all' || searchTypeId === 'file' ? 500 : 5000;
	const currentSettings = loadSettings();
	const customExts = Array.isArray(currentSettings.customSearchTypes)
		? currentSettings.customSearchTypes.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')).filter(Boolean)
		: [];
	const where = (() => {
		const and: any[] = [];
		if (searchTypeId === 'folder') and.push({ isDirectory: true });
		if (searchTypeId === 'image') and.push({ ext: { in: Array.from(imageExts) } });
		if (searchTypeId === 'video') and.push({ ext: { in: Array.from(videoExts) } });
		if (extFilter) and.push({ ext: { in: [extFilter] } });
		if (driveFilter) and.push({ drive: { eq: driveFilter } });
		if (searchTypeId === 'file') {
			const excluded = new Set([...imageExts, ...videoExts, ...customExts]);
			and.push({ ext: { nin: Array.from(excluded) } });
		}
		return and.length > 0 ? { and } : null;
	})();

	await fileIndex.buildIfEmpty();
	const fileSearch = await fileIndex.search(query, fileSearchLimit, where ? { where } : undefined);
	const fileResultsRaw: Array<{
		path: string;
		name: string;
		isDirectory: boolean;
		timeMs: number;
		size?: number;
	}> = Array.isArray((fileSearch as any)?.results) ? (fileSearch as any).results : [];

	const filteredFiles: Array<any> = [];
	for (const r of fileResultsRaw) {
		if (!r?.path) continue;
		if (isIgnoredPathByCache(r.path)) continue;
		if (driveFilter && !r.path.toLowerCase().startsWith(`${driveFilter}:\\`)) continue;
		if (extFilter && !String(r.path).toLowerCase().endsWith(extFilter)) continue;
		filteredFiles.push(r);
	}

	const scoredFiles: Array<any> = [];
	for (const r of filteredFiles) {
		const type = r.isDirectory ? 'folder' : 'file';
		const { weightedScore, matchIndex, nameLen } = computeWeightedNameMatch(r.name);
		const baseScore = weightedScore * 100 + (matchIndex <= 2 ? 300 : 0) - Math.min(80, Math.floor(nameLen / 10));
		const timeMs = typeof r.timeMs === 'number' ? r.timeMs : 0;
		const score = computeCombinedScore(baseScore, type, r.path, timeMs);
		scoredFiles.push({ ...r, type, score, weightedScore, matchIndex, nameLen });
	}

	const recentBoostCandidates = (() => {
		const seen = new Set(filteredFiles.map((x) => normalizeRecentKey(x.path)));
		const items = Array.from(recentIndex.values());
		items.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
		const out: Array<any> = [];
		for (const it of items) {
			const key = normalizeRecentKey(it.path);
			if (!key || seen.has(key)) continue;
			if (isIgnoredPathByCache(it.path)) continue;
			if (driveFilter && !it.path.toLowerCase().startsWith(`${driveFilter}:\\`)) continue;
			if (extFilter && !String(it.path).toLowerCase().endsWith(extFilter)) continue;
			const weighted = computeWeightedNameMatch(it.name);
			const legacy = scoreRecentName(it.name);
			const baseWeighted =
				legacy > 0 ? legacy / 25 : weighted.weightedScore > 0 ? weighted.weightedScore : 0;
			if (baseWeighted <= 0) continue;
			const type = it.isDirectory ? 'folder' : 'file';
			const score = computeCombinedScore(baseWeighted * 100, type, it.path, it.timeMs || 0);
			out.push({ name: it.name, path: it.path, type, score, timeMs: it.timeMs || 0 });
			seen.add(key);
			if (out.length >= 350) break;
		}
		return out;
	})();

	const candidates = [
		...settingsResults,
		...appResults,
		...scoredFiles,
		...recentBoostCandidates,
	] as any[];

	candidates.sort((a, b) => {
		const sa = typeof a.score === 'number' ? a.score : 0;
		const sb = typeof b.score === 'number' ? b.score : 0;
		if (sb !== sa) return sb - sa;
		const ia = typeof a.matchIndex === 'number' ? a.matchIndex : 1_000_000;
		const ib = typeof b.matchIndex === 'number' ? b.matchIndex : 1_000_000;
		if (ia !== ib) return ia - ib;
		const na = typeof a.nameLen === 'number' ? a.nameLen : 1_000_000;
		const nb = typeof b.nameLen === 'number' ? b.nameLen : 1_000_000;
		return na - nb;
	});

	const DISPLAY_LIMIT = 500;
	const top500 = candidates.slice(0, DISPLAY_LIMIT);
	const initialLimit = 70;
	const firstBatch = top500.slice(0, initialLimit);
	const remainingBatch = top500.slice(initialLimit);

	const merged = firstBatch.map(({ score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest }) => rest);
	prefetchIconsInBackground({
		event,
		query,
		searchTypeId,
		searchSessionId,
		items: top500.map(({ score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest }) => rest),
		iconDataCache,
		getFileIconData,
		getAppIconDataStable,
		getCurrentIconPrefetchToken,
		iconPrefetchToken: currentIconPrefetchToken,
	});

	if (remainingBatch.length > 0) {
		(async () => {
			const batchSize = 50;
			for (let i = 0; i < remainingBatch.length; i += batchSize) {
				if (currentIconPrefetchToken !== iconPrefetchToken) return;
				const batch = remainingBatch.slice(i, i + batchSize);
				const backgroundResults = batch
					.filter(Boolean)
					.map((r: any) => {
						if (r.type === 'file' || r.type === 'folder') {
							const cached = iconDataCache.get(`file:${r.path}`) || '';
							const { score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest } = cached ? { ...r, icon: cached } : r;
							return rest;
						}
						if (r.type === 'app') {
							const cached = iconDataCache.get(`app:${r.path}`) || '';
							const { score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest } = cached ? { ...r, icon: cached } : r;
							return rest;
						}
						const { score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest } = r;
						return rest;
					});

				if (backgroundResults.length > 0) {
					event.sender.send('more-results', {
						query,
						searchTypeId,
						searchSessionId,
						results: backgroundResults,
					});
				}
				await new Promise((resolve) => setTimeout(resolve, 16));
			}
		})();
	}

	const isIndexing = (fileSearch as any)?.isIndexing ?? (await fileIndex.getStatus()).isIndexing;
	return {
		results: merged,
		isIndexing,
		hasMore: remainingBatch.length > 0,
		searchSessionId,
		totalCount: candidates.length,
	};
}
