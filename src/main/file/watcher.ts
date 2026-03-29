import { app } from 'electron';
import path from 'node:path';
import { existsSync, watch } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileIndex, isIgnoredPathByCache } from './indexService';
import { shouldSkipHiddenOrSystemPath } from './utils';
import { createWatcherEventReducer } from './watcherEventReducer';
import { WatcherActionQueue } from './watcherActionQueue';
import { safeWatcherLog } from './watcherLog';
import {
  WATCH_BACKLOG_RECONCILE_THRESHOLD,
  WINDOWS_ROOTS_REFRESH_FAILSAFE_INTERVAL_MS,
  WINDOWS_ROOTS_REFRESH_IDLE_INTERVAL_MS,
  WINDOWS_ROOTS_REFRESH_INDEXING_INTERVAL_MS,
} from '../constants/initialValues';
/** 目录句柄类型，避免在异步目录处理中使用宽泛类型。 */
type FsDirHandle = Awaited<ReturnType<typeof fs.opendir>>;
/** 文件状态类型，统一读取时间戳时复用。 */
type FsStat = Awaited<ReturnType<typeof fs.stat>>;
const userDirWatchers = new Map<string, ReturnType<typeof watch>>();
let windowsFileSystemRootsCache: string[] = [];
let windowsRootsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let rootsWatcherBootstrapped = false;
type DriveWarmupTask = {
  cancelled: boolean;
  promise: Promise<void>;
};
const driveWarmupTasks = new Map<string, DriveWarmupTask>();
const DRIVE_WARMUP_YIELD_INTERVAL = 120;
const DRIVE_WARMUP_YIELD_SLEEP_MS = 8;
const WATCH_REDUCE_WINDOW_MS = 250;
const WATCH_PARENT_STORM_THRESHOLD = 40;
const WATCH_MAX_IN_FLIGHT = 6;
let watchReduceTimer: ReturnType<typeof setTimeout> | null = null;
const watchReducer = createWatcherEventReducer({
  windowMs: WATCH_REDUCE_WINDOW_MS,
  parentStormThreshold: WATCH_PARENT_STORM_THRESHOLD,
});
const RECENT_INDEX_MAX = 30_000;
/** 最近访问索引，供搜索和回补扫描复用。 */
export const recentIndex = new Map<string, { path: string; name: string; isDirectory: boolean; timeMs: number }>();
let recentReconcileInFlight = false;
let recentReconcileLastAt = 0;
/** 统一生成最近项键，便于大小写和空白归一化。 */
export function normalizeRecentKey(rawPath: string) {
  return typeof rawPath === 'string' ? rawPath.trim().toLowerCase() : '';
}
function getStatTimeMs(stat: FsStat | null) {
  if (!stat) return 0;
  return Math.max(Number(stat.mtimeMs || 0), Number(stat.birthtimeMs || 0));
}
async function handleWatchRemovePath(fullPath: string) {
  recentIndex.delete(normalizeRecentKey(fullPath));
  try {
    await fileIndex.removePath(fullPath);
  } catch {
  }
}
/** 处理单个文件变更或新增事件。 */
async function handleWatchPath(fullPath: string) {
  try {
    const st = await fs.stat(fullPath);
    const isDir = st.isDirectory();
    const timeMs = getStatTimeMs(st);
    upsertRecentIndex(fullPath, isDir, timeMs);
    await fileIndex.ingestPath(fullPath, isDir, timeMs);
  } catch {
    await handleWatchRemovePath(fullPath);
  }
}
async function rescanParentPath(parentPath: string) {
  if (!parentPath) return;
  const normalized = parentPath.replace(/\//g, '\\');
  if (!existsSync(normalized)) {
    await handleWatchRemovePath(normalized);
    return;
  }
  if (shouldSkipWatchPath(normalized)) return;
  let dh: FsDirHandle | null = null;
  try {
    dh = await fs.opendir(normalized);
  } catch {
    return;
  }
  const MAX_RESCAN_ITEMS = 2000;
  let scanned = 0;
  try {
    for await (const ent of dh) {
      if (!ent?.name) continue;
      const fullPath = path.join(normalized, String(ent.name));
      if (shouldSkipWatchPath(fullPath)) continue;
      await handleWatchPath(fullPath);
      scanned += 1;
      if (scanned >= MAX_RESCAN_ITEMS) break;
    }
  } finally {
    try {
      await dh.close();
    } catch {
    }
  }
}
const watchActionQueue = new WatcherActionQueue(WATCH_MAX_IN_FLIGHT, {
  ingestPath: handleWatchPath,
  removePath: handleWatchRemovePath,
  rescanParent: rescanParentPath,
});
function maybeScheduleReconcileFromBacklog() {
  if (watchActionQueue.getBacklogSize() < WATCH_BACKLOG_RECONCILE_THRESHOLD) return;
  void reconcileRecentIndex(700).catch(() => {});
}
function flushReducedActions() {
  const reduced = watchReducer.flush();
  if (reduced.reducedActionCount > 0) {
    watchActionQueue.enqueueMany(reduced.actions);
    maybeScheduleReconcileFromBacklog();
  }
  if (reduced.rawEventCount > reduced.reducedActionCount && reduced.rawEventCount >= 20) {
    safeWatcherLog(`[watcher] reduce raw=${reduced.rawEventCount} actions=${reduced.reducedActionCount}`);
  }
}
function enqueueFsEvent(eventType: string, fullPath: string) {
  watchReducer.enqueue(eventType, fullPath);
  if (watchReduceTimer) return;
  watchReduceTimer = setTimeout(() => {
    watchReduceTimer = null;
    flushReducedActions();
  }, watchReducer.windowMs);
}
export function upsertRecentIndex(fullPath: string, isDirectory: boolean, timeMs: number) {
  const key = normalizeRecentKey(fullPath);
  if (!key) return;
  const name = path.basename(fullPath);
  if (!name) return;
  recentIndex.set(key, { path: fullPath, name, isDirectory, timeMs });
  if (recentIndex.size <= RECENT_INDEX_MAX) return;
  const keys = Array.from(recentIndex.keys());
  keys.sort((a, b) => (recentIndex.get(b)?.timeMs || 0) - (recentIndex.get(a)?.timeMs || 0));
  const keep = new Set(keys.slice(0, Math.floor(RECENT_INDEX_MAX * 0.85)));
  for (const k of keys) {
    if (keep.has(k)) continue;
    recentIndex.delete(k);
  }
}
export function trimRecentIndex(maxKeep: number) {
  const limit = Math.max(1000, Math.floor(Number(maxKeep) || 0));
  if (recentIndex.size <= limit) return;
  const keys = Array.from(recentIndex.keys());
  keys.sort((a, b) => (recentIndex.get(b)?.timeMs || 0) - (recentIndex.get(a)?.timeMs || 0));
  const keep = new Set(keys.slice(0, limit));
  for (const k of keys) {
    if (keep.has(k)) continue;
    recentIndex.delete(k);
  }
}
async function getWindowsFileSystemRoots(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const ps = spawn(
        'powershell',
        ['-NoLogo', '-NoProfile', '-Command', 'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root'],
        { windowsHide: true }
      );
      let out = '';
      ps.stdout.on('data', (d) => (out += d.toString()));
      ps.on('close', () => {
        const roots = out
          .split(/\r?\n/g)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => (s.endsWith('\\') ? s : `${s}\\`));
        resolve(Array.from(new Set(roots)));
      });
      ps.on('error', () => resolve(['C:\\']));
    } catch {
      resolve(['C:\\']);
    }
  });
}
export function shouldSkipWatchPath(fullPath: string) {
  if (isIgnoredPathByCache(fullPath)) return true;
  if (shouldSkipHiddenOrSystemPath(fullPath)) return true;
  const lower = fullPath.toLowerCase();
  return (
    lower.includes('\\node_modules\\') ||
    lower.includes('\\.git\\') ||
    lower.includes('\\.svn\\') ||
    lower.includes('\\.idea\\') ||
    lower.includes('\\$recycle.bin\\') ||
    lower.includes('\\system volume information\\')
  );
}
function isWindowsDriveRoot(root: string) {
  return /^[a-zA-Z]:\\$/.test(root);
}
function cancelDriveWarmupByKey(rootKey: string) {
  const task = driveWarmupTasks.get(rootKey);
  if (!task) return;
  task.cancelled = true;
  driveWarmupTasks.delete(rootKey);
}
function startDriveWarmup(root: string) {
  if (process.platform !== 'win32') return;
  const normalizedRoot = typeof root === 'string' ? root.replace(/\//g, '\\').trim() : '';
  if (!isWindowsDriveRoot(normalizedRoot)) return;
  const key = normalizedRoot.toLowerCase();
  if (driveWarmupTasks.has(key)) return;
  if (!existsSync(normalizedRoot)) return;
  const task: DriveWarmupTask = { cancelled: false, promise: Promise.resolve() };
  task.promise = (async () => {
    const stack: string[] = [normalizedRoot];
    const visitedDirs = new Set<string>();
    let visited = 0;
    while (stack.length > 0 && !task.cancelled) {
      const dir = stack.pop();
      if (!dir) continue;
      if (!existsSync(dir)) continue;
      if (shouldSkipWatchPath(dir)) continue;
      const dirKey = normalizeRecentKey(dir);
      if (!dirKey || visitedDirs.has(dirKey)) continue;
      visitedDirs.add(dirKey);
      let dh: FsDirHandle | null = null;
      try {
        dh = await fs.opendir(dir);
      } catch {
        continue;
      }
      try {
        for await (const ent of dh) {
          if (task.cancelled) break;
          if (!ent?.name) continue;
          const fullPath = path.join(dir, String(ent.name));
          if (!existsSync(fullPath)) continue;
          if (shouldSkipWatchPath(fullPath)) continue;
          let st: FsStat | null = null;
          try {
            st = await fs.stat(fullPath);
          } catch {
            continue;
          }
          const isDir = st.isDirectory();
          const isSymlink = ent.isSymbolicLink();
          const timeMs = getStatTimeMs(st);
          try {
            await fileIndex.ingestPath(fullPath, isDir, timeMs);
          } catch {
          }
          if (isDir && !isSymlink) stack.push(fullPath);
          visited += 1;
          if (visited % DRIVE_WARMUP_YIELD_INTERVAL === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, DRIVE_WARMUP_YIELD_SLEEP_MS));
          }
        }
      } finally {
        try {
          await dh.close();
        } catch {
        }
      }
    }
  })().finally(() => {
    const current = driveWarmupTasks.get(key);
    if (current === task) driveWarmupTasks.delete(key);
  });
  driveWarmupTasks.set(key, task);
}
/** 启动用户目录 watcher，并同步根目录预热任务。 */
export async function startUserDirectoryWatchers() {
  const normalizeWatchRoot = (input: string) => {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) return '';
    const normalized = raw.replace(/\//g, '\\');
    return normalized.endsWith('\\') ? normalized : `${normalized}\\`;
  };
  const ensureWatchRoot = (root: string) => {
    const normalized = normalizeWatchRoot(root);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (userDirWatchers.has(key)) return;
    if (!existsSync(normalized)) return;
    try {
      const watcher = watch(normalized, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const raw = filename.toString().replace(/\//g, '\\');
        const fullPath = (() => {
          if (process.platform !== 'win32') return path.isAbsolute(raw) ? raw : path.join(normalized, raw);
          const isWinFullAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
          if (isWinFullAbs) return raw;
          if (raw.startsWith('\\')) {
            const drive = normalized.slice(0, 2);
            if (/^[a-zA-Z]:$/.test(drive)) return `${drive}${raw}`;
            return path.join(normalized, raw.replace(/^\\+/, ''));
          }
          return path.join(normalized, raw);
        })();
        if (shouldSkipWatchPath(fullPath)) return;
        enqueueFsEvent(eventType, fullPath);
      });
      userDirWatchers.set(key, watcher);
    } catch {
    }
  };
  const refreshRootsAndWatch = async () => {
    if (process.platform === 'win32') {
      try {
        windowsFileSystemRootsCache = await getWindowsFileSystemRoots();
      } catch {
      }
    }
    const roots = (() => {
      if (process.platform === 'win32') {
        const home = app.getPath('home');
        const desktop = app.getPath('desktop');
        const documents = app.getPath('documents');
        const downloads = app.getPath('downloads');
        return [...windowsFileSystemRootsCache, home, desktop, documents, downloads].filter(
          (p): p is string => typeof p === 'string' && Boolean(p.trim())
        );
      }
      return [app.getPath('home')].filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
    })();
    const uniqueRoots = Array.from(new Set(roots.map(normalizeWatchRoot).filter(Boolean)));
    const keep = new Set(uniqueRoots.map((r) => r.toLowerCase()));
    const prevRootKeys = new Set(userDirWatchers.keys());
    const addedRoots = uniqueRoots.filter((root) => !prevRootKeys.has(root.toLowerCase()));
    for (const root of uniqueRoots) ensureWatchRoot(root);
    for (const [key, watcher] of userDirWatchers.entries()) {
      if (keep.has(key)) continue;
      try {
        watcher.close();
      } catch {
      }
      userDirWatchers.delete(key);
      cancelDriveWarmupByKey(key);
    }
    if (rootsWatcherBootstrapped) {
      for (const root of addedRoots) {
        startDriveWarmup(root);
      }
    }
    rootsWatcherBootstrapped = true;
  };
  await refreshRootsAndWatch();
  if (process.platform === 'win32') {
    if (windowsRootsRefreshTimer) {
      clearTimeout(windowsRootsRefreshTimer);
      windowsRootsRefreshTimer = null;
    }
    const resolveDelayMs = async () => {
      try {
        const status = await fileIndex.getStatus();
        return status?.isIndexing ? WINDOWS_ROOTS_REFRESH_INDEXING_INTERVAL_MS : WINDOWS_ROOTS_REFRESH_IDLE_INTERVAL_MS;
      } catch {
        return WINDOWS_ROOTS_REFRESH_FAILSAFE_INTERVAL_MS;
      }
    };
    const scheduleNextRefresh = (delayMs: number) => {
      const nextDelayMs = Math.max(
        1000,
        Number.isFinite(Number(delayMs)) ? Math.floor(Number(delayMs)) : WINDOWS_ROOTS_REFRESH_FAILSAFE_INTERVAL_MS
      );
      windowsRootsRefreshTimer = setTimeout(() => {
        void (async () => {
          if (!rootsWatcherBootstrapped) return;
          await refreshRootsAndWatch();
          if (!rootsWatcherBootstrapped) return;
          scheduleNextRefresh(await resolveDelayMs());
        })();
      }, nextDelayMs);
    };
    scheduleNextRefresh(await resolveDelayMs());
  }
}
/** 回补最近索引，限制时长和访问量，避免影响主流程。 */
export async function reconcileRecentIndex(budgetMs = 1200) {
  if (recentReconcileInFlight) return;
  const now = Date.now();
  if (now - recentReconcileLastAt < 2000) return;
  recentReconcileInFlight = true;
  recentReconcileLastAt = now;
  try {
    const roots = (() => {
      if (process.platform === 'win32') {
        const home = app.getPath('home');
        const desktop = app.getPath('desktop');
        const documents = app.getPath('documents');
        const downloads = app.getPath('downloads');
        return [home, desktop, documents, downloads].filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
      }
      return [app.getPath('home')].filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
    })();
    const startAt = Date.now();
    const MAX_DEPTH = 5;
    const MAX_VISIT = 14_000;
    let visited = 0;
    const queue: Array<{ dir: string; depth: number }> = roots.map((dir) => ({ dir, depth: 0 }));
    while (queue.length > 0) {
      if (Date.now() - startAt > Math.max(50, budgetMs)) break;
      if (visited >= MAX_VISIT) break;
      const item = queue.shift();
      if (!item) break;
      const dir = item.dir;
      const depth = item.depth;
      if (!dir) continue;
      if (!existsSync(dir)) continue;
      if (shouldSkipWatchPath(dir)) continue;
      let dh: FsDirHandle | null = null;
      try {
        dh = await fs.opendir(dir);
      } catch {
        continue;
      }
      try {
        for await (const ent of dh) {
          visited += 1;
          if (visited % 350 === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          if (Date.now() - startAt > Math.max(50, budgetMs)) break;
          if (!ent?.name) continue;
          const fullPath = path.join(dir, ent.name);
          if (shouldSkipWatchPath(fullPath)) continue;
          try {
            const st = await fs.stat(fullPath);
            const isDir = st.isDirectory();
            const timeMs = getStatTimeMs(st);
            upsertRecentIndex(fullPath, isDir, timeMs);
            if (isDir && depth < MAX_DEPTH) queue.push({ dir: fullPath, depth: depth + 1 });
          } catch {
          }
        }
      } finally {
        try {
          await dh.close();
        } catch {
        }
      }
    }
  } finally {
    recentReconcileInFlight = false;
  }
}
/** 关闭所有 watcher 和预热任务，供应用退出时统一清理。 */
export function closeAllWatchers() {
  if (windowsRootsRefreshTimer) {
    clearTimeout(windowsRootsRefreshTimer);
    windowsRootsRefreshTimer = null;
  }
  if (watchReduceTimer) {
    clearTimeout(watchReduceTimer);
    watchReduceTimer = null;
  }
  flushReducedActions();
  watchActionQueue.clear();
  for (const watcher of userDirWatchers.values()) {
    try {
      watcher.close();
    } catch {
    }
  }
  userDirWatchers.clear();
  for (const key of driveWarmupTasks.keys()) {
    cancelDriveWarmupByKey(key);
  }
  rootsWatcherBootstrapped = false;
}
/** 获取 watcher 动作队列积压长度，用于手动刷新时判断是否补扫。 */
export function getWatcherBacklogSize() {
  return watchActionQueue.getBacklogSize();
}
export { getWindowsFileSystemRoots };
