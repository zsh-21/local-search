import { app } from 'electron';
import path from 'node:path';
import { existsSync, watch } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileIndex, isIgnoredPathByCache } from './indexService';
import { shouldSkipHiddenOrSystemPath } from './utils';

// 运行期可能插拔U盘，watcher 需要按 root 动态增�?
const userDirWatchers = new Map<string, ReturnType<typeof watch>>();
// Windows 盘符根目录列表缓存：用于文件监听与索引重建，避免重复拉取 PowerShell 结果
let windowsFileSystemRootsCache: string[] = [];
// Windows 盘符缓存的最后刷新时间：降低 PowerShell 调用频率，减少后台常驻资源消�?
let windowsFileSystemRootsLastAt = 0;
let windowsRootsRefreshTimer: ReturnType<typeof setInterval> | null = null;

// 盘符刷新间隔：U 盘插拔属于低频事件，没必要每 12 秒拉一�?PowerShell
const WINDOWS_ROOTS_REFRESH_INTERVAL_MS = 2 * 60 * 1000;

const WATCH_EVENT_DEBOUNCE_MS = 260;
const WATCH_MAX_IN_FLIGHT = 6;
const watchDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const watchBacklog: string[] = [];
const watchBacklogSet = new Set<string>();
let watchInFlight = 0;

// 最近变更索引：用于弥补 fs.watch 丢事�?全量索引未覆盖导致的“新建文件搜不到�?
const RECENT_INDEX_MAX = 30_000;
export const recentIndex = new Map<string, { path: string; name: string; isDirectory: boolean; timeMs: number }>();
let recentReconcileInFlight = false;
let recentReconcileLastAt = 0;

export function normalizeRecentKey(rawPath: string) {
  return typeof rawPath === 'string' ? rawPath.trim().toLowerCase() : '';
}

async function handleWatchPath(fullPath: string) {
  try {
    const st = await fs.stat(fullPath);
    const isDir = st.isDirectory();
    const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
    upsertRecentIndex(fullPath, isDir, timeMs);
    await fileIndex.ingestPath(fullPath, isDir, timeMs);
  } catch {
    recentIndex.delete(normalizeRecentKey(fullPath));
    try {
      await fileIndex.removePath(fullPath);
    } catch {}
  }
}

function drainWatchBacklog() {
  while (watchInFlight < WATCH_MAX_IN_FLIGHT && watchBacklog.length > 0) {
    const fullPath = watchBacklog.shift();
    if (!fullPath) break;
    const key = normalizeRecentKey(fullPath);
    watchBacklogSet.delete(key);
    watchInFlight += 1;
    void (async () => {
      try {
        await handleWatchPath(fullPath);
      } finally {
        watchInFlight -= 1;
        drainWatchBacklog();
      }
    })();
  }
}

function scheduleWatchWork(fullPath: string) {
  const key = normalizeRecentKey(fullPath);
  if (!key) return;
  const prev = watchDebounceTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    watchDebounceTimers.delete(key);
    if (watchBacklogSet.has(key)) return;
    watchBacklogSet.add(key);
    watchBacklog.push(fullPath);
    drainWatchBacklog();
  }, WATCH_EVENT_DEBOUNCE_MS);
  watchDebounceTimers.set(key, timer);
}

export function upsertRecentIndex(fullPath: string, isDirectory: boolean, timeMs: number) {
  // 最近变更索引：只保存必要字段，优先保证“新�?刚改动”的内容可被搜索�?
  const key = normalizeRecentKey(fullPath);
  if (!key) return;
  const name = path.basename(fullPath);
  if (!name) return;
  recentIndex.set(key, { path: fullPath, name, isDirectory, timeMs });
  if (recentIndex.size > RECENT_INDEX_MAX) {
    const keys = Array.from(recentIndex.keys());
    keys.sort((a, b) => (recentIndex.get(b)?.timeMs || 0) - (recentIndex.get(a)?.timeMs || 0));
    const keep = new Set(keys.slice(0, Math.floor(RECENT_INDEX_MAX * 0.85)));
    for (const k of keys) {
      if (keep.has(k)) continue;
      recentIndex.delete(k);
    }
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
      const ps = spawn('powershell', [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root',
      ], { windowsHide: true });
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
  // watcher 的过滤必须快速：这里用主进程缓存�?ignore 规则避免跨线程往�?
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

export async function startUserDirectoryWatchers() {
  const normalizeWatchRoot = (p: string) => {
    const raw = typeof p === 'string' ? p.trim() : '';
    if (!raw) return '';
    const s = raw.replace(/\//g, '\\');
    return s.endsWith('\\') ? s : `${s}\\`;
  };

  const ensureWatchRoot = (root: string) => {
    const normalized = normalizeWatchRoot(root);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (userDirWatchers.has(key)) return;
    if (!existsSync(normalized)) return;
    try {
      const w = watch(normalized, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const raw = filename.toString().replace(/\//g, '\\');
        // Windows �?fs.watch 可能返回以单反斜杠开头的路径（例�?\Users\...\a.txt）：
        // - path.isAbsolute('\\Users\\...') === true，但它缺少盘符，无法用于打开/索引
        // - 这里�?watcher 根目录的盘符进行补齐，确�?recentIndex 与索引写入始终是“可用的绝对路径�?
        const fullPath = (() => {
          if (process.platform !== 'win32') return path.isAbsolute(raw) ? raw : path.join(normalized, raw);
          const isWinFullAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
          if (isWinFullAbs) return raw;
          if (raw.startsWith('\\')) {
            const drive = normalized.slice(0, 2);
            if (/^[a-zA-Z]:$/.test(drive)) return `${drive}${raw}`;
            // 非盘符根（例�?UNC 根）时，去掉开头的反斜杠再拼接，避�?path.join 被“绝对段”覆�?
            return path.join(normalized, raw.replace(/^\\+/, ''));
          }
          return path.join(normalized, raw);
        })();
        if (shouldSkipWatchPath(fullPath)) return;
        scheduleWatchWork(fullPath);
      });
      userDirWatchers.set(key, w);
    } catch {}
  };

  const refreshRootsAndWatch = async () => {
    // Windows 盘符可能运行期变化（U�?移动硬盘），这里定时刷新并增�?watcher
    if (process.platform === 'win32') {
      try {
        const now = Date.now();
        // 降低 PowerShell 调用频率：在刷新间隔内直接复用缓存结�?
        if (now - windowsFileSystemRootsLastAt > WINDOWS_ROOTS_REFRESH_INTERVAL_MS || windowsFileSystemRootsCache.length === 0) {
          windowsFileSystemRootsCache = await getWindowsFileSystemRoots();
          windowsFileSystemRootsLastAt = now;
        }
      } catch {}
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

    for (const root of uniqueRoots) ensureWatchRoot(root);
    for (const [k, w] of userDirWatchers.entries()) {
      if (keep.has(k)) continue;
      try {
        w.close();
      } catch {}
      userDirWatchers.delete(k);
    }
  };

  await refreshRootsAndWatch();
  if (process.platform === 'win32') {
    if (windowsRootsRefreshTimer) {
      clearInterval(windowsRootsRefreshTimer);
      windowsRootsRefreshTimer = null;
    }
    windowsRootsRefreshTimer = setInterval(() => {
      void refreshRootsAndWatch();
    }, WINDOWS_ROOTS_REFRESH_INTERVAL_MS);
  }
}

export async function reconcileRecentIndex(budgetMs = 1200) {
  // 兜底扫描：当 fs.watch 丢事件或全量索引未覆盖时，尽量把“最近新�?改动”的文件补进 recentIndex
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
        return [home, desktop, documents, downloads].filter(
          (p): p is string => typeof p === 'string' && Boolean(p.trim())
        );
      }
      return [app.getPath('home')].filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
    })();

    const startAt = Date.now();
    const MAX_DEPTH = 5;
    const MAX_VISIT = 14_000;
    let visited = 0;
    const queue: Array<{ dir: string; depth: number }> = roots.map((d) => ({ dir: d, depth: 0 }));

    while (queue.length > 0) {
      if (Date.now() - startAt > Math.max(50, budgetMs)) break;
      if (visited >= MAX_VISIT) break;
      const it = queue.shift();
      if (!it) break;
      const dir = it.dir;
      const depth = it.depth;
      if (!dir) continue;
      if (!existsSync(dir)) continue;
      if (shouldSkipWatchPath(dir)) continue;

      let dh: any = null;
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
            // 兜底扫描属于后台任务：使用异�?stat，避免阻塞主进程
            const st = await fs.stat(fullPath);
            const isDir = st.isDirectory();
            const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
            upsertRecentIndex(fullPath, isDir, timeMs);
            if (isDir && depth < MAX_DEPTH) queue.push({ dir: fullPath, depth: depth + 1 });
          } catch {}
        }
      } finally {
        try {
          await dh.close();
        } catch {}
      }
    }
  } finally {
    recentReconcileInFlight = false;
  }
}

export function closeAllWatchers() {
  if (windowsRootsRefreshTimer) {
    clearInterval(windowsRootsRefreshTimer);
    windowsRootsRefreshTimer = null;
  }
  for (const t of watchDebounceTimers.values()) {
    clearTimeout(t);
  }
  watchDebounceTimers.clear();
  watchBacklog.length = 0;
  watchBacklogSet.clear();
  for (const w of userDirWatchers.values()) {
    try {
      w.close();
    } catch {}
  }
  userDirWatchers.clear();
}

export { getWindowsFileSystemRoots };


