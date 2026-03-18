import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppIconCachePath } from '../constants/storagePaths';

export const iconDataCache = new Map<string, string>();
const ICON_CACHE_MAX = 1500;
const APP_ICON_PERSIST_VERSION = 1;
const APP_ICON_PERSIST_MAX_ITEMS = 600;
const APP_ICON_PERSIST_MAX_VALUE_SIZE = 140 * 1024;
let appIconCacheLoaded = false;
let appIconPersistTimer: ReturnType<typeof setTimeout> | null = null;
let appIconPersistPending = false;

export function isTooSmallAppIconDataUrl(value: string) {
	const s = typeof value === 'string' ? value.trim() : '';
	if (!s) return true;
	return s.length < 900;
}

function buildPersistSnapshot() {
	const items: Array<{ key: string; value: string }> = [];
	for (const [key, value] of iconDataCache.entries()) {
		if (!key.startsWith('app:')) continue;
		if (!value || value.length > APP_ICON_PERSIST_MAX_VALUE_SIZE) continue;
		items.push({ key, value });
	}
	const sliced = items.slice(-APP_ICON_PERSIST_MAX_ITEMS);
	return {
		version: APP_ICON_PERSIST_VERSION,
		updatedAt: Date.now(),
		items: sliced,
	};
}

async function flushPersistedAppIconCache() {
	if (!app.isReady()) return;
	if (!appIconPersistPending) return;
	appIconPersistPending = false;
	try {
		const cachePath = getAppIconCachePath();
		await fs.mkdir(path.dirname(cachePath), { recursive: true }).catch(() => {});
		await fs.writeFile(cachePath, JSON.stringify(buildPersistSnapshot()), 'utf-8');
	} catch {}
}

function schedulePersistedAppIconCache() {
	if (!app.isReady()) return;
	appIconPersistPending = true;
	if (appIconPersistTimer) return;
	// 合并短时间内的多次图标写入，减少落盘频率
	appIconPersistTimer = setTimeout(() => {
		appIconPersistTimer = null;
		void flushPersistedAppIconCache();
	}, 400);
}

export function loadPersistedAppIconCache() {
	if (appIconCacheLoaded) return;
	appIconCacheLoaded = true;
	if (!app.isReady()) return;
	try {
		const cachePath = getAppIconCachePath();
		if (!existsSync(cachePath)) return;
		const raw = JSON.parse(readFileSync(cachePath, 'utf-8'));
		if (raw?.version !== APP_ICON_PERSIST_VERSION) return;
		const items = Array.isArray(raw?.items) ? raw.items : [];
		for (const it of items) {
			const key = typeof it?.key === 'string' ? it.key : '';
			const value = typeof it?.value === 'string' ? it.value : '';
			if (!key || !key.startsWith('app:')) continue;
			if (!value || isTooSmallAppIconDataUrl(value)) continue;
			iconDataCache.set(key, value);
		}
	} catch {}
}

export async function clearPersistedAppIconCache() {
	if (appIconPersistTimer) {
		clearTimeout(appIconPersistTimer);
		appIconPersistTimer = null;
	}
	appIconPersistPending = false;
	if (!app.isReady()) return;
	try {
		await fs.rm(getAppIconCachePath(), { force: true });
	} catch {}
}

export function setIconCache(key: string, value: string) {
	if (!key) return;
	if (typeof value !== 'string' || !value) {
		if (iconDataCache.has(key)) {
			iconDataCache.delete(key);
			if (key.startsWith('app:')) schedulePersistedAppIconCache();
		}
		return;
	}
	if (key.startsWith('app:') && isTooSmallAppIconDataUrl(value)) {
		iconDataCache.delete(key);
		return;
	}
	if (iconDataCache.size >= ICON_CACHE_MAX && !iconDataCache.has(key)) {
		// 优先淘汰文件图标，尽量保留 app 图标命中率
		let evictKey = '';
		for (const k of iconDataCache.keys()) {
			if (!k.startsWith('app:')) {
				evictKey = k;
				break;
			}
		}
		if (!evictKey) {
			const firstKey = iconDataCache.keys().next().value;
			if (firstKey) evictKey = String(firstKey);
		}
		if (evictKey) iconDataCache.delete(evictKey);
	}
	// 更新同 key 时先删后设，保证 map 迭代顺序更贴近“最近使用”
	if (iconDataCache.has(key)) iconDataCache.delete(key);
	iconDataCache.set(key, value);
	if (key.startsWith('app:')) schedulePersistedAppIconCache();
}
