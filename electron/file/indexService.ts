import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const FILE_INDEX_PATH = path.join(app.getPath('userData'), 'file-index.txt');
const FILE_INDEX_META_PATH = path.join(app.getPath('userData'), 'file-index-meta.json');
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

function createFileIndexWorkerClient(options: { cachePath: string; maxEntries?: number }) {
  let worker: Worker | null = null;
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  const ensure = () => {
    if (worker) return worker;
    // Worker 脚本由 vite-plugin-electron 构建到 dist-electron，同目录下直接加载
    // 注意：如果打包后 main.js 在 dist-electron 根目录，则此处路径正确
    const workerPath = path.join(__dirname, 'fileIndex.worker.js');
    worker = new Worker(workerPath);
    worker.on('message', (msg: any) => {
      const id = typeof msg?.id === 'number' ? msg.id : -1;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (msg?.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(typeof msg?.error === 'string' ? msg.error : 'worker 调用失败'));
    });
    worker.on('error', (err) => {
      // worker 崩溃时，清空挂起请求避免“永远不返回”导致 UI 卡死
      for (const [, waiter] of pending) waiter.reject(err);
      pending.clear();
    });
    worker.on('exit', () => {
      worker = null;
    });

    void call('init', options);
    return worker;
  };

  const call = <T>(op: FileIndexWorkerOp, payload?: any) => {
    ensure();
    seq += 1;
    const id = seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker?.postMessage({ id, op, payload });
    });
  };

  return {
    reset: () => call<void>('reset'),
    getStatus: () => call<any>('getStatus'),
    setSearchWindowVisible: (visible: boolean) => {
      // 该操作无需等待返回：仅用于调整索引“让出时间片”的策略
      void call<void>('setSearchWindowVisible', { visible });
    },
    setIgnoredPaths: async (paths: string[]) => {
      // 同步更新主进程本地缓存 + Worker 内部忽略规则，保证 watcher 与索引一致
      setIgnoredPathsCache(paths);
      await call<void>('setIgnoredPaths', { paths });
    },
    pauseIndexingFor: (ms: number) => {
      // 该操作无需等待：用于在交互期快速提示 Worker“暂停索引让路”
      void call<void>('pauseIndexingFor', { ms });
    },
    loadCache: () => call<boolean>('loadCache'),
    buildIfEmpty: () => call<void>('buildIfEmpty'),
    rebuild: () => call<void>('rebuild'),
    ingestPath: (p: string, isDirectory: boolean) => call<void>('ingestPath', { path: p, isDirectory }),
    removePath: (p: string) => call<void>('removePath', { path: p }),
    search: (query: string, limit: number, options?: { where?: any }) =>
      call<any>('search', { query, limit, options }),
  };
}

export const fileIndex = createFileIndexWorkerClient({ cachePath: FILE_INDEX_PATH, maxEntries: 2_000_000 });

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

export { FILE_INDEX_PATH, FILE_INDEX_META_PATH };
