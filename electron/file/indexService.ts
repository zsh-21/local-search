import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { SystemDetector } from './systemDetector';
import { shouldSkipHiddenOrSystemPath } from './utils';
import {
  getFileIndexMetaPath,
  getFileIndexPath,
  getFileIndexShardPath,
  getFileIndexShardTmpPath,
  getFileIndexTmpPath,
  getFileIndexStatsPath,
} from '../constants/storagePaths';
import {
  FILE_INDEX_ENTRIES_PER_WORKER,
  FILE_INDEX_TOTAL_MAX_ENTRIES_CAP,
  FILE_INDEX_VERSION,
  FILE_INDEX_WORKER_MAX,
  FILE_INDEX_WORKER_MIN,
} from '../constants/initialValues';

// 索引落盘路径已抽离：便于你统一维护所有缓?索引文件的落盘位?
export const FILE_INDEX_PATH = getFileIndexPath();
export const FILE_INDEX_META_PATH = getFileIndexMetaPath();
// 索引版本已抽离：便于你集中管理“结构变更触发重建”的开?
export { FILE_INDEX_VERSION };

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
  | 'search';

// 主进程的“忽略路径”判断做本地缓存：避?watcher 事件里频繁跨线程调用
let ignoredPrefixesCache: Array<{ prefix: string; prefixWithSep: string }> = [];
let ignoredAnyDirNamesCache = new Set<string>();

// 分片管理
interface IndexShard {
  id: number;
  worker: Worker | null;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  seq: number;
  roots: string[]; // 该分片负责的根路?
}

// 限制 Worker 数量，避免过多线程竞?
const WORKER_COUNT = Math.max(FILE_INDEX_WORKER_MIN, Math.min(FILE_INDEX_WORKER_MAX, cpus().length));

// 预分配分片结构：避免在未初始?Worker 时，shards.map(...) 变成空数?
const shards: IndexShard[] = Array.from({ length: WORKER_COUNT }, (_, i) => ({
  id: i,
  worker: null,
  pending: new Map(),
  seq: 0,
  roots: [],
}));

// 运行期状态缓存：用于延迟创建 Worker 时仍能保持行为一?
let searchWindowVisibleCache = false;
let ignoredPathsCacheForWorkers: string[] = [];
let preferredFileExtensionsCacheForWorkers: string[] = [];

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

  // 为每个分片分配独立的缓存文件
  const cachePath = getFileIndexShardPath(shardIndex);
  
  // Worker 脚本?vite-plugin-electron 构建?dist-electron，同目录下直接加?
  // 注意：如果打包后 main.js ?dist-electron 根目录，则此处路径正?
  const workerPath = path.join(__dirname, 'fileIndex.worker.js');

	// 这里移除固定堆上限：此前固定上限会在大盘?大目录场景触?ERR_WORKER_OUT_OF_MEMORY
	// 交由 Node/Electron 默认内存策略管理，优先保证索引构建能够完整进?
	const worker = new Worker(workerPath);
  shard.worker = worker;

  worker.on('message', (msg: any) => {
    const id = typeof msg?.id === 'number' ? msg.id : -1;
    const waiter = shard.pending.get(id);
    if (!waiter) return;
    shard.pending.delete(id);
    if (msg?.ok) waiter.resolve(msg.result);
    else waiter.reject(new Error(typeof msg?.error === 'string' ? msg.error : 'worker 调用失败'));
  });

  worker.on('error', (err) => {
    for (const [, waiter] of shard.pending) waiter.reject(err);
    shard.pending.clear();
  });
  
	worker.on('exit', () => {
		// Worker 异常退出时需要清?pending：否则调用方会一直挂起，并出现未处理?Promise rejection
		for (const [, waiter] of shard.pending) waiter.reject(new Error('Worker exited'));
		shard.pending.clear();
		shard.worker = null;
	});

  // 初始化与状态同步：需要在 Worker 创建后立即下发，否则延迟创建会导致“设置不同步?
  const fireAndForget = (op: FileIndexWorkerOp, payload?: any) => {
    const id = ++shard.seq;
    shard.pending.set(id, { resolve: () => {}, reject: () => {} });
    worker.postMessage({ id, op, payload });
  };

  // 1) init 必须最先发?
  fireAndForget('init', {
    cachePath,
    maxEntries: Math.floor(options.maxEntries / WORKER_COUNT),
  });

  // 2) 同步“搜索窗口可见性”状态：避免后创建的 Worker 低优先级策略不生?
  fireAndForget('setSearchWindowVisible', { visible: searchWindowVisibleCache });

  // 3) 同步忽略路径：避免后创建?Worker 未应用忽略规?
  if (ignoredPathsCacheForWorkers.length > 0 || preferredFileExtensionsCacheForWorkers.length > 0) {
    fireAndForget('setIgnoredPaths', {
      paths: ignoredPathsCacheForWorkers,
      preferredFileExtensions: preferredFileExtensionsCacheForWorkers,
    });
  }

  return shard;
}

function callShard<T>(shardIndex: number, op: FileIndexWorkerOp, payload?: any): Promise<T> {
  // 确保分片已初始化
	// 每个 Worker 的索引上限过大时非常容易 OOM：这里按 Worker 数控制总量，保证单 Worker 更稳?
	// 索引容量上限已抽离：便于你统一调整“最大条目数”与“每 Worker 分配?
	const totalMaxEntries = Math.min(FILE_INDEX_TOTAL_MAX_ENTRIES_CAP, WORKER_COUNT * FILE_INDEX_ENTRIES_PER_WORKER);
	const shard = ensureShard(shardIndex, {
		maxEntries: totalMaxEntries,
	});
  if (!shard.worker) return Promise.reject(new Error('Worker init failed'));

  shard.seq += 1;
  const id = shard.seq;
	return new Promise<T>((resolve, reject) => {
		shard.pending.set(id, { resolve, reject });
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
  // 根据分片负责?roots 匹配
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i];
    if (!shard || !shard.roots) continue;
    for (const root of shard.roots) {
      if (lower.startsWith(root.toLowerCase())) return i;
    }
  }
  // 兜底：如果都不匹配（可能是新盘符），简单取模或给第一?
  // 简单哈希分?
  let hash = 0;
  for (let i = 0; i < lower.length; i++) hash = (hash << 5) - hash + lower.charCodeAt(i);
  return Math.abs(hash) % WORKER_COUNT;
}

export const fileIndex = {
  reset: async () => {
    await Promise.all(shards.map((_, i) => callShard(i, 'reset')));
  },
  
  getStatus: async () => {
    const statuses = await Promise.all(shards.map((_, i) => callShard<any>(i, 'getStatus')));
    return {
      isIndexing: statuses.some(s => s.isIndexing),
      indexedCount: statuses.reduce((sum, s) => sum + (s.indexedCount || 0), 0)
    };
  },

  getDriveStats: async () => {
    const stats = await Promise.all(shards.map((_, i) => callShard<any>(i, 'getDriveStats')));
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
    // 缓存状态：用于延迟创建 Worker 后的状态同?
    searchWindowVisibleCache = visible;
    // 仅对已创建的 Worker 下发，避免为?UI 状态创?Worker
    shards.forEach((shard, i) => {
      if (!shard.worker) return;
			void callShard(i, 'setSearchWindowVisible', { visible }).catch(() => {});
    });
  },

  setIgnoredPaths: async (paths: string[], preferredFileExtensions?: string[]) => {
    setIgnoredPathsCache(paths);
    // 缓存状态：用于延迟创建 Worker 后的状态同?
    ignoredPathsCacheForWorkers = Array.isArray(paths) ? paths : [];
    preferredFileExtensionsCacheForWorkers = Array.isArray(preferredFileExtensions) ? preferredFileExtensions : [];
    // 对已创建?Worker 批量下发，避免触发未必要?Worker 初始?
    // 同时携带“常用扩展名优先”配置，让索引阶段能优先处理高频文档类型
    await Promise.all(
      shards.map((shard, i) =>
        shard.worker ? callShard(i, 'setIgnoredPaths', { paths, preferredFileExtensions: preferredFileExtensionsCacheForWorkers }) : Promise.resolve()
      )
    );
  },

  pauseIndexingFor: (ms: number) => {
    // 仅对已创建的 Worker 生效，避免为了暂停任务创?Worker
    shards.forEach((shard, i) => {
      if (!shard.worker) return;
			void callShard(i, 'pauseIndexingFor', { ms }).catch(() => {});
    });
  },

  loadCache: async () => {
    const results = await Promise.all(shards.map((_, i) => callShard<boolean>(i, 'loadCache')));
    return results.some(r => r);
  },

  buildIfEmpty: async () => {
    await Promise.all(shards.map((_, i) => callShard(i, 'buildIfEmpty')));
  },

  rebuild: async () => {
    // 1. 获取所有本地盘符及其类型（SSD/HDD?
    const info = await SystemDetector.getInstance().detect();
    // 索引优先级：优先处理?C 盘（避免系统盘占?IO 影响使用体验?
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
    // 防御性兜底：极端情况下系统探测返回空，仍然强制扫?C 盘，避免“重建秒结束?
    const rootsForRebuild = allRoots.length > 0 ? allRoots : [{ mountPoint: 'C:', isSSD: false }];

    // 2. Roots 分配?Workers：按盘符轮询分配，并携带性能标识
    const assignments: Array<Array<{ path: string; isSSD: boolean }>> = Array.from(
      { length: WORKER_COUNT },
      () => []
    );
    rootsForRebuild.forEach((drive, idx) => {
      assignments[idx % WORKER_COUNT].push({
        path: drive.mountPoint + '\\',
        isSSD: drive.isSSD,
      });
    });

    // 更新分片状?
    assignments.forEach((roots, i) => {
      shards[i].roots = roots.map((r) => r.path);
    });

    // 并行执行重建
    await Promise.all(
      assignments.map((roots, i) => {
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
    // 路由到负责该路径的分?
    const shardIdx = getShardForPath(p);
    await callShard(shardIdx, 'ingestPath', { path: p, isDirectory, timeMs });
  },

  removePath: async (p: string) => {
    // 删除时可能需要广播？或者也路由?
    // 如果路径路由策略变了（比?roots 变了），可能找不到?
    // 安全起见：广播删除?
    await Promise.all(shards.map((_, i) => callShard(i, 'removePath', { path: p })));
  },

  search: async (query: string, limit: number, options?: { where?: any }) => {
    const driveEq = (() => {
      const w = options?.where;
      if (!w) return null;
      if (typeof (w as any)?.drive?.eq === 'string') return String((w as any).drive.eq || '');
      const and = (w as any)?.and;
      if (Array.isArray(and)) {
        for (const it of and) {
          if (typeof it?.drive?.eq === 'string') return String(it.drive.eq || '');
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
      targetShardIndices.map((i) => callShard<any>(i, 'search', { query, limit, options }))
    );
    
    // 2. 合并结果：用 Top-K 插入替代全量 sort，降低高频搜索时?CPU 波动
    const topResults: any[] = [];
    const insertTopK = (item: any) => {
      if (!item) return;
      if (!Number.isFinite(item.score)) return;
      if (limit <= 0) return;

      // 二分插入，保?topResults ?score 降序
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

export async function clearFileIndexCacheOnDisk() {
  const tasks: Array<Promise<any>> = [];
  tasks.push(fs.rm(FILE_INDEX_META_PATH, { force: true }).catch(() => {}));
  tasks.push(fs.rm(FILE_INDEX_PATH, { force: true }).catch(() => {}));
  tasks.push(fs.rm(getFileIndexTmpPath(), { force: true }).catch(() => {}));
  tasks.push(fs.rm(getFileIndexStatsPath(), { force: true }).catch(() => {}));
  for (let i = 0; i < WORKER_COUNT; i++) {
    tasks.push(fs.rm(getFileIndexShardPath(i), { force: true }).catch(() => {}));
    tasks.push(fs.rm(getFileIndexShardTmpPath(i), { force: true }).catch(() => {}));
  }
  await Promise.all(tasks);
}

export function loadFileIndexMeta(): { version: number; appVersion?: string; driveSignature?: string } | null {
  try {
    if (!existsSync(FILE_INDEX_META_PATH)) return null;
    const raw = JSON.parse(readFileSync(FILE_INDEX_META_PATH, 'utf-8'));
    if (typeof raw?.version !== 'number') return null;
    const appVersion = typeof raw?.appVersion === 'string' ? raw.appVersion : undefined;
    const driveSignature = typeof raw?.driveSignature === 'string' ? raw.driveSignature : undefined;
    return { version: raw.version, appVersion, driveSignature };
  } catch {
    return null;
  }
}

export function saveFileIndexMeta(meta: { version: number; appVersion?: string; driveSignature?: string }) {
  try {
    writeFileSync(FILE_INDEX_META_PATH, JSON.stringify(meta));
  } catch {}
}



