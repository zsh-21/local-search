import { createNameScorer, createScoreComputer } from './scoring';
import { prefetchIconsInBackground } from './iconPrefetch';
import { appsStrategy } from './strategies/appsStrategy';
import { fileIndexStrategy } from './strategies/fileIndexStrategy';
import { createRecentIndexStrategy } from './strategies/recentIndexStrategy';
import { settingsStrategy } from './strategies/settingsStrategy';
import type { SearchContext, SearchStrategyDeps } from './strategies/types';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };

export type SearchFilesDeps = Omit<SearchStrategyDeps, 'getCurrentIconPrefetchToken' | 'currentIconPrefetchToken'>;

let iconPrefetchToken = 0;
let lastReconcileRecentAt = 0;
let reconcileRecentInFlight: Promise<void> | null = null;
const RECONCILE_RECENT_MIN_INTERVAL_MS = 1200;

function scheduleReconcileRecentIndex(run: () => void | Promise<void>) {
	const now = Date.now();
	if (reconcileRecentInFlight) return;
	if (now - lastReconcileRecentAt < RECONCILE_RECENT_MIN_INTERVAL_MS) return;
	lastReconcileRecentAt = now;
	reconcileRecentInFlight = Promise.resolve(run())
		.catch(() => {})
		.finally(() => {
			reconcileRecentInFlight = null;
		});
}

function stripInvisibleChars(input: string) {
	return String(input || '')
		.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function deriveSearchTerm(input: string) {
	const s = stripInvisibleChars(input);
	if (!s) return '';
	const normalized = s.replace(/\//g, '\\');
	// 路径型输入直接用完整路径参与检索，提升路径片段命中率。
	const isPathLike = normalized.includes('\\') || normalized.startsWith('\\\\') || /^[a-zA-Z]:\\/.test(normalized);
	if (isPathLike) return normalized;
	return s;
}

async function tryResolveDirectPathCandidate(rawInput: string) {
	const s = stripInvisibleChars(rawInput);
	if (!s) return null;
	const normalized = s.replace(/\//g, '\\').trim();
	if (!normalized) return null;
	const isWinAbs = /^[a-zA-Z]:\\/.test(normalized) || normalized.startsWith('\\\\');
	if (!isWinAbs) return null;
	if (!existsSync(normalized)) return null;
	try {
		const st = await fs.stat(normalized);
		const isDirectory = st.isDirectory();
		const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
		return {
			name: path.win32.basename(normalized),
			path: normalized,
			type: isDirectory ? 'folder' : 'file',
			isDirectory,
			timeMs,
		};
	} catch {
		return null;
	}
}

export async function handleSearchFiles(
	event: Electron.IpcMainInvokeEvent,
	query: string,
	options: SearchFilesOptions | undefined,
	deps: SearchFilesDeps
) {
	const { fileIndex, reconcileRecentIndex, loadHistoryStats, normalizeHistoryKey, normalizeExtKey, iconDataCache } = deps;
	const rawQueryForEvents = typeof query === 'string' ? query : '';
	const queryForSearch = deriveSearchTerm(rawQueryForEvents);
	const isPathQuery = queryForSearch.includes('\\') || queryForSearch.startsWith('\\\\') || /^[a-zA-Z]:\\/.test(queryForSearch);
	const status = await fileIndex.getStatus();
	// 支持单字符搜索：由渲染端控制防抖与噪声；主进程这里仅做空值拦截
	if (!queryForSearch || queryForSearch.trim().length < 1)
		return { results: [], isIndexing: status.isIndexing };
	// 索引未完成时加大暂停时长，把主线程响应优先级放到搜索输入上。
	fileIndex.pauseIndexingFor(status.isIndexing ? 2000 : 900);
	// 搜索时顺带触发一次轻量兜底扫描：提高新建/改动文件被检索到的概率（不阻塞当前请求）
	scheduleReconcileRecentIndex(() => reconcileRecentIndex());

	const nameScorer = createNameScorer(queryForSearch);
	const { lowerQuery, computeWeightedNameMatch, scoreRecentName } = nameScorer;

	const searchTypeId = typeof options?.searchTypeId === 'string' ? options.searchTypeId : 'all';
	// 搜索会话 ID：用于将后台分批推送的 more-results 与当前搜索绑定，避免切换类型后出现重复项/数量不一致
	const searchSessionId =
		typeof options?.searchSessionId === 'string' && options.searchSessionId.trim()
			? options.searchSessionId.trim()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	// 内置命令：通过搜索框触发“清空所有配置/缓存/索引”
	if (lowerQuery === 'clear:cache') {
		return {
			results: [
				{
					name: '清空缓存并重新建立索引',
					path: 'clear:cache',
					type: 'command',
					description: '清空所有配置/缓存/索引；下次启动会重新生成',
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

	const commandResults = (() => {
		if (searchTypeId !== 'all') return [];
		const items = [
			{
				name: '\u5173\u673a',
				path: 'system:shutdown',
				description: 'Shut down the computer',
				keywords: ['shutdown', 'poweroff', '\u5173\u673a'],
			},
			{
				name: '\u91cd\u542f\u7535\u8111',
				path: 'system:restart',
				description: 'Restart the computer',
				keywords: ['restart', 'reboot', '\u91cd\u542f', '\u91cd\u542f\u7535\u8111'],
			},
		];
		const out: any[] = [];
		for (const it of items) {
			let best = { weightedScore: 0, matchIndex: 1_000_000, nameLen: 0 };
			const candidates = [it.name, ...(it.keywords || [])];
			for (const c of candidates) {
				const r = computeWeightedNameMatch(c);
				if (r.weightedScore > best.weightedScore) best = r;
				else if (r.weightedScore === best.weightedScore) {
					if (r.matchIndex < best.matchIndex) best = r;
					else if (r.matchIndex === best.matchIndex && r.nameLen < best.nameLen) best = r;
				}
			}
			if (best.weightedScore <= 0) continue;
			const score = computeCombinedScore(best.weightedScore, 'command', it.path, getLastUsedMs(it.path));
			out.push({
				name: it.name,
				path: it.path,
				type: 'command',
				description: it.description,
				score,
				weightedScore: best.weightedScore,
				matchIndex: best.matchIndex,
				nameLen: best.nameLen,
			});
		}
		return out;
	})();

	const getCurrentIconPrefetchToken = () => iconPrefetchToken;
	const ctx: SearchContext = {
		event,
		query: queryForSearch,
		lowerQuery,
		// 传递索引与路径查询状态，便于策略在高负载时降载与路径匹配调权。
		isIndexingHint: status.isIndexing,
		isPathQuery,
		searchTypeId,
		searchSessionId,
		driveFilter,
		extFilter,
		now,
		nameScorer: { computeWeightedNameMatch, scoreRecentName },
		scoreComputer: { getLastUsedMs, computeCombinedScore },
	};
	const strategyDeps: SearchStrategyDeps = {
		...(deps as any),
		getCurrentIconPrefetchToken,
		currentIconPrefetchToken,
	};

	const directPathCandidate = await tryResolveDirectPathCandidate(rawQueryForEvents);

	const resultFromSettings = await settingsStrategy.execute(ctx, strategyDeps);
	if (resultFromSettings.kind === 'return') return resultFromSettings.response;
	const settingsResults = resultFromSettings.items;

	const resultFromApps = await appsStrategy.execute(ctx, strategyDeps);
	if (resultFromApps.kind === 'return') return resultFromApps.response;
	const appResults = resultFromApps.items;

	const resultFromFileIndex = await fileIndexStrategy.execute(ctx, strategyDeps);
	if (resultFromFileIndex.kind === 'return') return resultFromFileIndex.response;
	const scoredFiles = resultFromFileIndex.items;
	const isIndexing = Boolean(resultFromFileIndex.meta?.isIndexing);

	const seen = new Set(scoredFiles.map((x: any) => deps.normalizeRecentKey(x.path)));
	const recentStrategy = createRecentIndexStrategy(seen);
	const resultFromRecent = await recentStrategy.execute(ctx, strategyDeps);
	if (resultFromRecent.kind === 'return') return resultFromRecent.response;
	const recentBoostCandidates = resultFromRecent.items;

	const directCandidates = (() => {
		if (!directPathCandidate) return [];
		const baseScore = 999_999;
		const score = computeCombinedScore(baseScore, directPathCandidate.type, directPathCandidate.path, directPathCandidate.timeMs || 0);
		return [{ ...directPathCandidate, score, weightedScore: baseScore, matchIndex: 0, nameLen: 1 }];
	})();

	const candidates = [
		...directCandidates,
		...commandResults,
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

	const stripMeta = ({ score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest }: any) => rest;
	const merged = firstBatch.map(stripMeta);
	// 索引未完成时暂停图标预取，减少 I/O 与主线程压力。
	if (!status.isIndexing) {
		prefetchIconsInBackground({
			event,
			query: rawQueryForEvents,
			searchTypeId,
			searchSessionId,
			items: top500.map(stripMeta),
			iconDataCache,
			getFileIconData: deps.getFileIconData,
			getAppIconDataStable: deps.getAppIconDataStable,
			getCurrentIconPrefetchToken,
			iconPrefetchToken: currentIconPrefetchToken,
		});
	}

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
							return stripMeta(cached ? { ...r, icon: cached } : r);
						}
						if (r.type === 'app') {
							const cached = iconDataCache.get(`app:${r.path}`) || '';
							return stripMeta(cached ? { ...r, icon: cached } : r);
						}
						return stripMeta(r);
					});

				if (backgroundResults.length > 0) {
					event.sender.send('more-results', {
						query: rawQueryForEvents,
						searchTypeId,
						searchSessionId,
						results: backgroundResults,
					});
				}
				await new Promise((resolve) => setTimeout(resolve, 16));
			}
		})();
	}

	return {
		results: merged,
		isIndexing,
		hasMore: remainingBatch.length > 0,
		searchSessionId,
		totalCount: candidates.length,
	};
}
