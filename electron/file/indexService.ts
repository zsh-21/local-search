import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { getWindowsFileSystemRoots } from './watcher';

export const FILE_INDEX_PATH = path.join(app.getPath('userData'), 'file-index.txt');
export const FILE_INDEX_META_PATH = path.join(app.getPath('userData'), 'file-index-meta.json');
export const FILE_INDEX_VERSION = 5;

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

const shards: IndexShard[] = [];
// 限制 Worker 数量，避免过多线程竞争
const WORKER_COUNT = Math.max(2, Math.min(4, cpus().length));

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

function ensureShard(shardIndex: number, options: { baseCachePath: string; maxEntries: number }) {
  if (shards[shardIndex]?.worker) return shards[shardIndex];

  // 为每个分片分配独立的缓存文件
  const cachePath = `${options.baseCachePath.replace(/\.txt$/, '')}-${shardIndex}.txt`;
  
  // Worker 脚本由 vite-plugin-electron 构建到 dist-electron，同目录下直接加载
  // 注意：如果打包后 main.js 在 dist-electron 根目录，则此处路径正确
  const workerPath = path.join(__dirname, 'fileIndex.worker.js');
  const worker = new Worker(workerPath);
  
  const shard: IndexShard = {
    id: shardIndex,
    worker,
    pending: new Map(),
    seq: 0,
    roots: [],
  };
  shards[shardIndex] = shard;

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
    shard.worker = null;
  });

  // 初始化 Worker
  const seq = ++shard.seq;
  shard.pending.set(seq, { resolve: () => {}, reject: () => {} });
  worker.postMessage({ 
    id: seq, 
    op: 'init', 
    payload: { 
      cachePath, 
      maxEntries: Math.floor(options.maxEntries / WORKER_COUNT) // 均分最大条目限制
    } 
  });

  return shard;
}

function callShard<T>(shardIndex: number, op: FileIndexWorkerOp, payload?: any): Promise<T> {
  // 确保分片已初始化
  const shard = ensureShard(shardIndex, { 
    baseCachePath: FILE_INDEX_PATH, 
    maxEntries: 2_000_000 
  });
  if (!shard.worker) return Promise.reject(new Error('Worker init failed'));

  shard.seq += 1;
  const id = shard.seq;
  return new Promise<T>((resolve, reject) => {
    shard.pending.set(id, { resolve, reject });
    shard.worker?.postMessage({ id, op, payload });
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

// 初始化所有分片
for (let i = 0; i < WORKER_COUNT; i++) {
  ensureShard(i, { baseCachePath: FILE_INDEX_PATH, maxEntries: 2_000_000 });
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
    shards.forEach((_, i) => void callShard(i, 'setSearchWindowVisible', { visible }));
  },

  setIgnoredPaths: async (paths: string[]) => {
    setIgnoredPathsCache(paths);
    await Promise.all(shards.map((_, i) => callShard(i, 'setIgnoredPaths', { paths })));
  },

  pauseIndexingFor: (ms: number) => {
    shards.forEach((_, i) => void callShard(i, 'pauseIndexingFor', { ms }));
  },

  loadCache: async () => {
    const results = await Promise.all(shards.map((_, i) => callShard<boolean>(i, 'loadCache')));
    return results.some(r => r);
  },

  buildIfEmpty: async () => {
    await Promise.all(shards.map((_, i) => callShard(i, 'buildIfEmpty')));
  },

  rebuild: async () => {
    // 1. 获取所有盘符
    const allRoots = await getWindowsFileSystemRoots();
    
    // 2. 智能分配 Roots 给 Workers
    // 策略：
    // - 如果只有一个 C 盘，将其下的 Users 分给 Worker 0，其他目录分给 Worker 1...
    // - 如果有多个盘，按盘符分配
    
    const assignments: string[][] = Array.from({ length: WORKER_COUNT }, () => []);
    
    if (allRoots.length === 1 && allRoots[0].toLowerCase().startsWith('c')) {
      // 只有 C 盘：精细化拆分
      // Worker 0: Users (通常文件最多)
      // Worker 1: Program Files 等
      // Worker 2+: Windows (通常会被 ignore) 和其他
      assignments[0].push('C:\\Users');
      
      // 其他顶级目录分配给剩余 Worker
      // 这里为了简化，我们让其他 Worker 扫描 C:\ 但利用 `ignoredPaths` 或 `scope` 互斥？
      // 不，最好的方式是显式指定。
      // 由于无法预知 C 根目录下有哪些文件夹，我们采取一种混合策略：
      // Worker 0 负责 C:\Users
      // Worker 1 负责 C:\ 排除 Users (需要在 FileIndex 中支持 exclude? 目前不支持)
      // 变通：让 Worker 1 扫描 C:\，但在 ingestPath 时判断？不行，rebuild 是遍历。
      
      // 简单方案：
      // Worker 0: C:\Users
      // Worker 1: C:\ (全量扫描) -> 这样会重复。
      
      // 改进方案：如果只有 C 盘，所有 Worker 都扫描 C 盘，但利用 Hash Sharding 决定是否索引？
      // 这会浪费 IO（多线程扫同一个盘）。
      
      // 妥协方案：多 Worker 模式下，对于单盘系统，我们只用 1 个 Worker 负责全盘，避免复杂性。
      // 或者：C 盘很大，必须拆分。
      // 我们显式列出 C 盘常见目录？
      // [Users, Program Files, Program Files (x86), Windows, ProgramData]
      // 剩下的目录给最后一个 Worker。
      
      // 让我们采用“主目录优先”策略：
      // Shard 0: C:\Users
      // Shard 1: C:\ (根)
      // 并在 Shard 1 的 ignore 列表中临时添加 C:\Users ?
      // FileIndex 支持 setIgnoredPaths。我们可以给不同 Worker 设置不同的 ignore！
      
      // 动态设置 Ignore：
      // Shard 0: 正常 ignore
      // Shard 1: 正常 ignore + C:\Users
      
      // 保存分配信息
      shards[0].roots = ['C:\\Users'];
      shards[1].roots = ['C:\\']; // Shard 1 扫全盘
      
      // 更新 Worker 1 的 Ignore 规则，排除 Users
      // 注意：这需要 setIgnoredPaths 支持增量或我们手动合并。
      // 这里我们简单做：rebuild 时传递 explicitRoots。
      // 对于 Shard 1，我们不仅传递 roots=['C:\\']，还需要告诉它 exclude=['C:\\Users']。
      // 目前 FileIndex.ts 的 rebuild 不支持 exclude。
      
      // 回退到简单策略：单盘系统只用 Worker 0 扫全盘。多核优化仅针对多盘系统。
      // 毕竟普通用户 C 盘文件虽多，但 IO 瓶颈在，多线程扫同一个 SSD 分区提升有限且复杂。
      // 真正受益的是 C 盘 + D 盘 (数据盘)。
      
      // 修正策略：
      // 简单的 Round-Robin 分配 Roots。
      allRoots.forEach((root, idx) => {
        assignments[idx % WORKER_COUNT].push(root);
      });
      
    } else {
      // 多盘系统：均匀分配
      allRoots.forEach((root, idx) => {
        assignments[idx % WORKER_COUNT].push(root);
      });
    }

    // 更新分片状态
    assignments.forEach((roots, i) => {
      shards[i].roots = roots;
    });

    // 并行执行重建
    await Promise.all(assignments.map((roots, i) => {
      if (roots.length === 0) return Promise.resolve(); // 该 Worker 空闲
      return callShard(i, 'rebuild', { roots });
    }));
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
    
    // 2. 合并结果
    let allResults: any[] = [];
    let totalCount = 0;
    let isIndexing = false;
    
    for (const res of results) {
      if (res.results) allResults = allResults.concat(res.results);
      if (res.totalCount) totalCount += res.totalCount;
      if (res.isIndexing) isIndexing = true;
    }
    
    // 3. 排序与截断
    allResults.sort((a, b) => b.score - a.score);
    if (allResults.length > limit) {
      allResults = allResults.slice(0, limit);
    }
    
    return { results: allResults, isIndexing, totalCount };
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
