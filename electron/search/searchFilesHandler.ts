import { createNameScorer, createScoreComputer } from './scoring';
import { prefetchIconsInBackground } from './iconPrefetch';
import { appsStrategy } from './strategies/appsStrategy';
import { fileIndexStrategy } from './strategies/fileIndexStrategy';
import { createRecentIndexStrategy } from './strategies/recentIndexStrategy';
import { settingsStrategy } from './strategies/settingsStrategy';
import type { SearchContext, SearchStrategyDeps } from './strategies/types';
import { isStrictSearchMatch, parseSearchMatchIntent, pickSearchMatchTargetText } from '../../shared/searchMatch';
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
  // 统一解析查询语义：支持 p: 前缀路径匹配，并与前端高亮规则保持一致。
  const searchIntent = parseSearchMatchIntent(rawQueryForEvents);
  const queryForSearch = searchIntent.term;
  const isPathQuery = searchIntent.matchTarget === 'path';
  const status = await fileIndex.getStatus();
  // 支持单字符搜索：主进程只拦空值，防抖由渲染层负责。
  if (!queryForSearch || queryForSearch.trim().length < 1) {
    return { results: [], isIndexing: status.isIndexing };
  }

  // 索引期适当暂停后台索引，优先保证搜索输入响应。
  fileIndex.pauseIndexingFor(status.isIndexing ? 2000 : 900);
  // 搜索时顺带触发一次轻量兜底扫描：提升新建/改动文件被检索到的概率（不阻塞当前请求）
  scheduleReconcileRecentIndex(() => reconcileRecentIndex());

  const nameScorer = createNameScorer(queryForSearch);
  const { lowerQuery, computeWeightedNameMatch, scoreRecentName } = nameScorer;
  // 严格匹配过滤：只有能定位到高亮区间的结果才允许进入结果集。
  const filterStrictResults = <T extends { name?: string; path?: string }>(items: T[]) =>
    items.filter((item) => {
      const target = pickSearchMatchTargetText(item, searchIntent);
      return isStrictSearchMatch(target, searchIntent);
    });

  const searchTypeId = typeof options?.searchTypeId === 'string' ? options.searchTypeId : 'all';
  // 搜索会话 ID：用于绑定当前搜索与 more-results 增量回填。
  const searchSessionId =
    typeof options?.searchSessionId === 'string' && options.searchSessionId.trim()
      ? options.searchSessionId.trim()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  // 路径模式下跳过命令捷径，避免 p: 查询被“系统命令”抢占。
  if (searchIntent.matchTarget !== 'path' && lowerQuery === 'clear:cache') {
    return {
      results: [
        {
          name: '清空缓存并重新建索引',
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

  const now = Date.now();
  const historyStats = loadHistoryStats();
  const runtimeSettings = deps.loadSettings();
  const { getLastUsedMs, computeCombinedScore } = createScoreComputer({
    now,
    historyStats,
    normalizeHistoryKey,
    normalizeExtKey,
    // 评分器直接读取设置页参数，保证排序调整无需重启即可生效
    searchRanking: runtimeSettings.searchRanking,
  });

  const commandResults = (() => {
    if (searchIntent.matchTarget === 'path') return [];
    if (searchTypeId !== 'all') return [];
    const items = [
      {
        name: '关机',
        path: 'system:shutdown',
        description: 'Shut down the computer',
        keywords: ['shutdown', 'poweroff', '关机'],
      },
      {
        name: '重启电脑',
        path: 'system:restart',
        description: 'Restart the computer',
        keywords: ['restart', 'reboot', '重启', '重启电脑'],
      },
    ];
    const out: any[] = [];
    for (const it of items) {
      let best = { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };
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
      const score = computeCombinedScore({
        staticScore: best.staticScore,
        type: 'command',
        rawPath: it.path,
        timeMs: getLastUsedMs(it.path),
      });
      out.push({
        name: it.name,
        path: it.path,
        type: 'command',
        description: it.description,
        score,
        staticScore: best.staticScore,
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
    // 传递索引与路径查询状态，便于策略在高负载时降载与路径匹配调权
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
  if (resultFromSettings.kind === 'return') {
    const strictSettings = filterStrictResults(resultFromSettings.response.results || []);
    return {
      ...resultFromSettings.response,
      results: strictSettings,
      totalCount: strictSettings.length,
      hasMore: false,
    };
  }
  const settingsResults = resultFromSettings.items;

  const resultFromApps = await appsStrategy.execute(ctx, strategyDeps);
  if (resultFromApps.kind === 'return') {
    const strictApps = filterStrictResults(resultFromApps.response.results || []);
    return {
      ...resultFromApps.response,
      results: strictApps,
      totalCount: strictApps.length,
      hasMore: false,
    };
  }
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
    const score = computeCombinedScore({
      staticScore: 1,
      type: directPathCandidate.type,
      rawPath: directPathCandidate.path,
      timeMs: directPathCandidate.timeMs || 0,
    });
    return [{ ...directPathCandidate, score, staticScore: 1, weightedScore: 10_000, matchIndex: 0, nameLen: 1 }];
  })();

  const candidates = [
    ...directCandidates,
    ...commandResults,
    ...settingsResults,
    ...appResults,
    ...scoredFiles,
    ...recentBoostCandidates,
  ] as any[];

  // 先做严格命中过滤，再去重并排序，避免重复项导致“总数/列表”不一致。
  const strictMatchedCandidates = filterStrictResults(candidates);
  const uniqueStrictCandidates: any[] = [];
  const strictSeenKeys = new Set<string>();
  for (const item of strictMatchedCandidates) {
    const type = String(item?.type || "");
    const pathKey = String(item?.path || "").trim().toLowerCase();
    const nameKey = String(item?.name || "").trim().toLowerCase();
    const key = `${type}|${pathKey || nameKey}`;
    if (!key || strictSeenKeys.has(key)) continue;
    strictSeenKeys.add(key);
    uniqueStrictCandidates.push(item);
  }

  uniqueStrictCandidates.sort((a, b) => {
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
  const top500 = uniqueStrictCandidates.slice(0, DISPLAY_LIMIT);
  const initialLimit = 70;
  const firstBatch = top500.slice(0, initialLimit);
  const remainingBatch = top500.slice(initialLimit);

  const stripMeta = ({ score, sourceScore, staticScore, weightedScore, matchIndex, nameLen, timeMs, size, ...rest }: any) => rest;
  const merged = firstBatch.map(stripMeta);

  // 索引未完成时暂停图标预取，减少 I/O 与主线程压力
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
    totalCount: uniqueStrictCandidates.length,
  };
}
