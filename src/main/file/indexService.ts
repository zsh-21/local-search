import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { SystemDetector } from './systemDetector';
import { shouldSkipHiddenOrSystemPath } from './utils';
import { resolveIndexWorkerCount, resolveIndexWorkerRuntimeContext } from './indexRuntime';
import {
  getFileIndexMetaPath,
  getFileIndexPath,
  getFileIndexShardPath,
  getFileIndexStatsPath,
} from '../constants/storagePaths';
import { getCacheArtifactPaths } from './indexCacheLayout';
import {
  FILE_INDEX_ENTRIES_PER_WORKER,
  FILE_INDEX_LAYOUT_VERSION,
  FILE_INDEX_TOTAL_MAX_ENTRIES_CAP,
  FILE_INDEX_VERSION,
} from '../constants/initialValues';
import type { FileIndexSearchResult, FileIndexStatus } from '../fileIndex';
export const FILE_INDEX_PATH = getFileIndexPath();
export const FILE_INDEX_META_PATH = getFileIndexMetaPath();
export { FILE_INDEX_VERSION };
export { FILE_INDEX_LAYOUT_VERSION };
type FileIndexWorkerOp =
  | 'init'
  | 'reset'
  | 'getStatus'
  | 'getDriveStats'
  | 'setSearchWindowVisible'
  | 'setIgnoredPaths'
  | 'pauseIndexingFor'
  | 'loadCache'
  | 'buildIfEmpty'
  | 'rebuild'
  | 'abortRebuild'
  | 'ingestPath'
  | 'removePath'
  | 'cancelSearchSession'
  | 'search';
type RebuildAssignment = Array<{ path: string; isSSD: boolean }>;
type FileIndexWorkerMessage = { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
type FileIndexDriveStats = { totalCount: number; drives: Array<{ drive: string; count: number }> };
type FileIndexSearchOptions = { where?: unknown; sessionId?: string };
type FileIndexSearchResponse = { results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number; rawCount: number };
type WorkerPendingResolver = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };
export type FileIndexCacheLoadReport = {
  workerCount: number;
  totalShards: number;
  activeShardCount: number;
  loadedShardCount: number;
  loadedActiveShardCount: number;
  perShardLoaded: boolean[];
  perShardHasRoots: boolean[];
  missingActiveShardIndices: number[];
  hasAnyCache: boolean;
  isPartial: boolean;
};
let ignoredPrefixesCache: Array<{ prefix: string; prefixWithSep: string }> = [];
let ignoredAnyDirNamesCache = new Set<string>();
interface IndexShard {
  id: number;
  worker: Worker | null;
  pending: Map<number, WorkerPendingResolver>;
  seq: number;
  roots: string[]; // 璇ュ垎鐗囪礋璐ｇ殑鏍硅矾?
}
const WORKER_COUNT = resolveIndexWorkerCount(resolveIndexWorkerRuntimeContext());
const shards: IndexShard[] = Array.from({ length: WORKER_COUNT }, (_, i) => ({
  id: i,
  worker: null,
  pending: new Map(),
  seq: 0,
  roots: [],
}));
let searchWindowVisibleCache = false;
let ignoredPathsCacheForWorkers: string[] = [];
let preferredFileExtensionsCacheForWorkers: string[] = [];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
function setIgnoredPathsCache(paths: string[]) {
  const raw: string[] = Array.isArray(paths) ? paths : [];
  const next: Array<{ prefix: string; prefixWithSep: string }> = [];
  const seen = new Set<string>();
  const anyDirNames = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    let s = v.replace(/\//g, '\\').trim();
    if (!s) continue;
    s = s.replace(/\\+/g, '\\');
    const anyDirMatch = s.match(/^\*\*\\([^\\\/]+)$/) || s.match(/^\*\*\/([^\\\/]+)$/);
    if (anyDirMatch) {
      const name = (anyDirMatch[1] || '').trim().toLowerCase();
      if (name) anyDirNames.add(name);
      continue;
    }
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
    if (/^[a-zA-Z]:\\$/.test(s)) {
      const p = s.toLowerCase();
      if (seen.has(p)) continue;
      seen.add(p);
      next.push({ prefix: p, prefixWithSep: p });
      continue;
    }
    s = s.replace(/\\$/g, '');
    const p = s.toLowerCase();
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    next.push({ prefix: p, prefixWithSep: `${p}\\` });
  }
  next.sort((a, b) => b.prefix.length - a.prefix.length);
  ignoredPrefixesCache = next;
  ignoredAnyDirNamesCache = anyDirNames;
}
export function isIgnoredPathByCache(targetPath: string) {
  if (!targetPath) return false;
  if (shouldSkipHiddenOrSystemPath(targetPath)) return true;
  const t = targetPath.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  if (ignoredAnyDirNamesCache.size > 0) {
    for (const name of ignoredAnyDirNamesCache) {
      if (!name) continue;
      const seg = `\\${name}\\`;
      if (t.includes(seg)) return true;
      if (t.endsWith(`\\${name}`) || t === name) return true;
    }
  }
  if (!ignoredPrefixesCache.length) return false;
  for (const it of ignoredPrefixesCache) {
    if (t === it.prefix) return true;
    if (t.startsWith(it.prefixWithSep)) return true;
  }
  return false;
}
function ensureShard(shardIndex: number, options: { maxEntries: number }) {
  const shard = shards[shardIndex];
  if (shard?.worker) return shard;
  const cachePath = getFileIndexShardPath(shardIndex);
  const workerPath = path.join(__dirname, 'fileIndex.worker.js');
	const worker = new Worker(workerPath);
  shard.worker = worker;
  worker.on('message', (msg: FileIndexWorkerMessage) => {
    const id = typeof msg?.id === 'number' ? msg.id : -1;
    const waiter = shard.pending.get(id);
    if (!waiter) return;
    shard.pending.delete(id);
    if (msg?.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(typeof msg?.error === 'string' ? msg.error : 'worker 璋冪敤澶辫触'));
  });
  worker.on('error', (err) => {
    for (const [, waiter] of shard.pending) waiter.reject(err);
    shard.pending.clear();
  });
	worker.on('exit', () => {
		for (const [, waiter] of shard.pending) waiter.reject(new Error('Worker exited'));
		shard.pending.clear();
		shard.worker = null;
	});
  // 鍒濆鍖栦笌鐘舵€佸悓姝ワ細闇€瑕佸湪 Worker 鍒涘缓鍚庣珛鍗充笅鍙戯紝鍚﹀垯寤惰繜鍒涘缓浼氬鑷粹€滆缃笉鍚屾?
  const fireAndForget = (op: FileIndexWorkerOp, payload?: unknown) => {
    const id = ++shard.seq;
    shard.pending.set(id, { resolve: () => {}, reject: () => {} });
    worker.postMessage({ id, op, payload });
  };
  // 1) init 蹇呴』鏈€鍏堝彂?
  fireAndForget('init', {
    cachePath,
    maxEntries: Math.floor(options.maxEntries / WORKER_COUNT),
  });
  // 2) 鍚屾鈥滄悳绱㈢獥鍙ｅ彲瑙佹€р€濈姸鎬侊細閬垮厤鍚庡垱寤虹殑 Worker 浣庝紭鍏堢骇绛栫暐涓嶇敓?
  fireAndForget('setSearchWindowVisible', { visible: searchWindowVisibleCache });
  // 3) 鍚屾蹇界暐璺緞锛氶伩鍏嶅悗鍒涘缓?Worker 鏈簲鐢ㄥ拷鐣ヨ?
  if (ignoredPathsCacheForWorkers.length > 0 || preferredFileExtensionsCacheForWorkers.length > 0) {
    fireAndForget('setIgnoredPaths', {
      paths: ignoredPathsCacheForWorkers,
      preferredFileExtensions: preferredFileExtensionsCacheForWorkers,
    });
  }
  return shard;
}
function callShard<T>(shardIndex: number, op: FileIndexWorkerOp, payload?: unknown): Promise<T> {
  // 纭繚鍒嗙墖宸插垵濮嬪寲
	// 姣忎釜 Worker 鐨勭储寮曚笂闄愯繃澶ф椂闈炲父瀹规槗 OOM锛氳繖閲屾寜 Worker 鏁版帶鍒舵€婚噺锛屼繚璇佸崟 Worker 鏇寸ǔ?
	// 绱㈠紩瀹归噺涓婇檺宸叉娊绂伙細渚夸簬浣犵粺涓€璋冩暣鈥滄渶澶ф潯鐩暟鈥濅笌鈥滄瘡 Worker 鍒嗛厤?
	const totalMaxEntries = Math.min(FILE_INDEX_TOTAL_MAX_ENTRIES_CAP, WORKER_COUNT * FILE_INDEX_ENTRIES_PER_WORKER);
	const shard = ensureShard(shardIndex, {
		maxEntries: totalMaxEntries,
	});
  if (!shard.worker) return Promise.reject(new Error('Worker init failed'));
  shard.seq += 1;
  const id = shard.seq;
	return new Promise<T>((resolve, reject) => {
		shard.pending.set(id, { resolve: (value) => resolve(value as T), reject: (reason) => reject(reason) });
		try {
			shard.worker?.postMessage({ id, op, payload });
		} catch (err) {
			shard.pending.delete(id);
			shard.worker = null;
			reject(err);
		}
	});
}
function getShardForPath(targetPath: string): number {
  if (!targetPath) return 0;
  const lower = targetPath.toLowerCase();
  // 鏍规嵁鍒嗙墖璐熻矗?roots 鍖归厤
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i];
    if (!shard || !shard.roots) continue;
    for (const root of shard.roots) {
      if (lower.startsWith(root.toLowerCase())) return i;
    }
  }
  // 鍏滃簳锛氬鏋滈兘涓嶅尮閰嶏紙鍙兘鏄柊鐩樼锛夛紝绠€鍗曞彇妯℃垨缁欑涓€?
  // 绠€鍗曞搱甯屽垎?
  let hash = 0;
  for (let i = 0; i < lower.length; i++) hash = (hash << 5) - hash + lower.charCodeAt(i);
  return Math.abs(hash) % WORKER_COUNT;
}
async function resolveRebuildAssignments(): Promise<RebuildAssignment[]> {
  const info = await SystemDetector.getInstance().detect();
  const allRoots = info.drives
    .slice()
    .sort((a, b) => {
      const da = String(a?.mountPoint || '').toUpperCase();
      const db = String(b?.mountPoint || '').toUpperCase();
      const pa = da === 'C:' ? 1 : 0;
      const pb = db === 'C:' ? 1 : 0;
      if (pa !== pb) return pa - pb;
      return da.localeCompare(db);
    });
  const rootsForRebuild = allRoots.length > 0 ? allRoots : [{ mountPoint: 'C:', isSSD: false }];
  const assignments: RebuildAssignment[] = Array.from({ length: WORKER_COUNT }, () => []);
  rootsForRebuild.forEach((drive, idx) => {
    assignments[idx % WORKER_COUNT].push({ path: `${drive.mountPoint}\\`, isSSD: drive.isSSD });
  });
  return assignments;
}
function applyShardRoots(assignments: RebuildAssignment[]) { assignments.forEach((roots, i) => { shards[i].roots = roots.map((r) => r.path); }); }
function createEmptyAssignments(): RebuildAssignment[] { return Array.from({ length: WORKER_COUNT }, () => []); }
export const fileIndex = {
  reset: async () => {
    await Promise.all(shards.map((_, i) => callShard(i, 'reset')));
  },
  getStatus: async () => {
    const statuses = await Promise.all(shards.map((_, i) => callShard<FileIndexStatus>(i, 'getStatus')));
    const isIndexing = statuses.some((s) => Boolean(s?.isIndexing));
    const activeStatuses = statuses.filter((s) => Boolean(s?.isIndexing));
    const progressSource = activeStatuses.length > 0 ? activeStatuses : statuses;
    const progress =
      progressSource.length > 0
        ? progressSource.reduce((sum, s) => {
            const raw = Number(s?.progress);
            const normalized = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
            return sum + normalized;
          }, 0) / progressSource.length
        : 1;
    return {
      isIndexing,
      indexedCount: statuses.reduce((sum, s) => sum + (s.indexedCount || 0), 0),
      progress: isIndexing ? Math.min(0.99, Math.max(0.01, progress)) : 1,
    };
  },
  getDriveStats: async () => {
    const stats = await Promise.all(shards.map((_, i) => callShard<FileIndexDriveStats>(i, 'getDriveStats')));
    const driveCounts = new Map<string, number>();
    let totalCount = 0;
    for (const s of stats) {
      const drives = Array.isArray(s?.drives) ? s.drives : [];
      for (const d of drives) {
        const key = typeof d?.drive === 'string' ? d.drive : '';
        if (!key) continue;
        driveCounts.set(key, (driveCounts.get(key) || 0) + (Number(d.count) || 0));
      }
      totalCount += Number(s?.totalCount) || 0;
    }
    const drives = Array.from(driveCounts.entries())
      .map(([drive, count]) => ({ drive, count }))
      .sort((a, b) => a.drive.localeCompare(b.drive));
    return { totalCount, drives };
  },
  setSearchWindowVisible: (visible: boolean) => {
    // 缂撳瓨鐘舵€侊細鐢ㄤ簬寤惰繜鍒涘缓 Worker 鍚庣殑鐘舵€佸悓?
    searchWindowVisibleCache = visible;
    // 浠呭宸插垱寤虹殑 Worker 涓嬪彂锛岄伩鍏嶄负?UI 鐘舵€佸垱?Worker
    shards.forEach((shard, i) => {
      if (!shard.worker) return;
			void callShard(i, 'setSearchWindowVisible', { visible }).catch(() => {});
    });
  },
  setIgnoredPaths: async (paths: string[], preferredFileExtensions?: string[]) => {
    setIgnoredPathsCache(paths);
    // 缂撳瓨鐘舵€侊細鐢ㄤ簬寤惰繜鍒涘缓 Worker 鍚庣殑鐘舵€佸悓?
    ignoredPathsCacheForWorkers = Array.isArray(paths) ? paths : [];
    preferredFileExtensionsCacheForWorkers = Array.isArray(preferredFileExtensions) ? preferredFileExtensions : [];
    // 瀵瑰凡鍒涘缓?Worker 鎵归噺涓嬪彂锛岄伩鍏嶈Е鍙戞湭蹇呰?Worker 鍒濆?
    // 鍚屾椂鎼哄甫鈥滃父鐢ㄦ墿灞曞悕浼樺厛鈥濋厤缃紝璁╃储寮曢樁娈佃兘浼樺厛澶勭悊楂橀鏂囨。绫诲瀷
    await Promise.all(
      shards.map((shard, i) =>
        shard.worker ? callShard(i, 'setIgnoredPaths', { paths, preferredFileExtensions: preferredFileExtensionsCacheForWorkers }) : Promise.resolve()
      )
    );
  },
  pauseIndexingFor: (ms: number) => {
    // 浠呭宸插垱寤虹殑 Worker 鐢熸晥锛岄伩鍏嶄负浜嗘殏鍋滀换鍔″垱?Worker
    shards.forEach((shard, i) => {
      if (!shard.worker) return;
			void callShard(i, 'pauseIndexingFor', { ms }).catch(() => {});
    });
  },
  loadCache: async (): Promise<FileIndexCacheLoadReport> => {
    const [perShardLoaded, assignments] = await Promise.all([
      Promise.all(shards.map((_, i) => callShard<boolean>(i, 'loadCache').catch(() => false))),
      resolveRebuildAssignments().catch(() => createEmptyAssignments()),
    ]);
    applyShardRoots(assignments);
    const perShardHasRoots = assignments.map((roots) => roots.length > 0);
    const missingActiveShardIndices: number[] = [];
    let activeShardCount = 0;
    let loadedActiveShardCount = 0;
    for (let i = 0; i < WORKER_COUNT; i++) {
      if (!perShardHasRoots[i]) continue;
      activeShardCount += 1;
      if (perShardLoaded[i]) loadedActiveShardCount += 1;
      else missingActiveShardIndices.push(i);
    }
    const loadedShardCount = perShardLoaded.filter(Boolean).length;
    const hasAnyCache = loadedActiveShardCount > 0 || loadedShardCount > 0;
    const isPartial =
      activeShardCount > 0 &&
      loadedActiveShardCount > 0 &&
      loadedActiveShardCount < activeShardCount;
    return {
      workerCount: WORKER_COUNT,
      totalShards: WORKER_COUNT,
      activeShardCount,
      loadedShardCount,
      loadedActiveShardCount,
      perShardLoaded,
      perShardHasRoots,
      missingActiveShardIndices,
      hasAnyCache,
      isPartial,
    };
  },
  buildIfEmpty: async () => {
    await Promise.all(shards.map((_, i) => callShard(i, 'buildIfEmpty')));
  },
  rebuild: async () => {
    const assignments = await resolveRebuildAssignments();
    applyShardRoots(assignments);
    await Promise.all(
      assignments.map((roots, i) => {
        if (roots.length === 0) return Promise.resolve();
        return callShard(i, 'rebuild', roots);
      })
    );
  },
  rebuildShards: async (targetShardIndices: number[]) => {
    const shardSet = new Set(
      (Array.isArray(targetShardIndices) ? targetShardIndices : [])
        .map((it) => Math.floor(Number(it)))
        .filter((idx) => Number.isFinite(idx) && idx >= 0 && idx < WORKER_COUNT)
    );
    if (shardSet.size <= 0) return;
    const assignments = await resolveRebuildAssignments();
    applyShardRoots(assignments);
    await Promise.all(
      Array.from(shardSet).map((i) => {
        const roots = assignments[i] || [];
        if (roots.length === 0) return Promise.resolve();
        return callShard(i, 'rebuild', roots);
      })
    );
  },
  abortRebuild: async () => {
    await Promise.all(
      shards.map((shard, i) =>
        shard.worker ? callShard(i, 'abortRebuild') : Promise.resolve()
      )
    );
  },
  ingestPath: async (p: string, isDirectory: boolean, timeMs?: number) => {
    // 璺敱鍒拌礋璐ｈ璺緞鐨勫垎?
    const shardIdx = getShardForPath(p);
    await callShard(shardIdx, 'ingestPath', { path: p, isDirectory, timeMs });
  },
  removePath: async (p: string) => {
    // 鍒犻櫎鏃跺彲鑳介渶瑕佸箍鎾紵鎴栬€呬篃璺敱?
    // 濡傛灉璺緞璺敱绛栫暐鍙樹簡锛堟瘮?roots 鍙樹簡锛夛紝鍙兘鎵句笉鍒?
    // 瀹夊叏璧疯锛氬箍鎾垹闄?
    await Promise.all(shards.map((_, i) => callShard(i, 'removePath', { path: p })));
  },
  cancelSearchSession: async (sessionId: string) => {
    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalized) return;
    await Promise.all(
      shards.map((shard, i) => (shard.worker ? callShard(i, 'cancelSearchSession', { sessionId: normalized }) : Promise.resolve()))
    );
  },
  search: async (query: string, limit: number, options?: FileIndexSearchOptions) => {
    const driveEq = (() => {
      const w = options?.where;
      if (!isRecord(w)) return null;
      const drive = w.drive;
      if (isRecord(drive) && typeof drive.eq === 'string') return String(drive.eq || '');
      const and = w.and;
      if (Array.isArray(and)) {
        for (const it of and) {
          if (!isRecord(it)) continue;
          const clauseDrive = it.drive;
          if (isRecord(clauseDrive) && typeof clauseDrive.eq === 'string') return String(clauseDrive.eq || '');
        }
      }
      return null;
    })();
    const targetShardIndices = (() => {
      if (process.platform !== 'win32') return shards.map((_, i) => i);
      const d = typeof driveEq === 'string' ? driveEq.trim().toLowerCase() : '';
      if (!/^[a-z]$/.test(d)) return shards.map((_, i) => i);
      const shardIdx = getShardForPath(`${d}:\\`);
      return [shardIdx];
    })();
    const results = await Promise.all(
      targetShardIndices.map((i) => callShard<FileIndexSearchResponse>(i, 'search', { query, limit, options }))
    );
    // 2. 鍚堝苟缁撴灉锛氱敤 Top-K 鎻掑叆鏇夸唬鍏ㄩ噺 sort锛岄檷浣庨珮棰戞悳绱㈡椂?CPU 娉㈠姩
    const topResults: FileIndexSearchResult[] = [];
    const insertTopK = (item: FileIndexSearchResult) => {
      if (!item) return;
      if (!Number.isFinite(item.score)) return;
      if (limit <= 0) return;
      // 浜屽垎鎻掑叆锛屼繚?topResults ?score 闄嶅簭
      let lo = 0;
      let hi = topResults.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (item.score > topResults[mid].score) hi = mid;
        else lo = mid + 1;
      }
      topResults.splice(lo, 0, item);
      if (topResults.length > limit) topResults.pop();
    };
    let totalCount = 0;
    let isIndexing = false;
    let rawCount = 0;
    for (const res of results) {
      if (Array.isArray(res.results)) {
        for (const it of res.results) insertTopK(it);
      }
      if (res.totalCount) totalCount += res.totalCount;
      if (res.rawCount) rawCount += res.rawCount;
      if (res.isIndexing) isIndexing = true;
    }
    return { results: topResults, isIndexing, totalCount, rawCount };
  }
};
export function getWorkerCount() { return WORKER_COUNT; }
export async function clearFileIndexCacheOnDisk() {
  const tasks: Array<Promise<unknown>> = [];
  tasks.push(fs.rm(FILE_INDEX_META_PATH, { force: true }).catch(() => {}));
  tasks.push(fs.rm(getFileIndexStatsPath(), { force: true }).catch(() => {}));
  const rootArtifacts = getCacheArtifactPaths(FILE_INDEX_PATH);
  tasks.push(fs.rm(rootArtifacts.legacyPath, { force: true }).catch(() => {}));
  tasks.push(fs.rm(rootArtifacts.legacyTmpPath, { force: true }).catch(() => {}));
  tasks.push(fs.rm(rootArtifacts.snapshotPath, { force: true }).catch(() => {}));
  tasks.push(fs.rm(rootArtifacts.snapshotTmpPath, { force: true }).catch(() => {}));
  tasks.push(fs.rm(rootArtifacts.deltaPath, { force: true }).catch(() => {}));
  for (let i = 0; i < WORKER_COUNT; i++) {
    const shardArtifacts = getCacheArtifactPaths(getFileIndexShardPath(i));
    tasks.push(fs.rm(shardArtifacts.legacyPath, { force: true }).catch(() => {}));
    tasks.push(fs.rm(shardArtifacts.legacyTmpPath, { force: true }).catch(() => {}));
    tasks.push(fs.rm(shardArtifacts.snapshotPath, { force: true }).catch(() => {}));
    tasks.push(fs.rm(shardArtifacts.snapshotTmpPath, { force: true }).catch(() => {}));
    tasks.push(fs.rm(shardArtifacts.deltaPath, { force: true }).catch(() => {}));
  }
  await Promise.all(tasks);
}
export function loadFileIndexMeta(): { version: number; layoutVersion?: number; workerCount?: number } | null {
  try {
    if (!existsSync(FILE_INDEX_META_PATH)) return null;
    const raw: unknown = JSON.parse(readFileSync(FILE_INDEX_META_PATH, 'utf-8'));
    if (!isRecord(raw) || typeof raw.version !== 'number') return null;
    const layoutVersion = typeof raw.layoutVersion === 'number' ? raw.layoutVersion : undefined;
    const workerCount = typeof raw.workerCount === 'number' ? raw.workerCount : undefined;
    return { version: raw.version, layoutVersion, workerCount };
  } catch {
    return null;
  }
}
export function saveFileIndexMeta(meta: { version: number; layoutVersion?: number; workerCount?: number }) {
  try {
    writeFileSync(FILE_INDEX_META_PATH, JSON.stringify(meta));
  } catch {}
}




