export const iconDataCache = new Map<string, string>();
const ICON_CACHE_MAX = 1500;

export function isTooSmallAppIconDataUrl(value: string) {
	const s = typeof value === 'string' ? value.trim() : '';
	if (!s) return true;
	return s.length < 900;
}

export function setIconCache(key: string, value: string) {
	if (!key) return;
	if (typeof value !== 'string' || !value) {
		const prev = iconDataCache.get(key) || '';
		if (!prev) iconDataCache.delete(key);
		return;
	}
	if (key.startsWith('app:') && isTooSmallAppIconDataUrl(value)) {
		iconDataCache.delete(key);
		return;
	}
	if (iconDataCache.size >= ICON_CACHE_MAX && !iconDataCache.has(key)) {
		const firstKey = iconDataCache.keys().next().value;
		if (firstKey) iconDataCache.delete(firstKey);
	}
	iconDataCache.set(key, value);
}

