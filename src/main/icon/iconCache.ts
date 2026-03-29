import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppIconCachePath, getIconStorePath } from '../constants/storagePaths';

/** 图标数据缓存，供搜索结果与快捷入口复用。 */
export const iconDataCache = new Map<string, string>();

/** 全局图标缓存上限。 */
const ICON_CACHE_MAX = 1800;

/** 热点图标最近访问上限。 */
const HOT_ICON_LRU_MAX = 400;

/** 图标持久化版本号。 */
const ICON_STORE_VERSION = 2;

/** 持久化时最多保存的热点项数量。 */
const ICON_STORE_MAX_ITEMS = 900;

/** 单个图标持久化值的大小上限。 */
const ICON_STORE_MAX_VALUE_SIZE = 150 * 1024;

/** 热点图标 LRU 计数表。 */
const hotIconLru = new Map<string, number>();

/** 图标存储是否已加载。 */
let iconStoreLoaded = false;

/** 图标存储刷新定时器。 */
let iconStorePersistTimer: ReturnType<typeof setTimeout> | null = null;

/** 图标存储是否存在待写入内容。 */
let iconStorePersistPending = false;

/** 归一化缓存键，统一大小写与长度。 */
function normalizeKey(raw: unknown) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return key.length > 4096 ? key.slice(0, 4096) : key;
}

/** 记录热点图标访问。 */
function touchHotIcon(key: string) {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  if (hotIconLru.has(normalized)) hotIconLru.delete(normalized);
  hotIconLru.set(normalized, Date.now());
  if (hotIconLru.size <= HOT_ICON_LRU_MAX) return;
  const oldestKey = hotIconLru.keys().next().value;
  if (!oldestKey) return;
  hotIconLru.delete(String(oldestKey));
}

/** 获取当前热点图标键集合。 */
export function getHotIconKeys(limit = HOT_ICON_LRU_MAX) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (max <= 0) return [] as string[];
  return Array.from(hotIconLru.keys()).slice(-max);
}

/** 预热热点图标键。 */
export function warmHotIconLRU(keys: string[]) {
  if (!Array.isArray(keys)) return;
  for (const key of keys) touchHotIcon(key);
}

/** 判断 app 图标数据是否过小。 */
export function isTooSmallAppIconDataUrl(value: string) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return true;
  return s.length < 900;
}

/** 判断某个键值对是否应该持久化。 */
function shouldPersistKey(key: string, value: string) {
  if (!key || !value) return false;
  if (value.length > ICON_STORE_MAX_VALUE_SIZE) return false;
  if (key.startsWith('app:')) return !isTooSmallAppIconDataUrl(value);
  if (key.startsWith('command:')) return true;
  if (key.startsWith('settings:')) return true;
  if (key.startsWith('folder:')) return true;
  if (key.startsWith('ext:')) return true;
  if (key.startsWith('file:')) return true;
  return false;
}

/** 构建持久化快照。 */
function buildPersistSnapshot() {
  const keys = getHotIconKeys(ICON_STORE_MAX_ITEMS);
  const items: Array<{ key: string; value: string; hitAt: number }> = [];
  for (const key of keys) {
    const value = iconDataCache.get(key) || '';
    if (!shouldPersistKey(key, value)) continue;
    items.push({ key, value, hitAt: Date.now() });
  }
  return {
    version: ICON_STORE_VERSION,
    updatedAt: Date.now(),
    items,
  };
}

/** 刷写图标存储。 */
async function flushIconStore() {
  if (!app.isReady()) return;
  if (!iconStorePersistPending) return;
  iconStorePersistPending = false;
  try {
    const storePath = getIconStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true }).catch(() => {});
    await fs.writeFile(storePath, JSON.stringify(buildPersistSnapshot()), 'utf-8');
  } catch {
    /** 写入失败时保持静默，避免影响主流程。 */
  }
}

/** 安排图标存储刷新。 */
function scheduleIconStorePersist() {
  if (!app.isReady()) return;
  iconStorePersistPending = true;
  if (iconStorePersistTimer) return;
  iconStorePersistTimer = setTimeout(() => {
    iconStorePersistTimer = null;
    void flushIconStore();
  }, 450);
}

/** 按热点和容量规则淘汰缓存。 */
function evictIfNeeded(nextKey: string) {
  if (iconDataCache.size < ICON_CACHE_MAX) return;
  if (iconDataCache.has(nextKey)) return;

  /** 优先保留热点 app 图标，先淘汰非热点文件图标。 */
  let evictKey = '';
  for (const key of iconDataCache.keys()) {
    if (hotIconLru.has(key)) continue;
    if (key.startsWith('app:')) continue;
    evictKey = key;
    break;
  }
  if (!evictKey) {
    for (const key of iconDataCache.keys()) {
      if (hotIconLru.has(key)) continue;
      evictKey = key;
      break;
    }
  }
  if (!evictKey) {
    const firstKey = iconDataCache.keys().next().value;
    if (firstKey) evictKey = String(firstKey);
  }
  if (!evictKey) return;
  iconDataCache.delete(evictKey);
}

/** 读取单个图标缓存值。 */
export function getIconCache(key: string) {
  const normalized = normalizeKey(key);
  if (!normalized) return '';
  const value = iconDataCache.get(normalized) || '';
  if (!value) return '';
  if (iconDataCache.has(normalized)) {
    iconDataCache.delete(normalized);
    iconDataCache.set(normalized, value);
  }
  touchHotIcon(normalized);
  return value;
}

/** 写入单个图标缓存值。 */
export function setIconCache(key: string, value: string) {
  const normalized = normalizeKey(key);
  if (!normalized) return;

  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    if (!iconDataCache.has(normalized)) return;
    iconDataCache.delete(normalized);
    hotIconLru.delete(normalized);
    scheduleIconStorePersist();
    return;
  }

  if (normalized.startsWith('app:') && isTooSmallAppIconDataUrl(normalizedValue)) {
    iconDataCache.delete(normalized);
    return;
  }

  evictIfNeeded(normalized);
  if (iconDataCache.has(normalized)) iconDataCache.delete(normalized);
  iconDataCache.set(normalized, normalizedValue);
  touchHotIcon(normalized);
  scheduleIconStorePersist();
}

/** 从持久化载荷恢复缓存。 */
function restoreFromPayload(raw: unknown) {
  const payload = raw && typeof raw === 'object' ? (raw as { items?: unknown }) : {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  for (const it of items) {
    const item = it && typeof it === 'object' ? (it as { key?: unknown; value?: unknown }) : {};
    const key = normalizeKey(item.key);
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!key || !value) continue;
    if (!shouldPersistKey(key, value)) continue;
    iconDataCache.set(key, value);
    touchHotIcon(key);
  }
}

/** 迁移旧版 app 图标缓存。 */
function migrateLegacyAppIconCache() {
  try {
    const legacyPath = getAppIconCachePath();
    if (!existsSync(legacyPath)) return;
    const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    for (const it of items) {
      const key = normalizeKey(it?.key);
      const value = typeof it?.value === 'string' ? it.value.trim() : '';
      if (!key || !key.startsWith('app:')) continue;
      if (!value || isTooSmallAppIconDataUrl(value)) continue;
      iconDataCache.set(key, value);
      touchHotIcon(key);
    }
  } catch {
    /** 旧缓存迁移失败时不影响新存储流程。 */
  }
}

/** 恢复当前图标清单。 */
export function restoreIconManifest() {
  if (iconStoreLoaded) return;
  iconStoreLoaded = true;
  if (!app.isReady()) return;
  try {
    const storePath = getIconStorePath();
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8'));
      if (raw?.version === ICON_STORE_VERSION) {
        restoreFromPayload(raw);
      }
    }
  } catch {
    /** 读取失败时保持空缓存。 */
  }
  migrateLegacyAppIconCache();
}

/** 兼容旧调用：统一走新的 IconStore 恢复流程。 */
export function loadPersistedAppIconCache() {
  restoreIconManifest();
}

/** 清空持久化图标存储。 */
export async function clearPersistedIconStore() {
  if (iconStorePersistTimer) {
    clearTimeout(iconStorePersistTimer);
    iconStorePersistTimer = null;
  }
  iconStorePersistPending = false;
  if (!app.isReady()) return;
  try {
    await fs.rm(getIconStorePath(), { force: true }).catch(() => {});
    await fs.rm(getAppIconCachePath(), { force: true }).catch(() => {});
  } catch {
    /** 清理失败时不影响进程退出或后续刷新。 */
  }
}

/** 兼容旧调用：清空旧版应用图标缓存。 */
export async function clearPersistedAppIconCache() {
  await clearPersistedIconStore();
}
