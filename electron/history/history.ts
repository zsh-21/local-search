import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadSettings } from '../config/settings';
import { resolveAppId } from '../win/resolveAppId';

const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
const HISTORY_STATS_PATH = path.join(app.getPath('userData'), 'history-stats.json');

export type HistoryItem = { name: string; path: string; type: string; lastUsed: number };

export type HistoryStats = {
  version: 1;
  byPath: Record<string, { count: number; lastUsed: number }>;
  byType: Record<string, number>;
  byExt: Record<string, number>;
};

export function normalizeHistoryKey(rawPath: string) {
  return typeof rawPath === 'string' ? rawPath.trim().toLowerCase() : '';
}

export function normalizeExtKey(rawPath: string) {
  try {
    const resolved = resolveAppId(rawPath);
    const ext = path.extname(resolved).toLowerCase();
    if (!ext) return '';
    if (ext.length > 12) return '';
    return ext;
  } catch {
    return '';
  }
}

export function isExistingTarget(target: { path: string; type?: string }) {
  const p = target.path;
  if (!p) return false;
  if (target.type === 'app') return true;
  const resolved = resolveAppId(p);
  if (!resolved.includes('\\') && !resolved.includes('/')) return true;
  return existsSync(resolved);
}

export function loadHistory(): HistoryItem[] {
  try {
    if (!existsSync(HISTORY_PATH)) return [];
    const raw = JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((x) => ({
        name: typeof x?.name === 'string' ? x.name : '',
        path: typeof x?.path === 'string' ? x.path : '',
        type: typeof x?.type === 'string' ? x.type : 'file',
        lastUsed: typeof x?.lastUsed === 'number' ? x.lastUsed : 0,
      }))
      .filter((x) => x.name && x.path);
  } catch {
    return [];
  }
}

export function saveHistory(items: HistoryItem[]) {
  try {
    writeFileSync(HISTORY_PATH, JSON.stringify(items));
  } catch {}
}

export function loadHistoryStats(): HistoryStats {
  try {
    if (!existsSync(HISTORY_STATS_PATH)) {
      // 首次启用统计：用已有历史记录做一次轻量种子，避免“刚升级就完全没权重”
      const seed: HistoryStats = { version: 1, byPath: {}, byType: {}, byExt: {} };
      const history = loadHistory();
      for (const h of history) {
        const key = normalizeHistoryKey(h.path);
        if (!key) continue;
        seed.byPath[key] = { count: 1, lastUsed: h.lastUsed || 0 };
        const t = typeof h.type === 'string' && h.type ? h.type : 'file';
        seed.byType[t] = (typeof seed.byType[t] === 'number' ? seed.byType[t] : 0) + 1;
        const ext = t === 'file' ? normalizeExtKey(h.path) : '';
        if (ext) seed.byExt[ext] = (typeof seed.byExt[ext] === 'number' ? seed.byExt[ext] : 0) + 1;
      }
      if (history.length > 0) saveHistoryStats(seed);
      return seed;
    }
    const raw = JSON.parse(readFileSync(HISTORY_STATS_PATH, 'utf-8'));
    if (raw?.version !== 1) return { version: 1, byPath: {}, byType: {}, byExt: {} };
    return {
      version: 1,
      byPath: typeof raw?.byPath === 'object' && raw.byPath ? raw.byPath : {},
      byType: typeof raw?.byType === 'object' && raw.byType ? raw.byType : {},
      byExt: typeof raw?.byExt === 'object' && raw.byExt ? raw.byExt : {},
    };
  } catch {
    return { version: 1, byPath: {}, byType: {}, byExt: {} };
  }
}

export function saveHistoryStats(stats: HistoryStats) {
  try {
    writeFileSync(HISTORY_STATS_PATH, JSON.stringify(stats));
  } catch {}
}

export function updateHistoryStatsOnUse(item: { path: string; type?: string }, now: number) {
  // 访问统计用于综合排序：路径访问频次、类型偏好、扩展名偏好
  const key = normalizeHistoryKey(item.path);
  if (!key) return;
  const stats = loadHistoryStats();

  const prev = stats.byPath[key];
  const nextCount = typeof prev?.count === 'number' && prev.count > 0 ? prev.count + 1 : 1;
  stats.byPath[key] = { count: nextCount, lastUsed: now };

  const t = typeof item.type === 'string' && item.type ? item.type : 'file';
  stats.byType[t] = (typeof stats.byType[t] === 'number' ? stats.byType[t] : 0) + 1;

  const extKey = t === 'file' ? normalizeExtKey(item.path) : '';
  if (extKey) {
    stats.byExt[extKey] = (typeof stats.byExt[extKey] === 'number' ? stats.byExt[extKey] : 0) + 1;
  }

  const MAX_PATH_KEYS = 6000;
  const KEEP_PATH_KEYS = 5000;
  const keys = Object.keys(stats.byPath);
  if (keys.length > MAX_PATH_KEYS) {
    keys.sort((a, b) => (stats.byPath[b]?.lastUsed || 0) - (stats.byPath[a]?.lastUsed || 0));
    const keep = new Set(keys.slice(0, KEEP_PATH_KEYS));
    const nextByPath: Record<string, { count: number; lastUsed: number }> = {};
    for (const k of keep) nextByPath[k] = stats.byPath[k];
    stats.byPath = nextByPath;
  }

  saveHistoryStats(stats);
}

export function recordHistoryItem(item: { name: string; path: string; type?: string }) {
  if (!item?.name || !item?.path) return;
  const settings = loadSettings();
  if (!settings.enableHistory) return;
  if (!isExistingTarget(item)) return;

  const now = Date.now();
  const current = loadHistory();
  const next: HistoryItem[] = [
    { name: item.name, path: item.path, type: item.type || 'file', lastUsed: now },
    ...current.filter((h) => h.path !== item.path),
  ].filter((h) => isExistingTarget(h));

  const limit = settings.historyLimit;
  saveHistory(limit > 0 ? next.slice(0, limit) : []);
  updateHistoryStatsOnUse({ path: item.path, type: item.type }, now);
}

export function clearHistory() {
    saveHistory([]);
    return true;
}

export function deleteHistoryItemFunc(targetPath: string) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
    const trimmed = targetPath.trim();
    const history = loadHistory();
    const next = history.filter((h) => h.path !== trimmed);
    saveHistory(next);
    return true;
}
