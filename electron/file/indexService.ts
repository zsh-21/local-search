import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { SystemDetector } from './systemDetector';
import { getFileIndexMetaPath, getFileIndexPath, getFileIndexShardPath } from '../constants/storagePaths';
import {
  FILE_INDEX_ENTRIES_PER_WORKER,
  FILE_INDEX_TOTAL_MAX_ENTRIES_CAP,
  FILE_INDEX_VERSION,
  FILE_INDEX_WORKER_HEAP_MB_DEFAULT,
  FILE_INDEX_WORKER_HEAP_MB_FOR_4,
  FILE_INDEX_WORKER_MAX,
  FILE_INDEX_WORKER_MIN,
} from '../constants/initialValues';

// 索引落盘路径已抽离：便于你统一维护所有缓存/索引文件的落盘位置
export const FILE_INDEX_PATH = getFileIndexPath();
export const FILE_INDEX_META_PATH = getFileIndexMetaPath();
// 索引版本已抽离：便于你集中管理“结构变更触发重建”的开关
export { FILE_INDEX_VERSION };

type FileIndexWorkerOp =
  | 'init'
  | 'reset'
  | 'getStatus'
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

// 主进程的“忽略路径”判断做本地缓存：避免 watcher 事件里频繁跨线程调用
let ignoredPrefixesCache: Array<{ prefix: string; prefixWithSep: string }> = [];
let ignoredAnyDirNamesCache = new Set<string>();

// 分片管理
interface IndexShard {
  id: number;
  worker: Worker | null;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>;
  seq: number;
  roots: string[]; // 该分片负责的根路径
}

// 限制 Worker 数量，避免过多线程竞争
const WORKER_COUNT = Math.max(FILE_INDEX_WORKER_MIN, Math.min(FILE_INDEX_WORKER_MAX, cpus().length));

// 预分配分片结构：避免在未初始化 Worker 时，shards.map(...) 变成空数组
const shards: IndexShard[] = Array.from({ length: WORKER_COUNT }, (_, i) => ({
  id: i,
  worker: null,
  pending: new Map(),
  seq: 0,
  roots: [],
}));

// 运行期状态缓存：用于延迟创建 Worker 时仍能保持行为一致
let searchWindowVisibleCache = false;
let ignoredPathsCacheForWorkers: string[] = [];

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
  
  // Worker 脚本由 vite-plugin-electron 构建到 dist-electron，同目录下直接加载
  // 注意：如果打包后 main.js 在 dist-electron 根目录，则此处路径正确
  const workerPath = path.join(__dirname, 'fileIndex.worker.js');

	// 限制/调整 Worker 堆大小：索引会占用较多内存，默认上限容易触发 OOM
	// 这里按 Worker 数量做保守配置，避免多 Worker 同时把系统内存吃满
	const worker = new Worker(workerPath, {
		resourceLimits: {
			maxOldGenerationSizeMb: WORKER_COUNT >= 4 ? FILE_INDEX_WORKER_HEAP_MB_FOR_4 : FILE_INDEX_WORKER_HEAP_MB_DEFAULT,
		},
	});
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
		// Worker 异常退出时需要清理 pending：否则调用方会一直挂起，并出现未处理的 Promise rejection
		for (const [, waiter] of shard.pending) waiter.reject(new Error('Worker exited'));
		shard.pending.clear();
		shard.worker = null;
	});

  // 初始化与状态同步：需要在 Worker 创建后立即下发，否则延迟创建会导致“设置不同步”
  const fireAndForget = (op: FileIndexWorkerOp, payload?: any) => {
    const id = ++shard.seq;
    shard.pending.set(id, { resolve: () => {}, reject: () => {} });
    worker.postMessage({ id, op, payload });
  };

  // 1) init 必须最先发送
  fireAndForget('init', {
    cachePath,
    maxEntries: Math.floor(options.maxEntries / WORKER_COUNT),
  });

  // 2) 同步“搜索窗口可见性”状态：避免后创建的 Worker 低优先级策略不生效
  fireAndForget('setSearchWindowVisible', { visible: searchWindowVisibleCache });

  // 3) 同步忽略路径：避免后创建的 Worker 未应用忽略规则
  if (ignoredPathsCacheForWorkers.length > 0) {
    fireAndForget('setIgnoredPaths', { paths: ignoredPathsCacheForWorkers });
  }

  return shard;
}

function callShard<T>(shardIndex: number, op: FileIndexWorkerOp, payload?: any): Promise<T> {
  // 确保分片已初始化
	// 每个 Worker 的索引上限过大时非常容易 OOM：这里按 Worker 数控制总量，保证单 Worker 更稳定
	// 索引容量上限已抽离：便于你统一调整“最大条目数”与“每 Worker 分配”
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
  // 根据分片负责的 roots 匹配
  for (let i = 0; i < shards.length; i++) {
    const shard = shards[i];
    if (!shard || !shard.roots) continue;
    for (const root of shard.roots) {
      if (lower.startsWith(root.toLowerCase())) return i;
    }
  }
  // 兜底：如果都不匹配（可能是新盘符），简单取模或给第一个
  // 简单哈希分配
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

  setSearchWindowVisible: (visible: boolean) => {
    // 缓存状态：用于延迟创建 Worker 后的状态同步
    searchWindowVisibleCache = visible;
    // 仅对已创建的 Worker 下发，避免为了 UI 状态创建 Worker
    shards.forEach((shard, i) => {
      if (!shard.worker) return;
			void callShard(i, 'setSearchWindowVisible', { visible }).catch(() => {});
    });
  },

  setIgnoredPaths: async (paths: string[]) => {
    setIgnoredPathsCache(paths);
    // 缓存状态：用于延迟创建 Worker 后的状态同步
    ignoredPathsCacheForWorkers = Array.isArray(paths) ? paths : [];
    // 对已创建的 Worker 批量下发，避免触发未必要的 Worker 初始化
    await Promise.all(
      shards
        .map((shard, i) => (shard.worker ? callShard(i, 'setIgnoredPaths', { paths }) : Promise.resolve()))
    );
  },

  pauseIndexingFor: (ms: number) => {
    // 仅对已创建的 Worker 生效，避免为了暂停任务创建 Worker
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
    // 1. 获取所有本地盘符及其类型（SSD/HDD）
    const info = await SystemDetector.getInstance().detect();
    const allRoots = info.drives;

    // 2. Roots 分配给 Workers：按盘符轮询分配，并携带性能标识
    const assignments: Array<Array<{ path: string; isSSD: boolean }>> = Array.from(
      { length: WORKER_COUNT },
      () => []
    );
    allRoots.forEach((drive, idx) => {
      assignments[idx % WORKER_COUNT].push({
        path: drive.mountPoint + '\\',
        isSSD: drive.isSSD,
      });
    });

    // 更新分片状态
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

  ingestPath: async (p: string, isDirectory: boolean) => {
    // 路由到负责该路径的分片
    const shardIdx = getShardForPath(p);
    await callShard(shardIdx, 'ingestPath', { path: p, isDirectory });
  },

  removePath: async (p: string) => {
    // 删除时可能需要广播？或者也路由？
    // 如果路径路由策略变了（比如 roots 变了），可能找不到。
    // 安全起见：广播删除。
    await Promise.all(shards.map((_, i) => callShard(i, 'removePath', { path: p })));
  },

  search: async (query: string, limit: number, options?: { where?: any }) => {
    // 1. 广播搜索
    const results = await Promise.all(shards.map((_, i) => 
      callShard<any>(i, 'search', { query, limit, options })
    ));
    
    // 2. 合并结果：用 Top-K 插入替代全量 sort，降低高频搜索时的 CPU 波动
    const topResults: any[] = [];
    const insertTopK = (item: any) => {
      if (!item) return;
      if (!Number.isFinite(item.score)) return;
      if (limit <= 0) return;

      // 二分插入，保持 topResults 按 score 降序
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
    
    for (const res of results) {
      if (Array.isArray(res.results)) {
        for (const it of res.results) insertTopK(it);
      }
      if (res.totalCount) totalCount += res.totalCount;
      if (res.isIndexing) isIndexing = true;
    }

    return { results: topResults, isIndexing, totalCount };
  }
};

export function loadFileIndexMeta(): { version: number } | null {
  try {
    if (!existsSync(FILE_INDEX_META_PATH)) return null;
    const raw = JSON.parse(readFileSync(FILE_INDEX_META_PATH, 'utf-8'));
    if (typeof raw?.version !== 'number') return null;
    return { version: raw.version };
  } catch {
    return null;
  }
}

export function saveFileIndexMeta(meta: { version: number }) {
  try {
    writeFileSync(FILE_INDEX_META_PATH, JSON.stringify(meta));
  } catch {}
}
