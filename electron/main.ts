import { app, BrowserWindow, globalShortcut, ipcMain, shell, Tray, Menu, dialog, screen, nativeImage } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, statSync, watch, writeFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { FileIndex } from './fileIndex';

interface InstalledApp {
	Name: string;
	AppID: string;
}

interface AppSettings {
	autoStart: boolean;
	searchShortcut: string;
	settingsShortcut: string;
	theme: 'dark' | 'light';
	historyLimit: number;
	defaultSearchTypeId: string;
	customSearchTypes: string[];
	searchTypeOrder: string[];
	disabledSearchTypeIds: string[];
	ignoredPaths: string[];
	keepStateOnClose: boolean;
	showResultPath: boolean;
	enableHistory: boolean;
	accentColor: string;
	enableEffect: boolean;
	effectType: 'particles' | 'warp' | 'waves';
	backgroundImagePath: string;
	backgroundImageOpacity: number;
	resultActionButtons: ResultActionButtonId[];
}

type ResultActionButtonId = 'openFolder' | 'copyPath' | 'deleteHistory';

if (!app.isPackaged) {
	const baseUserData = app.getPath('userData');
	app.setPath('userData', path.join(baseUserData, 'dev'));
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'window-config.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const SETTINGS_WINDOW_CONFIG_PATH = path.join(app.getPath('userData'), 'settings-window-config.json');
const FILE_INDEX_PATH = path.join(app.getPath('userData'), 'file-index.txt');
const FILE_INDEX_META_PATH = path.join(app.getPath('userData'), 'file-index-meta.json');
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');
const HISTORY_STATS_PATH = path.join(app.getPath('userData'), 'history-stats.json');

const DEFAULT_SEARCH_SHORTCUT = 'Alt+T';
const DEFAULT_SETTINGS_SHORTCUT = 'Alt+Shift+T';
const DEFAULT_THEME: AppSettings['theme'] = 'dark';
const DEFAULT_HISTORY_LIMIT = 5;
const HOTKEY_COOLDOWN_MS = 300;
const DEFAULT_SEARCH_TYPE_ID = 'all';
const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ['openFolder', 'copyPath', 'deleteHistory'];
const WIN_CONTEXT_MENU_VERB_KEY = 'FileSearchAddToQuickList';
const WIN_CONTEXT_MENU_LABEL = '添加到FileSearch的快捷列表';

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let installedAppsCache: InstalledApp[] = [];
const fileIndex = new FileIndex({ cachePath: FILE_INDEX_PATH, maxEntries: 2_000_000 });
const userDirWatchers: Array<ReturnType<typeof watch>> = [];
// Windows 盘符根目录列表缓存：用于文件监听与索引重建，避免重复拉取 PowerShell 结果
let windowsFileSystemRootsCache: string[] = [];
// 最近变更索引：用于弥补 fs.watch 丢事件/全量索引未覆盖导致的“新建文件搜不到”
const RECENT_INDEX_MAX = 30_000;
const recentIndex = new Map<string, { path: string; name: string; isDirectory: boolean; timeMs: number }>();
let recentReconcileInFlight = false;
let recentReconcileLastAt = 0;
const startMenuShortcutIndex = new Map<string, string>();
const iconDataCache = new Map<string, string>();
const ICON_CACHE_MAX = 1500;

function setIconCache(key: string, value: string) {
	if (!key) return;
	if (iconDataCache.size >= ICON_CACHE_MAX && !iconDataCache.has(key)) {
		const firstKey = iconDataCache.keys().next().value;
		if (firstKey) iconDataCache.delete(firstKey);
	}
	iconDataCache.set(key, value);
}

function normalizeRecentKey(rawPath: string) {
	return typeof rawPath === 'string' ? rawPath.trim().toLowerCase() : '';
}

function upsertRecentIndex(fullPath: string, isDirectory: boolean, timeMs: number) {
	// 最近变更索引：只保存必要字段，优先保证“新建/刚改动”的内容可被搜索到
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

function buildStartMenuShortcutIndex() {
	if (process.platform !== 'win32') return;
	const roots = [
		process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
		process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
	].filter((p) => p && existsSync(p));

	const walk = (dir: string) => {
		let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as any;
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
				continue;
			}
			if (!ent.isFile()) continue;
			if (!ent.name.toLowerCase().endsWith('.lnk')) continue;
			const key = path.basename(ent.name, '.lnk').toLowerCase();
			if (!startMenuShortcutIndex.has(key)) startMenuShortcutIndex.set(key, full);
		}
	};

	for (const r of roots) walk(r);
}

function findStartMenuShortcutByName(name: string) {
	const n = (name || '').trim().toLowerCase();
	if (!n) return '';
	const exact = startMenuShortcutIndex.get(n);
	if (exact) return exact;
	for (const [k, v] of startMenuShortcutIndex.entries()) {
		if (k.includes(n) || n.includes(k)) return v;
	}
	return '';
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);

function normalizeIconFileSpec(spec: string) {
	const raw = (spec || '').trim();
	if (!raw) return '';
	const noQuotes = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
	const beforeComma = noQuotes.split(',')[0]?.trim() || '';
	return beforeComma;
}

async function getFileIconData(filePath: string) {
	const key = `file:${filePath}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string') return cached;
	let iconData = '';
	try {
		const ext = path.extname(filePath).toLowerCase();
		if ((ext === '.lnk' || ext === '.url') && existsSync(filePath)) {
			if (ext === '.lnk') {
				const info = await resolveLnkByPowerShell(filePath);
				const iconSpec = normalizeIconFileSpec(info?.iconLocation || '');
				const iconResolved = resolveAppId(iconSpec);
				if (iconResolved && existsSync(iconResolved)) {
					const icon = await app.getFileIcon(iconResolved, { size: 'large' });
					if (!icon.isEmpty()) iconData = icon.toDataURL();
				}
				if (!iconData) {
					const targetResolved = resolveAppId(info?.targetPath || '');
					const sameTarget =
						targetResolved && targetResolved.toLowerCase() === resolveAppId(filePath).toLowerCase();
					if (targetResolved && !sameTarget && existsSync(targetResolved)) {
						iconData = await getFileIconData(targetResolved);
					}
				}
			} else if (ext === '.url') {
				const iconFile = normalizeIconFileSpec(readUrlIconFile(filePath));
				const iconResolved = resolveAppId(iconFile);
				if (iconResolved && existsSync(iconResolved)) {
					iconData = await getFileIconData(iconResolved);
				}
			}
		}

		if (IMAGE_EXTENSIONS.has(ext) && existsSync(filePath)) {
			try {
				// 对于图片，尝试生成缩略图
				const img = nativeImage.createFromPath(filePath);
				if (!img.isEmpty()) {
					// 缩放图片以提高性能，宽度 64 像素足够预览使用
					iconData = img.resize({ width: 64, height: 64, quality: 'better' }).toDataURL();
				}
			} catch (err) {
				console.error('Failed to generate image thumbnail:', err);
			}
		}

		// 如果不是图片或者生成缩略图失败，使用系统图标
		if (!iconData) {
			const icon = await app.getFileIcon(filePath, { size: 'large' });
			if (!icon.isEmpty()) iconData = icon.toDataURL();
		}
	} catch {}
	setIconCache(key, iconData);
	return iconData;
}

async function getAppIconData(appName: string, appId: string) {
	const key = `app:${appId}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string') return cached;
	let iconData = '';
	try {
		const resolved = resolveAppId(appId);
		if ((resolved.includes('\\') || resolved.includes('/')) && existsSync(resolved)) {
			iconData = await getFileIconData(resolved);
		} else {
			const shortcut = findStartMenuShortcutByName(appName);
			if (shortcut && existsSync(shortcut)) iconData = await getFileIconData(shortcut);
		}
	} catch {}
	setIconCache(key, iconData);
	return iconData;
}

const FILE_INDEX_VERSION = 2;

function loadFileIndexMeta(): { version: number } | null {
	try {
		if (!existsSync(FILE_INDEX_META_PATH)) return null;
		const raw = JSON.parse(readFileSync(FILE_INDEX_META_PATH, 'utf-8'));
		if (typeof raw?.version !== 'number') return null;
		return { version: raw.version };
	} catch {
		return null;
	}
}

function saveFileIndexMeta(meta: { version: number }) {
	try {
		writeFileSync(FILE_INDEX_META_PATH, JSON.stringify(meta));
	} catch {}
}

function loadConfig() {
	try {
		if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
	} catch {}
	return null;
}

function saveConfig(bounds: Electron.Rectangle) {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify({ bounds }));
	} catch {}
}

function loadSettings(): AppSettings {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
			const theme = raw?.theme === 'light' ? 'light' : 'dark';
			const effectType = raw?.effectType === 'warp' ? 'warp' : raw?.effectType === 'waves' ? 'waves' : 'particles';
			const backgroundImagePath = typeof raw?.backgroundImagePath === 'string' ? raw.backgroundImagePath.trim() : '';
			const backgroundImageOpacityRaw = typeof raw?.backgroundImageOpacity === 'number' ? raw.backgroundImageOpacity : 0.25;
			const backgroundImageOpacity = Number.isFinite(backgroundImageOpacityRaw)
				? Math.min(1, Math.max(0, backgroundImageOpacityRaw))
				: 0.25;
			const legacyShortcut =
				typeof raw?.shortcut === 'string' && raw.shortcut.trim() ? raw.shortcut.trim() : undefined;
			const customSearchTypes: string[] = Array.isArray(raw?.customSearchTypes)
				? Array.from(
						new Set<string>(
							raw.customSearchTypes
								.map((x: any) => (typeof x === 'string' ? x.trim() : ''))
								.map((x: string) => x.toLowerCase())
								.filter((x: string) => /^\.[a-z0-9]{1,10}$/i.test(x))
						)
					)
				: [];

			const defaultSearchTypeIdRaw = typeof raw?.defaultSearchTypeId === 'string' ? raw.defaultSearchTypeId.trim() : '';
			const defaultSearchTypeId =
				defaultSearchTypeIdRaw === 'all' ||
				defaultSearchTypeIdRaw === 'file' ||
				defaultSearchTypeIdRaw === 'folder' ||
				defaultSearchTypeIdRaw === 'image' ||
				defaultSearchTypeIdRaw === 'video' ||
				defaultSearchTypeIdRaw === 'settings' ||
				(defaultSearchTypeIdRaw.startsWith('ext:') &&
					/^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
					customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
					? defaultSearchTypeIdRaw
					: DEFAULT_SEARCH_TYPE_ID;

			const baseTypeIds = ['all', 'file', 'folder', 'image', 'video', 'settings'];
			const customTypeIds = customSearchTypes.map((ext) => `ext:${ext}`);
			const allowedTypeIds = new Set<string>([...baseTypeIds, ...customTypeIds]);
			const rawOrder: string[] = Array.isArray(raw?.searchTypeOrder)
				? raw.searchTypeOrder
						.map((x: any) => (typeof x === 'string' ? x.trim() : ''))
						.filter((x: string) => x)
				: [];
			const searchTypeOrder: string[] = [];
			for (const id of rawOrder) {
				if (!allowedTypeIds.has(id)) continue;
				if (searchTypeOrder.includes(id)) continue;
				searchTypeOrder.push(id);
			}
			for (const id of [...baseTypeIds, ...customTypeIds]) {
				if (!searchTypeOrder.includes(id)) searchTypeOrder.push(id);
			}

			const rawDisabledTypeIds: string[] = Array.isArray(raw?.disabledSearchTypeIds)
				? raw.disabledSearchTypeIds.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
				: [];
			const disabledSearchTypeIds: string[] = [];
			const disabledSeen = new Set<string>();
			for (const id of rawDisabledTypeIds) {
				if (!allowedTypeIds.has(id)) continue;
				if (id === 'all') continue;
				if (disabledSeen.has(id)) continue;
				disabledSeen.add(id);
				disabledSearchTypeIds.push(id);
			}
			const safeDefaultSearchTypeId = disabledSearchTypeIds.includes(defaultSearchTypeId) ? 'all' : defaultSearchTypeId;

			// 结果右侧按钮配置：过滤非法值、去重并限制最多三项
			const allowedActionIds = new Set<ResultActionButtonId>(['openFolder', 'copyPath', 'deleteHistory']);
			const rawActionButtons: string[] = Array.isArray(raw?.resultActionButtons)
				? raw.resultActionButtons.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
				: [];
			const resultActionButtons: ResultActionButtonId[] = [];
			for (const id of rawActionButtons) {
				if (!allowedActionIds.has(id as ResultActionButtonId)) continue;
				if (resultActionButtons.includes(id as ResultActionButtonId)) continue;
				resultActionButtons.push(id as ResultActionButtonId);
				if (resultActionButtons.length >= 3) break;
			}
			if (resultActionButtons.length === 0) resultActionButtons.push(...DEFAULT_RESULT_ACTION_BUTTONS);

			const ignoredPathsRaw: string[] = Array.isArray(raw?.ignoredPaths)
				? raw.ignoredPaths.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
				: [];
			const ignoredPaths: string[] = [];
			const ignoredSeen = new Set<string>();
			for (const p of ignoredPathsRaw) {
				const norm = p.replace(/\//g, '\\').replace(/\\+/g, '\\').trim().replace(/[\\]+$/g, '').toLowerCase();
				if (!norm) continue;
				if (ignoredSeen.has(norm)) continue;
				ignoredSeen.add(norm);
				ignoredPaths.push(p);
			}

			return {
				autoStart: Boolean(raw?.autoStart),
				searchShortcut:
					typeof raw?.searchShortcut === 'string' && raw.searchShortcut.trim()
						? raw.searchShortcut.trim()
						: legacyShortcut || DEFAULT_SEARCH_SHORTCUT,
				settingsShortcut:
					typeof raw?.settingsShortcut === 'string' && raw.settingsShortcut.trim()
						? raw.settingsShortcut.trim()
						: DEFAULT_SETTINGS_SHORTCUT,
				theme,
				historyLimit:
					typeof raw?.historyLimit === 'number' && Number.isFinite(raw.historyLimit)
						? Math.min(50, Math.max(0, Math.floor(raw.historyLimit)))
						: DEFAULT_HISTORY_LIMIT,
				defaultSearchTypeId: safeDefaultSearchTypeId,
				customSearchTypes,
				searchTypeOrder,
				disabledSearchTypeIds,
				ignoredPaths,
				keepStateOnClose: Boolean(raw?.keepStateOnClose),
				showResultPath: Boolean(raw?.showResultPath),
				enableHistory: raw?.enableHistory !== false,
				accentColor: typeof raw?.accentColor === 'string' ? raw.accentColor : '#38bdf8',
				enableEffect: Boolean(raw?.enableEffect),
				effectType,
				backgroundImagePath,
				backgroundImageOpacity,
				resultActionButtons,
			};
		}
	} catch {}
	return {
		autoStart: false,
		searchShortcut: DEFAULT_SEARCH_SHORTCUT,
		settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
		theme: DEFAULT_THEME,
		historyLimit: DEFAULT_HISTORY_LIMIT,
		defaultSearchTypeId: DEFAULT_SEARCH_TYPE_ID,
		customSearchTypes: [],
		searchTypeOrder: ['all', 'file', 'folder', 'image', 'video', 'settings'],
		disabledSearchTypeIds: [],
		ignoredPaths: [],
		keepStateOnClose: false,
		showResultPath: false,
		enableHistory: true,
		accentColor: '#38bdf8',
		enableEffect: false,
		effectType: 'particles',
		backgroundImagePath: '',
		backgroundImageOpacity: 0.25,
		resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
	};
}

function saveSettings(settings: AppSettings) {
	try {
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
	} catch {}
}

type HistoryItem = { name: string; path: string; type: string; lastUsed: number };

type HistoryStats = {
	version: 1;
	byPath: Record<string, { count: number; lastUsed: number }>;
	byType: Record<string, number>;
	byExt: Record<string, number>;
};

function normalizeHistoryKey(rawPath: string) {
	return typeof rawPath === 'string' ? rawPath.trim().toLowerCase() : '';
}

function normalizeExtKey(rawPath: string) {
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

function loadHistoryStats(): HistoryStats {
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

function saveHistoryStats(stats: HistoryStats) {
	try {
		writeFileSync(HISTORY_STATS_PATH, JSON.stringify(stats));
	} catch {}
}

function updateHistoryStatsOnUse(item: { path: string; type?: string }, now: number) {
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

function loadHistory(): HistoryItem[] {
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

function saveHistory(items: HistoryItem[]) {
	try {
		writeFileSync(HISTORY_PATH, JSON.stringify(items));
	} catch {}
}

function addToQuickListFromPath(targetPath: string) {
	try {
		if (!targetPath || typeof targetPath !== 'string') return;
		const trimmed = targetPath.trim();
		if (!trimmed) return;
		const ext = path.extname(trimmed);
		const base = ext ? path.basename(trimmed, ext) : path.basename(trimmed);
		const name = base || path.basename(trimmed) || '快捷项';
		recordHistoryItem({ name, path: trimmed, type: 'file' });
		win?.webContents.send('reset-search');
	} catch {}
}

function handleAddToQuickListArgv(argv: string[]) {
	const idx = argv.indexOf('--add-to-quick-list');
	if (idx < 0) return false;
	const p = argv[idx + 1];
	if (!p) return true;
	addToQuickListFromPath(p);
	return true;
}

function regAddString(key: string, valueName: string | null, data: string) {
	return new Promise<void>((resolve) => {
		try {
			const args = ['add', key];
			if (valueName) args.push('/v', valueName);
			else args.push('/ve');
			args.push('/t', 'REG_SZ', '/d', data, '/f');
			const ps = spawn('reg', args, { windowsHide: true });
			ps.on('close', () => resolve());
			ps.on('error', () => resolve());
		} catch {
			resolve();
		}
	});
}

async function ensureWindowsAppContextMenu() {
	if (process.platform !== 'win32') return;
	if (!app.isPackaged) return;

	const exe = process.execPath;
	if (!exe) return;
	const command = `"${exe}" --add-to-quick-list "%1"`;

	const classes = ['lnkfile', 'exefile'];
	for (const cls of classes) {
		const baseKey = `HKCU\\Software\\Classes\\${cls}\\shell\\${WIN_CONTEXT_MENU_VERB_KEY}`;
		await regAddString(baseKey, null, WIN_CONTEXT_MENU_LABEL);
		await regAddString(baseKey, 'Icon', exe);
		await regAddString(`${baseKey}\\command`, null, command);
	}
}

function isExistingTarget(target: { path: string; type?: string }) {
	const p = target.path;
	if (!p) return false;
	if (target.type === 'app') return true;
	const resolved = resolveAppId(p);
	if (!resolved.includes('\\') && !resolved.includes('/')) return true;
	return existsSync(resolved);
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

function loadSettingsWindowConfig() {
	try {
		if (existsSync(SETTINGS_WINDOW_CONFIG_PATH)) return JSON.parse(readFileSync(SETTINGS_WINDOW_CONFIG_PATH, 'utf-8'));
	} catch {}
	return null;
}

function saveSettingsWindowConfig(bounds: Electron.Rectangle) {
	try {
		writeFileSync(SETTINGS_WINDOW_CONFIG_PATH, JSON.stringify({ bounds }));
	} catch {}
}

function loadInstalledApps() {
	const ps = spawn('powershell', [
		'-NoProfile',
		'-Command',
		'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress',
	]);
	let data = '';
	ps.stdout.on('data', (chunk) => (data += chunk.toString()));
	ps.on('close', (code) => {
		if (code !== 0) return;
		try {
			const apps = JSON.parse(data);
			installedAppsCache = Array.isArray(apps) ? apps : [apps];
		} catch {}
	});
}

function resolveAppId(appId: string): string {
	if (!appId) return '';
	const guidMap: Record<string, string> = {
		'{6D809377-6AF0-444B-8957-A3773F02200E}': process.env.ProgramFiles || 'C:\\Program Files',
		'{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
		'{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': process.env.SystemRoot
			? path.join(process.env.SystemRoot, 'System32')
			: 'C:\\Windows\\System32',
	};

	let resolved = appId;
	for (const [guid, pathVal] of Object.entries(guidMap)) {
		if (resolved.includes(guid)) resolved = resolved.replace(guid, pathVal);
	}
	return resolved;
}

async function openResolvedTarget(resolved: string) {
	if (!resolved) return false;
	if (resolved.includes('\\') || resolved.includes('/')) {
		const msg = await shell.openPath(resolved);
		return !msg;
	}
	await shell.openExternal(`shell:AppsFolder\\${resolved}`);
	return true;
}

function readUrlShortcut(filePath: string) {
	try {
		const raw = readFileSync(filePath, 'utf-8');
		const m = raw.match(/^\s*URL\s*=\s*(.+)\s*$/im);
		const url = m?.[1]?.trim();
		return url || '';
	} catch {
		return '';
	}
}

function readUrlIconFile(filePath: string) {
	try {
		const raw = readFileSync(filePath, 'utf-8');
		const m = raw.match(/^\s*IconFile\s*=\s*(.+)\s*$/im);
		const iconFile = m?.[1]?.trim();
		return iconFile || '';
	} catch {
		return '';
	}
}

function resolveLnkByPowerShell(lnkPath: string) {
	return new Promise<{ targetPath: string; arguments: string; workingDirectory: string; iconLocation: string } | null>((resolve) => {
		try {
			const escaped = lnkPath.replace(/'/g, "''");
			const cmd =
				`$w=New-Object -ComObject WScript.Shell;` +
				`$s=$w.CreateShortcut('${escaped}');` +
				`$o=@{targetPath=$s.TargetPath;arguments=$s.Arguments;workingDirectory=$s.WorkingDirectory;iconLocation=$s.IconLocation};` +
				`$o|ConvertTo-Json -Compress`;
			const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
			let out = '';
			ps.stdout.on('data', (c) => (out += c.toString()));
			ps.on('close', () => {
				try {
					const obj = JSON.parse(out || 'null');
					if (!obj || typeof obj !== 'object') return resolve(null);
					resolve({
						targetPath: typeof obj.targetPath === 'string' ? obj.targetPath : '',
						arguments: typeof obj.arguments === 'string' ? obj.arguments : '',
						workingDirectory: typeof obj.workingDirectory === 'string' ? obj.workingDirectory : '',
						iconLocation: typeof obj.iconLocation === 'string' ? obj.iconLocation : '',
					});
				} catch {
					resolve(null);
				}
			});
			ps.on('error', () => resolve(null));
		} catch {
			resolve(null);
		}
	});
}

async function openLnkShortcut(lnkPath: string) {
	const info = await resolveLnkByPowerShell(lnkPath);
	if (!info?.targetPath) return false;
	return await new Promise<boolean>((resolve) => {
		try {
			const fp = info.targetPath.replace(/'/g, "''");
			const al = (info.arguments || '').replace(/'/g, "''");
			const wd = (info.workingDirectory || '').replace(/'/g, "''");
			const cmd =
				`$fp='${fp}';` +
				`$al='${al}';` +
				`$wd='${wd}';` +
				`try { ` +
				`if ($wd) { Start-Process -FilePath $fp -ArgumentList $al -WorkingDirectory $wd -ErrorAction Stop } ` +
				`else { Start-Process -FilePath $fp -ArgumentList $al -ErrorAction Stop } ` +
				`} catch { exit 1 }`;
			const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
			ps.on('close', (code) => resolve(code === 0));
			ps.on('error', () => resolve(false));
		} catch {
			resolve(false);
		}
	});
}

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
let ignoreSearchBlurUntil = 0;
let searchHideTimer: NodeJS.Timeout | null = null;
let searchWasFocusedSinceShow = false;
let settingsReadyToShow = false;
let settingsShowFallbackTimer: NodeJS.Timeout | null = null;
let searchAllowBlurHide = false;
let searchVisibleAt = 0;

function isRectVisibleOnAnyDisplay(rect: Electron.Rectangle) {
	const displays = screen.getAllDisplays();
	return displays.some((d) => {
		const wa = d.workArea;
		const xOverlap = rect.x < wa.x + wa.width && rect.x + rect.width > wa.x;
		const yOverlap = rect.y < wa.y + wa.height && rect.y + rect.height > wa.y;
		return xOverlap && yOverlap;
	});
}

function createWindow() {
	const config = loadConfig();
	const bounds = config?.bounds;
	const width = 720;
	const height = 76;

	const useBounds =
		bounds &&
		typeof bounds.x === 'number' &&
		typeof bounds.y === 'number' &&
		isRectVisibleOnAnyDisplay({ x: bounds.x, y: bounds.y, width, height });

	win = new BrowserWindow({
		width,
		height,
		x: useBounds ? bounds.x : undefined,
		y: useBounds ? bounds.y : undefined,
		show: false,
		frame: false,
		transparent: false,
		backgroundColor: '#0f172a',
		roundedCorners: true,
		hasShadow: true,
		skipTaskbar: true,
		resizable: false,
		maximizable: false,
		minimizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		icon: path.join(process.env.VITE_PUBLIC || '', 'tray.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	if (!app.isPackaged) {
		// 开发环境快捷键：F12 打开/关闭 DevTools，避免影响生产环境
		win.webContents.on('before-input-event', (event, input) => {
			if (input.type !== 'keyDown') return;
			if (input.key !== 'F12') return;
			const w = win;
			if (!w || w.isDestroyed()) return;
			if (w.webContents.isDevToolsOpened()) w.webContents.closeDevTools();
			else w.webContents.openDevTools({ mode: 'detach' });
			event.preventDefault();
		});
	}

	win.on('moved', () => {
		if (win) saveConfig(win.getBounds());
	});
	win.on('closed', () => {
		win = null;
	});

	win.on('focus', () => {
		searchWasFocusedSinceShow = true;
		if (searchHideTimer) {
			clearTimeout(searchHideTimer);
			searchHideTimer = null;
		}
	});

	// FLAG 点击空白处（窗口失去焦点）时隐藏
	win.on('blur', () => {
		if (!searchAllowBlurHide) return;
		if (Date.now() < ignoreSearchBlurUntil) return;
		if (Date.now() - searchVisibleAt < 500) return;
		if (!searchWasFocusedSinceShow) return;
		if (searchHideTimer) clearTimeout(searchHideTimer);
		searchHideTimer = setTimeout(() => {
			searchHideTimer = null;
			if (!win || win.isDestroyed()) return;
			if (win.webContents.isDevToolsOpened()) return;
			if (win.isFocused()) return;
			if (win.isVisible()) {
				try {
					win.webContents.send('search-window-hidden');
				} catch {}
				win.hide();
			}
		}, 140);
	});

	win.removeMenu();
	if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL);
	else win.loadFile(path.join(process.env.DIST || '', 'index.html'));

	if (!useBounds) win.center();
}

function createSettingsWindow() {
	const config = loadSettingsWindowConfig();
	const bounds = config?.bounds;
	const width = 680;
	const height = 520;

	settingsReadyToShow = false;
	settingsWin = new BrowserWindow({
		width,
		height,
		x: typeof bounds?.x === 'number' ? bounds.x : undefined,
		y: typeof bounds?.y === 'number' ? bounds.y : undefined,
		show: false,
		frame: false,
		transparent: false,
		backgroundColor: '#0f172a',
		roundedCorners: true,
		hasShadow: true,
		skipTaskbar: false,
		resizable: true,
		minWidth: 560,
		minHeight: 520,
		maximizable: true,
		minimizable: true, 
		icon: path.join(process.env.VITE_PUBLIC || '', 'tray.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	if (!app.isPackaged) {
		// 开发环境快捷键：F12 打开/关闭 DevTools，避免影响生产环境
		settingsWin.webContents.on('before-input-event', (event, input) => {
			if (input.type !== 'keyDown') return;
			if (input.key !== 'F12') return;
			const w = settingsWin;
			if (!w || w.isDestroyed()) return;
			if (w.webContents.isDevToolsOpened()) w.webContents.closeDevTools();
			else w.webContents.openDevTools({ mode: 'detach' });
			event.preventDefault();
		});
	}

	settingsWin.on('moved', () => {
		if (settingsWin) saveSettingsWindowConfig(settingsWin.getBounds());
	});
	settingsWin.on('resize', () => {
		if (settingsWin) saveSettingsWindowConfig(settingsWin.getBounds());
	});
	settingsWin.on('closed', () => {
		if (settingsShowFallbackTimer) {
			clearTimeout(settingsShowFallbackTimer);
			settingsShowFallbackTimer = null;
		}
		settingsWin = null;
	});

	settingsWin.once('ready-to-show', () => {
		if (!settingsWin || settingsWin.isDestroyed()) return;
		if (settingsShowFallbackTimer) clearTimeout(settingsShowFallbackTimer);
		settingsShowFallbackTimer = setTimeout(() => {
			if (!settingsWin || settingsWin.isDestroyed()) return;
			if (settingsReadyToShow) return;
			settingsReadyToShow = true;
			settingsWin.show();
			settingsWin.focus();
			settingsWin.webContents.send('settings-window-opened');
		}, 1200);
	});

	settingsWin.removeMenu();
	if (VITE_DEV_SERVER_URL) {
		const u = new URL(VITE_DEV_SERVER_URL);
		u.searchParams.set('view', 'settings');
		settingsWin.loadURL(u.toString());
	} else {
		settingsWin.loadFile(path.join(process.env.DIST || '', 'index.html'), { query: { view: 'settings' } });
	}
}

async function getWindowsFileSystemRoots(): Promise<string[]> {
	return new Promise((resolve) => {
		try {
			const ps = spawn('powershell', [
				'-NoProfile',
				'-Command',
				'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root',
			]);
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

function shouldSkipWatchPath(fullPath: string) {
	if (fileIndex.isIgnoredPath(fullPath)) return true;
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

async function startUserDirectoryWatchers() {
	if (process.platform === 'win32' && (!windowsFileSystemRootsCache || windowsFileSystemRootsCache.length === 0)) {
		try {
			windowsFileSystemRootsCache = await getWindowsFileSystemRoots();
		} catch {}
	}
	const roots = (() => {
		// 监听新增/改动文件：Windows 下递归监听盘符根目录可能失败或丢事件，这里额外监听用户目录与常用目录兜底
		if (process.platform === 'win32') {
			const home = app.getPath('home');
			const desktop = app.getPath('desktop');
			const documents = app.getPath('documents');
			const downloads = app.getPath('downloads');
			return [...windowsFileSystemRootsCache, home, desktop, documents, downloads]
				.filter((p): p is string => typeof p === 'string' && Boolean(p.trim()))
				.map((p) => (p.endsWith('\\') ? p : `${p}\\`));
		}
		return [app.getPath('home')].filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
	})();
	const uniqueRoots = Array.from(new Set(roots));

	for (const root of uniqueRoots) {
		if (!root || typeof root !== 'string') continue;
		if (!existsSync(root)) continue;
		try {
			const w = watch(root, { recursive: true }, (_eventType, filename) => {
				if (!filename) return;
				const raw = filename.toString();
				const fullPath = path.isAbsolute(raw) ? raw : path.join(root, raw);
				if (shouldSkipWatchPath(fullPath)) return;
				setTimeout(() => {
					try {
						if (!existsSync(fullPath)) {
							// 删除事件不保证可靠：这里至少从最近变更索引里清理，避免结果残留
							recentIndex.delete(normalizeRecentKey(fullPath));
							return;
						}
						const st = statSync(fullPath);
						const isDir = st.isDirectory();
						const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
						upsertRecentIndex(fullPath, isDir, timeMs);
						fileIndex.ingestPath(fullPath, isDir);
					} catch {}
				}, 80);
			});
			userDirWatchers.push(w);
		} catch {}
	}
}

async function reconcileRecentIndex(budgetMs = 1200) {
	// 兜底扫描：当 fs.watch 丢事件或全量索引未覆盖时，尽量把“最近新增/改动”的文件补进 recentIndex
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
						const st = statSync(fullPath);
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

function openSearchWindow() {
	const settings = loadSettings();
	if (win && !win.isDestroyed()) {
		if (win.isVisible()) {
			win.focus();
			return;
		}

		fileIndex.setSearchWindowVisible(true);
		searchWasFocusedSinceShow = false;
		searchAllowBlurHide = false;
		if (searchHideTimer) {
			clearTimeout(searchHideTimer);
			searchHideTimer = null;
		}
		ignoreSearchBlurUntil = Date.now() + 900;
		win.show();
		win.focus();
		void reconcileRecentIndex();
		searchVisibleAt = Date.now();
		setTimeout(() => {
			if (win && !win.isDestroyed() && win.isVisible()) win.focus();
		}, 80);
		if (settings.keepStateOnClose) win.webContents.send('search-window-opened');
		else win.webContents.send('reset-search');
		return;
	}
	win = null;
	createWindow();
	fileIndex.setSearchWindowVisible(true);
	setTimeout(() => {
		if (!win || win.isDestroyed()) return;
		if (settings.keepStateOnClose) win.webContents.send('search-window-opened');
		else win.webContents.send('reset-search');
	}, 60);
}

function toggleSearchWindow() {
	if (win && !win.isDestroyed()) {
		if (win.isVisible()) {
			try {
				win.webContents.send('search-window-hidden');
			} catch {}
			fileIndex.setSearchWindowVisible(false);
			win.hide();
		}
		else openSearchWindow();
		return;
	}
	openSearchWindow();
}

function hideSearchWindow() {
	try {
		if (!win || win.isDestroyed()) return;
		if (!win.isVisible()) return;
		try {
			win.webContents.send('search-window-hidden');
		} catch {}
		fileIndex.setSearchWindowVisible(false);
		win.hide();
	} catch {}
}

function showSettingsWindow() {
	hideSearchWindow();
	if (settingsWin && !settingsWin.isDestroyed()) {
		if (!settingsWin.isVisible()) {
			if (settingsReadyToShow) settingsWin.show();
			else return;
		}
		settingsWin.focus();
		settingsWin.webContents.send('settings-window-opened');
		return;
	}
	settingsWin = null;
	createSettingsWindow();
}

ipcMain.handle('search-view-ready', () => {
	searchAllowBlurHide = true;
	// Do not reduce the protection time set by openSearchWindow
	// ignoreSearchBlurUntil = Date.now() + 120; 
});

ipcMain.handle('settings-view-ready', (event) => {
	try {
		const w = BrowserWindow.fromWebContents(event.sender);
		if (!w) return { ok: false };
		if (settingsWin && w.id !== settingsWin.id) return { ok: false };
		if (settingsShowFallbackTimer) {
			clearTimeout(settingsShowFallbackTimer);
			settingsShowFallbackTimer = null;
		}
		settingsReadyToShow = true;
		if (!w.isVisible()) w.show();
		w.focus();
		w.webContents.send('settings-window-opened');
		return { ok: true };
	} catch {
		return { ok: false };
	}
});

ipcMain.handle('login-request', async (_event, { url, options }) => {
	try {
		const response = await fetch(url, options);
		const data = await response.json();
		return {
			ok: response.ok,
			status: response.status,
			statusText: response.statusText,
			data
		};
	} catch (error: any) {
		return {
			ok: false,
			status: 500,
			statusText: error.message,
			data: null
		};
	}
});

async function addQuickItemFromDialog() {
	try {
		const result = await dialog.showOpenDialog({
			title: '添加到 File Search 快捷列表',
			buttonLabel: '添加',
			properties: ['openFile'],
			filters: [{ name: '应用/快捷方式', extensions: ['exe', 'lnk', 'url'] }],
		});
		if (result.canceled) return;
		const targetPath = result.filePaths?.[0];
		if (!targetPath) return;

		const ext = path.extname(targetPath).toLowerCase();
		const name = path.basename(targetPath, ext) || path.basename(targetPath) || '快捷项';
		recordHistoryItem({ name, path: targetPath, type: 'file' });
		win?.webContents.send('reset-search');
	} catch {}
}

function ensureTray() {
	try {
		const iconPath = path.join(process.env.VITE_PUBLIC || '', 'tray.png');
		tray = new Tray(iconPath);
		const contextMenu = Menu.buildFromTemplate([
			{
				label: '显示搜索框',
				click: () => toggleSearchWindow(),
			},
			{
				label: '新增文件到FileSearch的快捷列表',
				click: () => void addQuickItemFromDialog(),
			},
			{
				label: '设置',
				click: () => showSettingsWindow(),
			},
			{ type: 'separator' },
			{ label: '退出', click: () => app.quit() },
		]);
		tray.setToolTip('File Search');
		tray.setContextMenu(contextMenu);
		tray.on('click', () => {
			toggleSearchWindow();
		});
	} catch {}
}

function registerShortcuts() {
	globalShortcut.unregisterAll();
	const settings = loadSettings();

	let lastSearchAt = 0;
	let lastSettingsAt = 0;

	const okSearch = globalShortcut.register(settings.searchShortcut, () => {
		const now = Date.now();
		if (now - lastSearchAt < HOTKEY_COOLDOWN_MS) return;
		lastSearchAt = now;
		openSearchWindow();
	});

	const okSettings = globalShortcut.register(settings.settingsShortcut, () => {
		const now = Date.now();
		if (now - lastSettingsAt < HOTKEY_COOLDOWN_MS) return;
		lastSettingsAt = now;
		showSettingsWindow();
	});

	if (!okSearch) dialog.showErrorBox('快捷键注册失败', `无法注册呼出搜索框快捷键：${settings.searchShortcut}`);
	if (!okSettings) dialog.showErrorBox('快捷键注册失败', `无法注册呼出设置界面快捷键：${settings.settingsShortcut}`);
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
		win = null;
	}
});

app.on('activate', () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
	app.quit();
} else {
	app.on('second-instance', (_event, argv) => {
		if (Array.isArray(argv) && handleAddToQuickListArgv(argv)) return;
		openSearchWindow();
	});

	app.whenReady().then(async () => {
		const initialSettings = loadSettings();
		fileIndex.setIgnoredPaths(initialSettings.ignoredPaths);
		loadInstalledApps();
		await fileIndex.loadCache();
		const meta = loadFileIndexMeta();
		if (!meta || meta.version !== FILE_INDEX_VERSION) {
			void (async () => {
				try {
					await fileIndex.rebuild();
					saveFileIndexMeta({ version: FILE_INDEX_VERSION });
				} catch {}
			})();
		}
		buildStartMenuShortcutIndex();

		createWindow();
		void ensureWindowsAppContextMenu();
		try {
			handleAddToQuickListArgv(process.argv);
		} catch {}
		void startUserDirectoryWatchers();
		ensureTray();
		app.setLoginItemSettings({ openAtLogin: initialSettings.autoStart, openAsHidden: true, path: app.getPath('exe') });
		registerShortcuts();

		void fileIndex.buildIfEmpty();
	});
}

app.on('will-quit', () => {
	globalShortcut.unregisterAll();
	for (const w of userDirWatchers) {
		try {
			w.close();
		} catch {}
	}
});

ipcMain.handle('hide-window', (event) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	if (!w) return;
	try {
		w.webContents.send('search-window-hidden');
	} catch {}
	fileIndex.setSearchWindowVisible(false);
	w.hide();
});

ipcMain.handle('minimize-window', (event) => {
	BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle('resize-window', (event, height: number, width?: number) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	if (!w) return;
	const [currentWidth] = w.getContentSize();
	const nextWidth = width ?? currentWidth;
	
	// 如果宽度发生变化，且是从左侧拖拽（需要保持右侧不动），或者只是普通调整
	// 这里我们简单处理：如果是从 React 传来的 width，我们直接 setSize
	// 如果要实现左侧拖拽不位移，需要在 React 端计算好偏移并调用 setBounds
	w.setContentSize(Math.round(nextWidth), Math.round(height));
});

ipcMain.handle('get-window-bounds', (event) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	return w?.getBounds();
});

ipcMain.handle('set-window-bounds', (event, bounds: Partial<Electron.Rectangle>) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	if (!w) return;
	const current = w.getBounds();
	w.setBounds({
		x: bounds.x ?? current.x,
		y: bounds.y ?? current.y,
		width: bounds.width ?? current.width,
		height: bounds.height ?? current.height
	});
});

ipcMain.handle('open-settings-window', () => {
	showSettingsWindow();
});

ipcMain.handle('toggle-maximize', (event) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	if (!w) return { maximized: false };
	if (w.isMaximized()) w.unmaximize();
	else w.maximize();
	return { maximized: w.isMaximized() };
});

ipcMain.handle('get-settings', () => {
	return loadSettings();
});

ipcMain.handle('select-background-image', async () => {
	try {
		const result = await dialog.showOpenDialog({
			title: '选择背景图片',
			buttonLabel: '选择',
			properties: ['openFile'],
			filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
		});
		if (result.canceled) return { ok: true, path: '' };
		const targetPath = result.filePaths?.[0] || '';
		return { ok: true, path: targetPath };
	} catch (e: any) {
		return { ok: false, message: e?.message || '选择图片失败', path: '' };
	}
});

ipcMain.handle('get-image-data-url', (_event, targetPath: string) => {
	try {
		if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, dataUrl: '' };
		const resolved = resolveAppId(targetPath.trim());
		if (!existsSync(resolved)) return { ok: false, dataUrl: '' };

		const st = statSync(resolved);
		const maxBytes = 20 * 1024 * 1024;
		if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return { ok: false, dataUrl: '' };

		const ext = path.extname(resolved).toLowerCase();
		const mime =
			ext === '.png'
				? 'image/png'
				: ext === '.jpg' || ext === '.jpeg'
					? 'image/jpeg'
					: ext === '.webp'
						? 'image/webp'
						: ext === '.gif'
							? 'image/gif'
							: ext === '.bmp'
								? 'image/bmp'
								: '';
		if (!mime) return { ok: false, dataUrl: '' };

		const buf = readFileSync(resolved);
		const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
		return { ok: true, dataUrl };
	} catch {
		return { ok: false, dataUrl: '' };
	}
});

ipcMain.handle('save-settings', (_event, settings: AppSettings) => {
	const prevIgnoredPaths = loadSettings().ignoredPaths;
	const customSearchTypes: string[] = Array.isArray(settings?.customSearchTypes)
		? Array.from(
				new Set<string>(
					settings.customSearchTypes
						.map((x: any) => (typeof x === 'string' ? x.trim() : ''))
						.map((x: string) => x.toLowerCase())
						.filter((x: string) => /^\.[a-z0-9]{1,10}$/i.test(x))
				)
			)
		: [];

	const defaultSearchTypeIdRaw =
		typeof settings?.defaultSearchTypeId === 'string' ? settings.defaultSearchTypeId.trim() : DEFAULT_SEARCH_TYPE_ID;
	const defaultSearchTypeId =
		defaultSearchTypeIdRaw === 'all' ||
		defaultSearchTypeIdRaw === 'file' ||
		defaultSearchTypeIdRaw === 'folder' ||
		defaultSearchTypeIdRaw === 'image' ||
		defaultSearchTypeIdRaw === 'video' ||
		defaultSearchTypeIdRaw === 'settings' ||
		(defaultSearchTypeIdRaw.startsWith('ext:') &&
			/^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
			customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
			? defaultSearchTypeIdRaw
			: DEFAULT_SEARCH_TYPE_ID;

	const baseTypeIds = ['all', 'file', 'folder', 'image', 'video', 'settings'];
	const customTypeIds = customSearchTypes.map((ext) => `ext:${ext}`);
	const allowedTypeIds = new Set<string>([...baseTypeIds, ...customTypeIds]);
	const rawDisabledTypeIds: string[] = Array.isArray(settings?.disabledSearchTypeIds)
		? settings.disabledSearchTypeIds.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
		: [];
	const disabledSearchTypeIds: string[] = [];
	const disabledSeen = new Set<string>();
	for (const id of rawDisabledTypeIds) {
		if (!allowedTypeIds.has(id)) continue;
		if (id === 'all') continue;
		if (disabledSeen.has(id)) continue;
		disabledSeen.add(id);
		disabledSearchTypeIds.push(id);
	}
	const safeDefaultSearchTypeId = disabledSearchTypeIds.includes(defaultSearchTypeId) ? 'all' : defaultSearchTypeId;
	const rawOrder: string[] = Array.isArray(settings?.searchTypeOrder)
		? settings.searchTypeOrder
				.map((x: any) => (typeof x === 'string' ? x.trim() : ''))
				.filter((x: string) => x)
		: [];
	const searchTypeOrder: string[] = [];
	for (const id of rawOrder) {
		if (!allowedTypeIds.has(id)) continue;
		if (searchTypeOrder.includes(id)) continue;
		searchTypeOrder.push(id);
	}
	for (const id of [...baseTypeIds, ...customTypeIds]) {
		if (!searchTypeOrder.includes(id)) searchTypeOrder.push(id);
	}

	const effectType = settings?.effectType === 'warp' ? 'warp' : settings?.effectType === 'waves' ? 'waves' : 'particles';
	const backgroundImagePath = typeof settings?.backgroundImagePath === 'string' ? settings.backgroundImagePath.trim() : '';
	const backgroundImageOpacityRaw = typeof settings?.backgroundImageOpacity === 'number' ? settings.backgroundImageOpacity : 0.25;
	const backgroundImageOpacity = Number.isFinite(backgroundImageOpacityRaw)
		? Math.min(1, Math.max(0, backgroundImageOpacityRaw))
		: 0.25;

	const ignoredPathsRaw: string[] = Array.isArray(settings?.ignoredPaths)
		? settings.ignoredPaths.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
		: [];
	const ignoredPaths: string[] = [];
	const ignoredSeen = new Set<string>();
	for (const p of ignoredPathsRaw) {
		const norm = p.replace(/\//g, '\\').replace(/\\+/g, '\\').trim().replace(/[\\]+$/g, '').toLowerCase();
		if (!norm) continue;
		if (ignoredSeen.has(norm)) continue;
		ignoredSeen.add(norm);
		ignoredPaths.push(p);
	}

	const allowedActionIds = new Set<ResultActionButtonId>(['openFolder', 'copyPath', 'deleteHistory']);
	const rawActionButtons: string[] = Array.isArray(settings?.resultActionButtons)
		? settings.resultActionButtons.map((x: any) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
		: [];
	const resultActionButtons: ResultActionButtonId[] = [];
	for (const id of rawActionButtons) {
		if (!allowedActionIds.has(id as ResultActionButtonId)) continue;
		if (resultActionButtons.includes(id as ResultActionButtonId)) continue;
		resultActionButtons.push(id as ResultActionButtonId);
		if (resultActionButtons.length >= 3) break;
	}
	if (resultActionButtons.length === 0) resultActionButtons.push(...DEFAULT_RESULT_ACTION_BUTTONS);

	const next: AppSettings = {
		autoStart: Boolean(settings?.autoStart),
		searchShortcut:
			typeof settings?.searchShortcut === 'string' && settings.searchShortcut.trim()
				? settings.searchShortcut.trim()
				: DEFAULT_SEARCH_SHORTCUT,
		settingsShortcut:
			typeof settings?.settingsShortcut === 'string' && settings.settingsShortcut.trim()
				? settings.settingsShortcut.trim()
				: DEFAULT_SETTINGS_SHORTCUT,
		theme: settings?.theme === 'light' ? 'light' : 'dark',
		historyLimit:
			typeof settings?.historyLimit === 'number' && Number.isFinite(settings.historyLimit)
				? Math.min(50, Math.max(0, Math.floor(settings.historyLimit)))
				: DEFAULT_HISTORY_LIMIT,
		defaultSearchTypeId: safeDefaultSearchTypeId,
		customSearchTypes,
		searchTypeOrder,
		disabledSearchTypeIds,
		ignoredPaths,
		keepStateOnClose: Boolean(settings?.keepStateOnClose),
		showResultPath: Boolean(settings?.showResultPath),
		enableHistory: settings?.enableHistory !== false,
		accentColor: typeof settings?.accentColor === 'string' ? settings.accentColor : '#38bdf8',
		enableEffect: Boolean(settings?.enableEffect),
		effectType,
		backgroundImagePath,
		backgroundImageOpacity,
		resultActionButtons,
	};

	if (next.searchShortcut === next.settingsShortcut) return { ok: false, message: '两个快捷键不能相同' };

	globalShortcut.unregisterAll();
	const okSearch = globalShortcut.register(next.searchShortcut, () => openSearchWindow());
	const okSettings = globalShortcut.register(next.settingsShortcut, () => showSettingsWindow());
	globalShortcut.unregisterAll();

	if (!okSearch) {
		registerShortcuts();
		return { ok: false, message: '呼出搜索框快捷键已被占用' };
	}
	if (!okSettings) {
		registerShortcuts();
		return { ok: false, message: '呼出设置界面快捷键已被占用' };
	}

	app.setLoginItemSettings({
		openAtLogin: next.autoStart,
		openAsHidden: true,
		path: app.getPath('exe'),
	});
	fileIndex.setIgnoredPaths(next.ignoredPaths);
	saveSettings(next);
	// historyLimit 变化时裁剪历史
	const history = loadHistory();
	saveHistory(next.historyLimit > 0 ? history.filter((h) => isExistingTarget(h)).slice(0, next.historyLimit) : []);
	registerShortcuts();
	win?.webContents.send('settings-updated', next);
	settingsWin?.webContents.send('settings-updated', next);

	const normalizeIgnoreForCompare = (arr: string[]) =>
		(Array.isArray(arr) ? arr : [])
			.map((p) => (typeof p === 'string' ? p.replace(/\//g, '\\').replace(/\\+/g, '\\').trim().replace(/[\\]+$/g, '').toLowerCase() : ''))
			.filter(Boolean)
			.sort();
	const prevNorm = normalizeIgnoreForCompare(prevIgnoredPaths);
	const nextNorm = normalizeIgnoreForCompare(next.ignoredPaths);
	if (prevNorm.join('|') !== nextNorm.join('|')) {
		void fileIndex.rebuild();
	}
	return { ok: true };
});

ipcMain.handle('get-history', async () => {
	const settings = loadSettings();
	const history = settings.historyLimit > 0 ? loadHistory().filter((h) => isExistingTarget(h)).slice(0, settings.historyLimit) : [];

	const results = await Promise.all(
		history.map(async (h) => {
			try {
				if (h.type === 'app') {
					const iconData = await getAppIconData(h.name, h.path);
					return { name: h.name, path: h.path, type: h.type, icon: iconData };
				}
				const resolved = resolveAppId(h.path);
				const lower = resolved.toLowerCase();
				if (lower.endsWith('.lnk')) {
					const info = await resolveLnkByPowerShell(resolved);
					const targetResolved = resolveAppId(info?.targetPath || '');
					if (targetResolved && existsSync(targetResolved)) {
						const iconData = await getFileIconData(targetResolved);
						return { name: h.name, path: h.path, type: h.type, icon: iconData };
					}
				}
				if (lower.endsWith('.url')) {
					const iconFile = readUrlIconFile(resolved);
					const iconResolved = resolveAppId(iconFile);
					if (iconResolved && existsSync(iconResolved)) {
						const iconData = await getFileIconData(iconResolved);
						return { name: h.name, path: h.path, type: h.type, icon: iconData };
					}
				}
				if (existsSync(resolved)) {
					const iconData = await getFileIconData(resolved);
					return { name: h.name, path: h.path, type: h.type, icon: iconData };
				}
			} catch {}
			return { name: h.name, path: h.path, type: h.type, icon: '' };
		})
	);

	return { results };
});

ipcMain.handle('clear-history', () => {
	saveHistory([]);
	win?.webContents.send('reset-search');
	settingsWin?.webContents.send('reset-search');
	return { ok: true };
});

ipcMain.handle('delete-history-item', (_event, targetPath: string) => {
	if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false };
	const trimmed = targetPath.trim();
	const history = loadHistory();
	const next = history.filter((h) => h.path !== trimmed);
	saveHistory(next);
	win?.webContents.send('reset-search');
	settingsWin?.webContents.send('reset-search');
	return { ok: true };
});

ipcMain.handle('open-item', async (event, item: { name: string; path: string; type?: string }) => {
	try {
		if (item?.type === 'settings' && typeof item?.path === 'string' && item.path.startsWith('ms-settings:')) {
			await shell.openExternal(item.path);
			if (item?.name && item?.path) recordHistoryItem(item);
			BrowserWindow.fromWebContents(event.sender)?.hide();
			return true;
		}
		const resolved = resolveAppId(item?.path);
		let ok = await openResolvedTarget(resolved);
		if (!ok) {
			const lower = resolved.toLowerCase();
			if (lower.endsWith('.url')) {
				const url = readUrlShortcut(resolved);
				if (url) {
					await shell.openExternal(url);
					ok = true;
				}
			} else if (lower.endsWith('.lnk')) {
				ok = await openLnkShortcut(resolved);
			}
		}
		if (ok) {
			if (item?.name && item?.path) recordHistoryItem(item);
			BrowserWindow.fromWebContents(event.sender)?.hide();
		}
		return ok;
	} catch {
		return false;
	}
});

ipcMain.handle('open-app', async (event, target: string) => {
	try {
		const resolved = resolveAppId(target);
		const ok = await openResolvedTarget(resolved);
		if (ok) BrowserWindow.fromWebContents(event.sender)?.hide();
		return ok;
	} catch {
		return false;
	}
});

ipcMain.handle('open-folder', async (event, filePath: string) => {
	try {
		const resolved = resolveAppId(filePath);
		if (resolved.includes('\\') || resolved.includes('/')) {
			shell.showItemInFolder(resolved);
		} else {
			// For AppIDs, just open the apps folder
			await shell.openExternal(`shell:AppsFolder`);
		}
		BrowserWindow.fromWebContents(event.sender)?.hide();
		return true;
	} catch {
		return false;
	}
});

ipcMain.handle('open-external', async (_event, url: string) => {
	if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
		await shell.openExternal(url);
	}
});

ipcMain.handle('rebuild-file-index', async () => {
	await fileIndex.rebuild();
	return fileIndex.getStatus();
});

ipcMain.handle(
	'search-files',
	async (event, query: string, options?: { searchTypeId?: string; searchSessionId?: string }) => {
	if (!query || query.trim().length < 2) return { results: [], isIndexing: fileIndex.getStatus().isIndexing };
	fileIndex.pauseIndexingFor(900);
	// 搜索时顺带触发一次轻量兜底扫描：提高新建/改动文件被检索到的概率（不阻塞当前请求）
	void reconcileRecentIndex();

	const lowerQuery = query.trim().toLowerCase();
	const queryParts = lowerQuery.split(/\s+/).filter(Boolean);
	const aliases: Record<string, string[]> = {
		wechat: ['wechat', 'weixin', '微信'],
		微信: ['wechat', 'weixin', '微信'],
		google: ['google', 'chrome'],
		chrome: ['google', 'chrome'],
		edge: ['edge', 'microsoft edge'],
	};
	const keywords = aliases[lowerQuery] || [lowerQuery];

	const searchTypeId = typeof options?.searchTypeId === 'string' ? options.searchTypeId : 'all';
	// 搜索会话 ID：用于将后台分批推送的 more-results 与当前搜索绑定，避免切换类型后出现重复项/数量不一致
	const searchSessionId =
		typeof options?.searchSessionId === 'string' && options.searchSessionId.trim()
			? options.searchSessionId.trim()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const extFilter = searchTypeId.startsWith('ext:') ? searchTypeId.slice(4).toLowerCase() : '';
	// 综合排序权重：①名称匹配度 > ④访问频次 > ③常用类型 > ②时间（新建/改动更近）
	const now = Date.now();
	const historyStats = loadHistoryStats();
	const getAccessBoost = (rawPath: string) => {
		const key = normalizeHistoryKey(rawPath);
		if (!key) return 0;
		const it = historyStats.byPath[key];
		if (!it) return 0;
		const count = typeof it.count === 'number' && it.count > 0 ? it.count : 0;
		const lastUsed = typeof it.lastUsed === 'number' && it.lastUsed > 0 ? it.lastUsed : 0;
		const countBoost = Math.min(18_000, count * 1_600);
		const ageDays = lastUsed ? (now - lastUsed) / 86_400_000 : 9999;
		const recBoost = ageDays <= 30 ? Math.round(7_000 * (1 - ageDays / 30)) : 0;
		return countBoost + recBoost;
	};
	const getTypeBoost = (type: string, rawPath: string) => {
		// “常用类型”优先：文件用扩展名统计；非文件用类型统计（folder/settings/app）
		if (type === 'file') {
			const ext = normalizeExtKey(rawPath);
			if (!ext) return 0;
			const cnt = typeof historyStats.byExt[ext] === 'number' ? historyStats.byExt[ext] : 0;
			return Math.min(7_000, cnt * 260);
		}
		const cnt = typeof historyStats.byType[type] === 'number' ? historyStats.byType[type] : 0;
		return Math.min(5_000, cnt * 180);
	};
	const getTimeBoost = (timeMs: number) => {
		// 时间权重最低：只在相近匹配下做“更近时间更靠前”的微调
		if (!timeMs || !Number.isFinite(timeMs)) return 0;
		const ageDays = (now - timeMs) / 86_400_000;
		if (ageDays <= 0) return 1_200;
		if (ageDays <= 7) return Math.round(1_200 * (1 - ageDays / 7));
		if (ageDays <= 30) return Math.round(350 * (1 - ageDays / 30));
		return 0;
	};
	const computeCombinedScore = (baseScore: number, type: string, rawPath: string, timeMs: number) => {
		return baseScore + getAccessBoost(rawPath) + getTypeBoost(type, rawPath) + getTimeBoost(timeMs);
	};

	const normalizeForMatchName = (name: string) => name.replace(/\.(exe|lnk)$/i, '').toLowerCase();
	const fuzzySubsequenceScore = (target: string, q: string) => {
		let t = 0;
		let i = 0;
		let score = 0;
		let streak = 0;
		while (t < target.length && i < q.length) {
			if (target[t] === q[i]) {
				streak += 1;
				score += 3 + Math.min(streak, 10);
				i += 1;
			} else {
				streak = 0;
			}
			t += 1;
		}
		return i === q.length ? score : -1;
	};
	const scoreRecentName = (name: string) => {
		const base = normalizeForMatchName(name);
		if (!base) return 0;
		if (queryParts.length > 0 && !queryParts.every((p) => base.includes(p))) return 0;
		let score = 0;
		score += queryParts.length * 500;
		if (base === lowerQuery) score += 2000;
		if (base.startsWith(lowerQuery)) score += 1200;
		if (base.includes(lowerQuery)) score += 900;
		const subseq = fuzzySubsequenceScore(base, lowerQuery);
		if (subseq > 0) score += subseq;
		return score;
	};
	const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);
	const videoExts = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v']);
	const settingsItems =
		process.platform === 'win32'
			? [
					{ name: '系统设置', uri: 'ms-settings:' },
					{ name: '网络和 Internet', uri: 'ms-settings:network' },
					{ name: 'Wi‑Fi', uri: 'ms-settings:network-wifi' },
					{ name: '以太网', uri: 'ms-settings:network-ethernet' },
					{ name: 'VPN', uri: 'ms-settings:network-vpn' },
					{ name: '代理', uri: 'ms-settings:network-proxy' },
					{ name: '蓝牙和设备', uri: 'ms-settings:bluetooth' },
					{ name: '显示', uri: 'ms-settings:display' },
					{ name: '夜间模式', uri: 'ms-settings:nightlight' },
					{ name: '声音', uri: 'ms-settings:sound' },
					{ name: '通知', uri: 'ms-settings:notifications' },
					{ name: '电源和电池', uri: 'ms-settings:batterysaver' },
					{ name: '存储', uri: 'ms-settings:storagesense' },
					{ name: '应用', uri: 'ms-settings:appsfeatures' },
					{ name: '默认应用', uri: 'ms-settings:defaultapps' },
					{ name: '启动', uri: 'ms-settings:startupapps' },
					{ name: '时间和语言', uri: 'ms-settings:dateandtime' },
					{ name: '语言', uri: 'ms-settings:regionlanguage' },
					{ name: '键盘', uri: 'ms-settings:keyboard' },
					{ name: '鼠标', uri: 'ms-settings:mousetouchpad' },
					{ name: '个性化', uri: 'ms-settings:personalization' },
					{ name: '任务栏', uri: 'ms-settings:taskbar' },
					{ name: '主题', uri: 'ms-settings:themes' },
					{ name: '账户', uri: 'ms-settings:yourinfo' },
					{ name: '登录选项', uri: 'ms-settings:signinoptions' },
					{ name: 'Windows 更新', uri: 'ms-settings:windowsupdate' },
					{ name: '隐私和安全', uri: 'ms-settings:privacy' },
					{ name: '开发者选项', uri: 'ms-settings:developers' },
					{ name: '关于', uri: 'ms-settings:about' },
			  ]
			: [];

	if (searchTypeId === 'settings') {
		const out: Array<{ name: string; path: string; type: string; score: number }> = [];
		for (const it of settingsItems) {
			const nameLower = it.name.toLowerCase();
			if (!keywords.some((k) => nameLower.includes(k))) continue;
			const baseScore = nameLower.startsWith(lowerQuery) ? 50_000 : 30_000;
			const score = computeCombinedScore(baseScore, 'settings', it.uri, now);
			out.push({ name: it.name, path: it.uri, type: 'settings', score });
		}
		const merged = out
			.sort((a, b) => (b.score || 0) - (a.score || 0))
			.slice(0, 100)
			.map(({ score, ...rest }) => rest);
		return { results: merged, isIndexing: false, hasMore: false, searchSessionId, totalCount: out.length };
	}
	const settingsResults =
		searchTypeId === 'all'
			? (() => {
					const out: Array<{ name: string; path: string; type: string; score: number }> = [];
					for (const it of settingsItems) {
						const nameLower = it.name.toLowerCase();
						if (!keywords.some((k) => nameLower.includes(k))) continue;
						const baseScore = nameLower.startsWith(lowerQuery) ? 50_000 : 30_000;
						const score = computeCombinedScore(baseScore, 'settings', it.uri, now);
						out.push({ name: it.name, path: it.uri, type: 'settings', score });
					}
					return out;
			  })()
			: [];

	const appResults = await (async () => {
		// 如果指定了搜索类型且不是 'all' 或 'file'，则不显示应用结果
		if (searchTypeId !== 'all' && searchTypeId !== 'file') return [];
		
		const results: Array<{ name: string; path: string; type: string; icon?: string; score: number }> = [];
		for (const appItem of installedAppsCache) {
			const nameLower = appItem.Name.toLowerCase();
			if (!keywords.some((k) => nameLower.includes(k))) continue;

			const iconData = await getAppIconData(appItem.Name, appItem.AppID);

			results.push({
				name: appItem.Name,
				path: appItem.AppID,
				type: 'app',
				icon: iconData,
				score: computeCombinedScore(10_000, 'app', appItem.AppID, now),
			});
		}
		return results;
	})();

	// 文件索引搜索的候选上限：当用户指定“文件夹/图片/视频/扩展名”等更窄的类型时，提高候选数量，
	// 避免同名文件过多导致目录/特定类型结果在 topN 之外被截断，从而出现“所有类型能搜到，但对应类型搜不到”
	const fileSearchLimit = searchTypeId === 'all' || searchTypeId === 'file' ? 500 : 5000;
	const fileSearch = fileIndex.search(query, fileSearchLimit);
	const totalCount =
		searchTypeId === 'all'
			? settingsResults.length + appResults.length + fileSearch.totalCount
			: searchTypeId === 'file'
				? appResults.length + fileSearch.totalCount
				: fileSearch.totalCount;

	// 目录标识需要可靠：索引缓存可能导致 isDirectory 丢失，从而出现“文件夹搜不到、反而在文件里出现”的错位
	// 这里通过 statSync 兜底校验，并顺便获取时间信息用于综合排序
	const safeStat = (p: string) => {
		try {
			return statSync(p);
		} catch {
			return null;
		}
	};

	// 预过滤文件，避免为不需要的文件提取图标
	const filteredFiles: Array<{ path: string; name: string; isDirectory: boolean; score: number }> = [];
	for (const r of fileSearch.results) {
		if (fileIndex.isIgnoredPath(r.path)) continue;
		const st = safeStat(r.path);
		if (!st) continue;
		const isDirectory = st.isDirectory();
		const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);

		if (searchTypeId === 'file') {
			// “文件”类型：不包含文件夹，也不包含图片/视频（它们归属到“图片/视频”类型，且仍可在“所有类型”中搜到）
			if (isDirectory) continue;
			const ext = path.extname(r.path).toLowerCase();
			if (imageExts.has(ext)) continue;
			if (videoExts.has(ext)) continue;
		}

		if (searchTypeId === 'folder') {
			// “文件夹”类型：只包含文件夹
			if (!isDirectory) continue;
		}

		if (searchTypeId === 'image') {
			if (isDirectory) continue;
			if (!imageExts.has(path.extname(r.path).toLowerCase())) continue;
		}

		if (searchTypeId === 'video') {
			if (isDirectory) continue;
			if (!videoExts.has(path.extname(r.path).toLowerCase())) continue;
		}

		if (extFilter) {
			// 自定义扩展类型：只包含对应扩展名的文件
			if (isDirectory) continue;
			if (path.extname(r.path).toLowerCase() !== extFilter) continue;
		}

		const type = isDirectory ? 'folder' : 'file';
		const score = computeCombinedScore(r.score, type, r.path, timeMs);
		filteredFiles.push({ path: r.path, name: r.name, isDirectory, score });
	}

	const appendRecentMatches = () => {
		const seen = new Set(filteredFiles.map((x) => normalizeRecentKey(x.path)));
		const items = Array.from(recentIndex.values());
		const start = Math.max(0, items.length - 6000);
		for (let i = start; i < items.length; i++) {
			const it = items[i];
			if (!it?.path) continue;
			const key = normalizeRecentKey(it.path);
			if (!key) continue;
			if (seen.has(key)) continue;
			if (fileIndex.isIgnoredPath(it.path)) continue;

			const st = safeStat(it.path);
			if (!st) {
				recentIndex.delete(key);
				continue;
			}

			const isDirectory = st.isDirectory();
			const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);

			const baseScore = scoreRecentName(it.name);
			if (baseScore <= 0) continue;

			if (searchTypeId === 'file') {
				if (isDirectory) continue;
				const ext = path.extname(it.path).toLowerCase();
				if (imageExts.has(ext)) continue;
				if (videoExts.has(ext)) continue;
			}
			if (searchTypeId === 'folder') {
				if (!isDirectory) continue;
			}
			if (searchTypeId === 'image') {
				if (isDirectory) continue;
				if (!imageExts.has(path.extname(it.path).toLowerCase())) continue;
			}
			if (searchTypeId === 'video') {
				if (isDirectory) continue;
				if (!videoExts.has(path.extname(it.path).toLowerCase())) continue;
			}
			if (extFilter) {
				if (isDirectory) continue;
				if (path.extname(it.path).toLowerCase() !== extFilter) continue;
			}

			const type = isDirectory ? 'folder' : 'file';
			const score = computeCombinedScore(baseScore, type, it.path, timeMs);
			filteredFiles.push({ path: it.path, name: it.name, isDirectory, score });
			seen.add(key);
		}
	};

	appendRecentMatches();
	if (filteredFiles.length < 30) {
		await reconcileRecentIndex(220);
		appendRecentMatches();
	}

	const scanUserRootsForNameMatches = async (budgetMs: number) => {
		// 兜底：当索引/监听都漏掉时，对用户常用目录做一次“按名称”小范围扫描，尽量补齐可检索性
		const roots = (() => {
			if (process.platform === 'win32') {
				const home = app.getPath('home');
				const desktop = app.getPath('desktop');
				const documents = app.getPath('documents');
				const downloads = app.getPath('downloads');
				return [desktop, documents, downloads, home].filter(
					(p): p is string => typeof p === 'string' && Boolean(p.trim())
				);
			}
			const home = app.getPath('home');
			return [home].filter((p): p is string => typeof p === 'string' && Boolean(p.trim()));
		})();
		if (roots.length === 0) return;

		const startAt = Date.now();
		const MAX_DEPTH = 7;
		const MAX_VISIT = 45_000;
		let visited = 0;
		const queue: Array<{ dir: string; depth: number }> = roots.map((d) => ({ dir: d, depth: 0 }));
		const seen = new Set(filteredFiles.map((x) => normalizeRecentKey(x.path)));

		while (queue.length > 0) {
			if (Date.now() - startAt > Math.max(80, budgetMs)) break;
			if (visited >= MAX_VISIT) break;
			const cur = queue.shift();
			if (!cur) break;
			const dir = cur.dir;
			const depth = cur.depth;
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
					if (visited % 400 === 0) {
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
					}
					if (Date.now() - startAt > Math.max(80, budgetMs)) break;
					if (!ent?.name) continue;

					const fullPath = path.join(dir, ent.name);
					if (shouldSkipWatchPath(fullPath)) continue;

					const baseScore = scoreRecentName(ent.name);
					const likelyMatch = baseScore > 0;

					// 优先把“名称命中”的目录继续向下扫，以更快找到同名/相近命名的子目录
					if (ent.isDirectory && typeof ent.isDirectory === 'function' && ent.isDirectory()) {
						if (depth < MAX_DEPTH && (likelyMatch || depth < 2)) {
							queue.push({ dir: fullPath, depth: depth + 1 });
						}
					}
					if (!likelyMatch) continue;

					const key = normalizeRecentKey(fullPath);
					if (!key) continue;
					if (seen.has(key)) continue;
					if (fileIndex.isIgnoredPath(fullPath)) continue;

					const st = safeStat(fullPath);
					if (!st) continue;
					const isDirectory = st.isDirectory();
					const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);

					// 将兜底扫描到的条目写入“最近变更索引”与主索引，后续检索更稳定
					upsertRecentIndex(fullPath, isDirectory, timeMs);
					fileIndex.ingestPath(fullPath, isDirectory);

					if (searchTypeId === 'file') {
						if (isDirectory) continue;
						const ext = path.extname(fullPath).toLowerCase();
						if (imageExts.has(ext)) continue;
						if (videoExts.has(ext)) continue;
					}
					if (searchTypeId === 'folder') {
						if (!isDirectory) continue;
					}
					if (searchTypeId === 'image') {
						if (isDirectory) continue;
						if (!imageExts.has(path.extname(fullPath).toLowerCase())) continue;
					}
					if (searchTypeId === 'video') {
						if (isDirectory) continue;
						if (!videoExts.has(path.extname(fullPath).toLowerCase())) continue;
					}
					if (extFilter) {
						if (isDirectory) continue;
						if (path.extname(fullPath).toLowerCase() !== extFilter) continue;
					}

					const type = isDirectory ? 'folder' : 'file';
					const score = computeCombinedScore(baseScore, type, fullPath, timeMs);
					filteredFiles.push({ path: fullPath, name: ent.name, isDirectory, score });
					seen.add(key);
				}
			} finally {
				try {
					await dh.close();
				} catch {}
			}
		}
	};

	// 当结果过少时启用兜底扫描，优先保障用户目录内的新建/小众文件可被检索到
	if (filteredFiles.length === 0 || (filteredFiles.length < 8 && (searchTypeId === 'all' || searchTypeId === 'folder'))) {
		await scanUserRootsForNameMatches(900);
	}

	// 应用综合权重后的排序：保证“匹配度/访问频次/常用类型/时间”共同影响最终展示顺序
	filteredFiles.sort((a, b) => (b.score || 0) - (a.score || 0));

	const DISPLAY_LIMIT = 500;
	// 当命中数量过多时仅展示最匹配的前 500：避免渲染/图标提取过重导致卡顿
	const limitedFiles = filteredFiles.slice(0, DISPLAY_LIMIT);

	// 取前 100 个立即返回（提高初始展示数量）
	const first100Files = limitedFiles.slice(0, 100);
	const remainingFiles = limitedFiles.slice(100); // 后续结果通过后台发送（最多补齐到 500）

	const first100Results = (await Promise.all(
		first100Files.map(async (r) => {
			const iconData = await getFileIconData(r.path);
			return {
				name: r.name,
				path: r.path,
				type: r.isDirectory ? 'folder' : 'file',
				icon: iconData,
				score: r.score,
			};
		})
	)).filter((x): x is { name: string; path: string; type: string; icon: string; score: number } => x !== null);

	let combined = [...settingsResults, ...appResults, ...first100Results];
	const merged = combined
		.sort((a, b) => (b.score || 0) - (a.score || 0))
		.slice(0, 100) // 初始返回 100 条
		.map(({ score, ...rest }) => rest);

	// 如果有更多结果，在后台继续搜索并发送
	if (remainingFiles.length > 0) {
		(async () => {
			// 分批处理图标提取，避免一次性 Promise.all 太多导致卡顿
			const batchSize = 50;
			for (let i = 0; i < remainingFiles.length; i += batchSize) {
				const batch = remainingFiles.slice(i, i + batchSize);
				const backgroundResults = (await Promise.all(
					batch.map(async (r) => {
						if (!existsSync(r.path)) return null;
						const iconData = await getFileIconData(r.path);
						return {
							name: r.name,
							path: r.path,
							type: r.isDirectory ? 'folder' : 'file',
							icon: iconData,
							score: r.score,
						};
					})
				)).filter((x): x is { name: string; path: string; type: string; icon: string; score: number } => x !== null);

				if (backgroundResults.length > 0) {
					event.sender.send('more-results', {
						query,
						searchTypeId,
						searchSessionId,
						results: backgroundResults,
					});
				}
				// 给一点喘息时间
				await new Promise(resolve => setTimeout(resolve, 50));
			}
		})();
	}

	return { 
		results: merged, 
		isIndexing: fileSearch.isIndexing,
		hasMore: remainingFiles.length > 0,
		searchSessionId,
		totalCount,
	};
	}
);
