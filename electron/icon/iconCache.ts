import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getAppIconCachePath, getIconStorePath } from "../constants/storagePaths";

export const iconDataCache = new Map<string, string>();

const ICON_CACHE_MAX = 1800;
const HOT_ICON_LRU_MAX = 400;
const ICON_STORE_VERSION = 2;
const ICON_STORE_MAX_ITEMS = 900;
const ICON_STORE_MAX_VALUE_SIZE = 150 * 1024;

const hotIconLru = new Map<string, number>();
let iconStoreLoaded = false;
let iconStorePersistTimer: ReturnType<typeof setTimeout> | null = null;
let iconStorePersistPending = false;

function normalizeKey(raw: unknown) {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return key.length > 4096 ? key.slice(0, 4096) : key;
}

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

export function getHotIconKeys(limit = HOT_ICON_LRU_MAX) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (max <= 0) return [] as string[];
  return Array.from(hotIconLru.keys()).slice(-max);
}

export function warmHotIconLRU(keys: string[]) {
  if (!Array.isArray(keys)) return;
  for (const key of keys) touchHotIcon(key);
}

export function isTooSmallAppIconDataUrl(value: string) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return true;
  return s.length < 900;
}

function shouldPersistKey(key: string, value: string) {
  if (!key || !value) return false;
  if (value.length > ICON_STORE_MAX_VALUE_SIZE) return false;
  if (key.startsWith("app:")) return !isTooSmallAppIconDataUrl(value);
  if (key.startsWith("command:")) return true;
  if (key.startsWith("settings:")) return true;
  if (key.startsWith("folder:")) return true;
  if (key.startsWith("ext:")) return true;
  if (key.startsWith("file:")) return true;
  return false;
}

function buildPersistSnapshot() {
  const keys = getHotIconKeys(ICON_STORE_MAX_ITEMS);
  const items: Array<{ key: string; value: string; hitAt: number }> = [];
  for (const key of keys) {
    const value = iconDataCache.get(key) || "";
    if (!shouldPersistKey(key, value)) continue;
    items.push({ key, value, hitAt: Date.now() });
  }
  return {
    version: ICON_STORE_VERSION,
    updatedAt: Date.now(),
    items,
  };
}

async function flushIconStore() {
  if (!app.isReady()) return;
  if (!iconStorePersistPending) return;
  iconStorePersistPending = false;
  try {
    const storePath = getIconStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true }).catch(() => {});
    await fs.writeFile(storePath, JSON.stringify(buildPersistSnapshot()), "utf-8");
  } catch {}
}

function scheduleIconStorePersist() {
  if (!app.isReady()) return;
  iconStorePersistPending = true;
  if (iconStorePersistTimer) return;
  iconStorePersistTimer = setTimeout(() => {
    iconStorePersistTimer = null;
    void flushIconStore();
  }, 450);
}

function evictIfNeeded(nextKey: string) {
  if (iconDataCache.size < ICON_CACHE_MAX) return;
  if (iconDataCache.has(nextKey)) return;

  // 优先保留热点与 app 图标，先淘汰非热点文件图标。
  let evictKey = "";
  for (const key of iconDataCache.keys()) {
    if (hotIconLru.has(key)) continue;
    if (key.startsWith("app:")) continue;
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

export function getIconCache(key: string) {
  const normalized = normalizeKey(key);
  if (!normalized) return "";
  const value = iconDataCache.get(normalized) || "";
  if (!value) return "";
  if (iconDataCache.has(normalized)) {
    iconDataCache.delete(normalized);
    iconDataCache.set(normalized, value);
  }
  touchHotIcon(normalized);
  return value;
}

export function setIconCache(key: string, value: string) {
  const normalized = normalizeKey(key);
  if (!normalized) return;

  const normalizedValue = typeof value === "string" ? value.trim() : "";
  if (!normalizedValue) {
    if (!iconDataCache.has(normalized)) return;
    iconDataCache.delete(normalized);
    hotIconLru.delete(normalized);
    scheduleIconStorePersist();
    return;
  }

  if (normalized.startsWith("app:") && isTooSmallAppIconDataUrl(normalizedValue)) {
    iconDataCache.delete(normalized);
    return;
  }

  evictIfNeeded(normalized);
  if (iconDataCache.has(normalized)) iconDataCache.delete(normalized);
  iconDataCache.set(normalized, normalizedValue);
  touchHotIcon(normalized);
  scheduleIconStorePersist();
}

function restoreFromPayload(raw: any) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  for (const it of items) {
    const key = normalizeKey(it?.key);
    const value = typeof it?.value === "string" ? it.value.trim() : "";
    if (!key || !value) continue;
    if (!shouldPersistKey(key, value)) continue;
    iconDataCache.set(key, value);
    touchHotIcon(key);
  }
}

function migrateLegacyAppIconCache() {
  try {
    const legacyPath = getAppIconCachePath();
    if (!existsSync(legacyPath)) return;
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    for (const it of items) {
      const key = normalizeKey(it?.key);
      const value = typeof it?.value === "string" ? it.value.trim() : "";
      if (!key || !key.startsWith("app:")) continue;
      if (!value || isTooSmallAppIconDataUrl(value)) continue;
      iconDataCache.set(key, value);
      touchHotIcon(key);
    }
  } catch {}
}

export function restoreIconManifest() {
  if (iconStoreLoaded) return;
  iconStoreLoaded = true;
  if (!app.isReady()) return;
  try {
    const storePath = getIconStorePath();
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, "utf-8"));
      if (raw?.version === ICON_STORE_VERSION) {
        restoreFromPayload(raw);
      }
    }
  } catch {}
  migrateLegacyAppIconCache();
}

export function loadPersistedAppIconCache() {
  // 兼容旧调用：统一走新 IconStore 恢复。
  restoreIconManifest();
}

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
  } catch {}
}

export async function clearPersistedAppIconCache() {
  await clearPersistedIconStore();
}
