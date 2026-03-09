import { app, BrowserWindow, globalShortcut, ipcMain, shell, Tray, dialog, screen } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { hasChineseChar, toPinyinFull, toPinyinInitials } from './pinyin';
import { resolveAppId } from './win/resolveAppId';
import { openLnkShortcut, readUrlShortcut } from './win/shortcuts';
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from './win/startMenuShortcutIndex';
import { iconDataCache, isTooSmallAppIconDataUrl } from './icon/iconCache';
import { clearIconCaches, getAppIconDataStable, getFileIconData, getHistoryIconForPath } from './icon/iconService';
import { ensureTray, getDefaultTrayIconPath } from './app/tray';
import { registerShortcuts as registerGlobalShortcuts } from './app/shortcuts';
import { handleSearchFiles } from './search/searchFilesHandler';

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
	// 自定义头像：本地图片路径；渲染侧通过 get-image-data-url 转为可展示的 dataUrl
	customAvatarPath: string;
	resultActionButtons: ResultActionButtonId[];
}

type ResultActionButtonId = 'openFolder' | 'copyPath' | 'deleteHistory' | 'runAsAdmin';

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
const INSTALLED_APPS_CACHE_PATH = path.join(app.getPath('userData'), 'installed-apps.json');
const DEVICE_ID_PATH = path.join(app.getPath('userData'), 'device-id.json');
const INSTALLED_APPS_CACHE_VERSION = 1;

const DEFAULT_SEARCH_SHORTCUT = 'Alt+T';
const DEFAULT_SETTINGS_SHORTCUT = 'Alt+Shift+T';
const DEFAULT_THEME: AppSettings['theme'] = 'dark';
const DEFAULT_HISTORY_LIMIT = 5;
const DEFAULT_SEARCH_TYPE_ID = 'all';
const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ['openFolder', 'copyPath', 'deleteHistory'];
const WIN_CONTEXT_MENU_VERB_KEY = 'FileSearchAddToQuickList';
const WIN_CONTEXT_MENU_LABEL = '添加到FileSearch的快捷列表';

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

function isIgnoredPathByCache(targetPath: string) {
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

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let installedAppsCache: InstalledApp[] = [];
const fileIndex = createFileIndexWorkerClient({ cachePath: FILE_INDEX_PATH, maxEntries: 2_000_000 });
// 运行期可能插拔U盘，watcher 需要按 root 动态增删
const userDirWatchers = new Map<string, ReturnType<typeof watch>>();
// Windows 盘符根目录列表缓存：用于文件监听与索引重建，避免重复拉取 PowerShell 结果
let windowsFileSystemRootsCache: string[] = [];
// 图标预取 token：每次新搜索自增，旧的异步图标任务会自动中止
let iconPrefetchToken = 0;
// 最近变更索引：用于弥补 fs.watch 丢事件/全量索引未覆盖导致的“新建文件搜不到”
const RECENT_INDEX_MAX = 30_000;
const recentIndex = new Map<string, { path: string; name: string; isDirectory: boolean; timeMs: number }>();
let recentReconcileInFlight = false;
let recentReconcileLastAt = 0;
 

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

let appShortcutRootsCache: string[] | null = null;
function getAppShortcutRoots() {
	if (appShortcutRootsCache) return appShortcutRootsCache;
	const roots = [
		process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
		process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
		app.getPath('desktop'),
		process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '',
	].filter((p) => p && existsSync(p));
	appShortcutRootsCache = roots
		.map((p) => p.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase())
		.map((p) => `${p}\\`);
	return appShortcutRootsCache;
}

function isLikelyAppShortcutFile(filePath: string) {
	if (!filePath) return false;
	const p = filePath.replace(/\//g, '\\').toLowerCase();
	const ext = path.extname(p);
	if (ext !== '.lnk' && ext !== '.url') return false;
	const roots = getAppShortcutRoots();
	return roots.some((r) => p.startsWith(r));
}

function normalizeAppGroupKey(name: string) {
	// 将“主应用/卸载/升级/服务/修复”等条目归为同一组：用于把周边应用一起展示出来
	// 例如：搜索“QQ音乐”时，也能补齐“卸载 QQ音乐”“QQ音乐升级服务”等关联项
	const raw = typeof name === 'string' ? name.trim().toLowerCase() : '';
	if (!raw) return '';
	let s = raw;
	s = s.replace(/（.*?）|\(.*?\)|【.*?】|\[.*?\]/g, ' ');
	s = s.replace(/\s+/g, ' ').trim();
	s = s.replace(/^(卸载|uninstall)\s+/g, '');
	s = s.replace(/\s+(卸载|uninstall)$/g, '');
	s = s.replace(
		/(升级|更新|update|updater|upgrade|installer|setup|repair|service|服务|助手|helper|daemon|后台|background)\b/g,
		' '
	);
	s = s.replace(/\s+/g, ' ').trim();
	return s;
}

const FILE_INDEX_VERSION = 5;

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
			// 自定义头像：本地图片路径（由渲染侧通过 get-image-data-url 转成可展示的 dataUrl）
			const customAvatarPath = typeof raw?.customAvatarPath === 'string' ? raw.customAvatarPath.trim() : '';
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
				defaultSearchTypeIdRaw === 'app' ||
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

			const baseTypeIds = ['all', 'app', 'file', 'folder', 'image', 'video', 'settings'];
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
			const allowedActionIds = new Set<ResultActionButtonId>(['openFolder', 'copyPath', 'deleteHistory', 'runAsAdmin']);
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
				customAvatarPath,
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
		searchTypeOrder: ['all', 'app', 'file', 'folder', 'image', 'video', 'settings'],
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
		customAvatarPath: '',
		resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
	};
}

function saveSettings(settings: AppSettings) {
	try {
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
	} catch {}
}

async function clearLocalCacheButKeepAccountAndSettings() {
	// 清理“缓存与索引”，但保留：登录账户（渲染进程 localStorage）与设置/窗口布局（settings.json/window-config.json）
	// 目标：用户执行 clear:cache 后，下次呼出面板会自动重建索引，并且不会丢失登录态与配置
	try {
		recentIndex.clear();
		await clearIconCaches();
		// 索引复位放到 Worker 线程执行：避免主线程残留状态影响后续重建
		await fileIndex.reset();

		await fs.rm(FILE_INDEX_PATH, { force: true }).catch(() => {});
		await fs.rm(`${FILE_INDEX_PATH}.tmp`, { force: true }).catch(() => {});
		await fs.rm(FILE_INDEX_META_PATH, { force: true }).catch(() => {});
		await fs.rm(HISTORY_PATH, { force: true }).catch(() => {});
		await fs.rm(HISTORY_STATS_PATH, { force: true }).catch(() => {});
		await fs.rm(INSTALLED_APPS_CACHE_PATH, { force: true }).catch(() => {});

		try {
			win?.webContents.send('reset-search');
			settingsWin?.webContents.send('reset-search');
		} catch {}
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
	// 启动速度优先：应用列表先从本地缓存读出可用数据，随后在后台刷新（Get-StartApps + 注册表）并落盘
	// 同时异步初始化开始菜单快捷方式索引：用于图标与“打开目录”兜底，不作为应用列表来源
	setTimeout(() => void ensureStartMenuShortcutIndex(), 0);

	const readCache = () => {
		try {
			if (!existsSync(INSTALLED_APPS_CACHE_PATH)) return;
			const raw = JSON.parse(readFileSync(INSTALLED_APPS_CACHE_PATH, 'utf-8'));
			if (raw?.version !== INSTALLED_APPS_CACHE_VERSION) return;
			const list = Array.isArray(raw?.items) ? raw.items : [];
			const merged = new Map<string, InstalledApp>();
			for (const it of list) {
				const name = typeof (it as any)?.Name === 'string' ? (it as any).Name.trim() : '';
				const appId = typeof (it as any)?.AppID === 'string' ? (it as any).AppID.trim() : '';
				if (!name || !appId) continue;
				merged.set(appId.toLowerCase(), { Name: name, AppID: appId });
			}
			if (merged.size > 0) installedAppsCache = Array.from(merged.values());
		} catch {}
	};

	const normalizeExeSpec = (raw: string) => {
		const s = typeof raw === 'string' ? raw.trim() : '';
		if (!s) return '';
		const noQuotes = s.startsWith('"') && s.includes('"') ? s.replace(/^"+|"+$/g, '') : s;
		const beforeComma = noQuotes.split(',')[0]?.trim() || '';
		const lower = beforeComma.toLowerCase();
		const exeIdx = lower.indexOf('.exe');
		if (exeIdx >= 0) return beforeComma.slice(0, exeIdx + 4);
		return beforeComma;
	};

	const saveCache = (items: InstalledApp[]) => {
		try {
			const stable = items
				.slice()
				.filter((x) => x && typeof x.Name === 'string' && typeof x.AppID === 'string')
				.map((x) => ({ Name: x.Name.trim(), AppID: x.AppID.trim() }))
				.filter((x) => x.Name && x.AppID);
			stable.sort((a, b) => a.AppID.toLowerCase().localeCompare(b.AppID.toLowerCase()));
			writeFileSync(
				INSTALLED_APPS_CACHE_PATH,
				JSON.stringify({ version: INSTALLED_APPS_CACHE_VERSION, updatedAt: Date.now(), items: stable })
			);
		} catch {}
	};

	readCache();

	// Get-StartApps + 注册表合并：放到后台延后执行，避免与冷启动/首搜抢资源
	setTimeout(() => {
		const ps = spawn('powershell', [
			'-NoProfile',
			'-NoLogo',
			'-Command',
			[
			"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
			"$items=@();",
			"try {",
			"  $sa=Get-StartApps | Select-Object Name, AppID;",
			"  foreach($x in $sa){ if($x.Name -and $x.AppID){ $items += [pscustomobject]@{Name=[string]$x.Name;AppID=[string]$x.AppID} } }",
			"} catch {}",
			"$roots=@(",
			"  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',",
			"  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',",
			"  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths'",
			");",
			"foreach($r in $roots){",
			"  try {",
			"    if(Test-Path $r){",
			"      Get-ChildItem -LiteralPath $r | ForEach-Object {",
			"        $k=$_; $n=[string]$k.PSChildName; $def='';",
			"        try { $def=(Get-Item -LiteralPath $k.PSPath).GetValue('') } catch {}",
			"        if(-not $def){ try { $def=(Get-ItemProperty -LiteralPath $k.PSPath).Path } catch {} }",
			"        if($def){ $items += [pscustomobject]@{Name=($n -replace '\\.exe$','');AppID=[string]$def} }",
			"      }",
			"    }",
			"  } catch {}",
			"}",
			"$unroots=@(",
			"  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
			"  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
			"  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
			");",
			"foreach($r in $unroots){",
			"  try {",
			"    if(Test-Path $r){",
			"      Get-ChildItem -LiteralPath $r | ForEach-Object {",
			"        try {",
			"          $p=$_.PSPath;",
			"          $dn=(Get-ItemProperty -LiteralPath $p).DisplayName;",
			"          if(-not $dn){ return }",
			"          $di=(Get-ItemProperty -LiteralPath $p).DisplayIcon;",
			"          if($di){ $items += [pscustomobject]@{Name=[string]$dn;AppID=[string]$di} }",
			"        } catch {}",
			"      }",
			"    }",
			"  } catch {}",
			"}",
			"$items | ConvertTo-Json -Compress",
			].join(' '),
		]);
		ps.stdout.setEncoding('utf8');
		ps.stderr.setEncoding('utf8');
		let data = '';
		let err = '';
		ps.stdout.on('data', (chunk) => (data += String(chunk)));
		ps.stderr.on('data', (chunk) => (err += String(chunk)));
		ps.on('close', (code) => {
			if (code !== 0) {
				if (err) console.warn('loadInstalledApps failed:', err);
				return;
			}
			try {
				const apps = JSON.parse(data);
				const list: InstalledApp[] = Array.isArray(apps) ? apps : apps ? [apps] : [];
				const merged = new Map<string, InstalledApp>();
				const nameSeen = new Set<string>();

				// 去重策略：优先保留 Get-StartApps 的 AppID（通常更“官方”），注册表项作为补齐；同名项避免重复出现
				for (const it of list) {
					const name = typeof (it as any)?.Name === 'string' ? (it as any).Name.trim() : '';
					const rawId = typeof (it as any)?.AppID === 'string' ? (it as any).AppID.trim() : '';
					if (!name || !rawId) continue;

					const idLooksLikePath = rawId.includes('\\') || rawId.includes('/') || rawId.toLowerCase().includes('.exe');
					const normalizedId = idLooksLikePath ? normalizeExeSpec(rawId) : rawId;
					if (!normalizedId) continue;

					// 注册表来源的 DisplayIcon 可能是 .ico：不可启动，直接跳过
					if (idLooksLikePath && !normalizedId.toLowerCase().endsWith('.exe')) continue;
					if (idLooksLikePath && (normalizedId.includes('\\') || normalizedId.includes('/')) && !existsSync(resolveAppId(normalizedId))) continue;

					const key = normalizedId.toLowerCase();
					const nameKey = name.toLowerCase();
					if (nameSeen.has(nameKey) && !merged.has(key)) continue;

					if (!merged.has(key)) merged.set(key, { Name: name, AppID: normalizedId });
					nameSeen.add(nameKey);
				}

				const next = Array.from(merged.values());
				if (next.length > 0) {
					installedAppsCache = next;
					saveCache(next);
				}
			} catch (e: any) {
				// JSON 解析失败时保持原缓存：避免“应用全部搜不到”
				if (err) console.warn('loadInstalledApps parse failed:', err);
				else console.warn('loadInstalledApps parse failed:', e?.message || 'unknown');
			}
		});
	}, 1400);
}

async function openResolvedTarget(resolved: string) {
	if (!resolved) return false;
	const raw = String(resolved || '').trim();
	if (!raw) return false;
	const lower = raw.toLowerCase();
	const tryExplorer = (target: string) => {
		try {
			const p = spawn('explorer.exe', [target], { windowsHide: true, detached: true });
			p.unref();
			return true;
		} catch {
			return false;
		}
	};
	const tryStartProcess = (target: string) =>
		new Promise<boolean>((resolve) => {
			try {
				const escaped = target.replace(/'/g, "''");
				const cmd = `try { Start-Process '${escaped}' -ErrorAction Stop } catch { exit 1 }`;
				const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
				ps.on('close', (code) => resolve(code === 0));
				ps.on('error', () => resolve(false));
			} catch {
				resolve(false);
			}
		});
	if (lower.startsWith('shell:') || lower.startsWith('ms-settings:')) {
		try {
			await shell.openExternal(raw);
			return true;
		} catch {}
		if (tryExplorer(raw)) return true;
		return await tryStartProcess(raw);
	}
	const isFsPath =
		process.platform === 'win32'
			? /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)
			: raw.startsWith('/');
	if (isFsPath) {
		const msg = await shell.openPath(raw);
		return !msg;
	}
	const url = `shell:AppsFolder\\${raw}`;
	try {
		await shell.openExternal(url);
		return true;
	} catch {}
	if (tryExplorer(url)) return true;
	return await tryStartProcess(url);
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
		acceptFirstMouse: true,
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
	// watcher 的过滤必须快速：这里用主进程缓存的 ignore 规则避免跨线程往返
	if (isIgnoredPathByCache(fullPath)) return true;
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
				const raw = filename.toString();
				const fullPath = path.isAbsolute(raw) ? raw : path.join(normalized, raw);
				if (shouldSkipWatchPath(fullPath)) return;
				setTimeout(() => {
					try {
						if (!existsSync(fullPath)) {
							recentIndex.delete(normalizeRecentKey(fullPath));
							void fileIndex.removePath(fullPath);
							return;
						}
						const st = statSync(fullPath);
						const isDir = st.isDirectory();
						const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
						upsertRecentIndex(fullPath, isDir, timeMs);
						void fileIndex.ingestPath(fullPath, isDir);
					} catch {}
				}, 80);
			});
			userDirWatchers.set(key, w);
		} catch {}
	};

	const refreshRootsAndWatch = async () => {
		// Windows 盘符可能运行期变化（U盘/移动硬盘），这里定时刷新并增删 watcher
		if (process.platform === 'win32') {
			try {
				windowsFileSystemRootsCache = await getWindowsFileSystemRoots();
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
		setInterval(() => {
			void refreshRootsAndWatch();
		}, 12_000);
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
	const sendOpenEvent = () => {
		// 首次呼出时渲染进程可能还在加载：这里统一在“实际 show 的时刻”发送事件，避免丢事件导致空白/状态不一致
		if (!win || win.isDestroyed()) return;
		try {
			if (settings.keepStateOnClose) win.webContents.send('search-window-opened');
			else win.webContents.send('reset-search');
		} catch {}
	};
	const showWhenReady = () => {
		// dev 首次冷启动时 Vite 页面可能未完成首帧：如果此时 show，会只看到 backgroundColor 纯色底
		// 这里等待 did-finish-load 后再 show，避免短时间“空白面板”体验；如果已加载则立即显示
		if (!win || win.isDestroyed()) return;
		const wc = win.webContents;
		const doShow = () => {
			if (!win || win.isDestroyed()) return;
			win.show();
			win.focus();
			sendOpenEvent();
		};
		if (typeof wc?.isLoading === 'function' && wc.isLoading()) {
			wc.once('did-finish-load', () => doShow());
			return;
		}
		doShow();
	};
	if (win && !win.isDestroyed()) {
		if (win.isVisible()) {
			win.focus();
			return;
		}

		fileIndex.setSearchWindowVisible(true);
		// 清空缓存后需要在下次呼出面板时自动重建索引：这里确保索引为空时会触发 rebuild
		void fileIndex.buildIfEmpty();
		searchWasFocusedSinceShow = false;
		searchAllowBlurHide = false;
		if (searchHideTimer) {
			clearTimeout(searchHideTimer);
			searchHideTimer = null;
		}
		ignoreSearchBlurUntil = Date.now() + 900;
		showWhenReady();
		void reconcileRecentIndex();
		searchVisibleAt = Date.now();
		setTimeout(() => {
			if (win && !win.isDestroyed() && win.isVisible()) win.focus();
		}, 80);
		return;
	}
	win = null;
	createWindow();
	fileIndex.setSearchWindowVisible(true);
	// 新窗口显示前触发一次“索引为空则重建”，避免用户首次呼出后看到空结果
	void fileIndex.buildIfEmpty();
	// 新建窗口时同样等页面首帧准备好再 show 与发事件，避免首次呼出空白
	showWhenReady();
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

function getDeviceId() {
	try {
		if (existsSync(DEVICE_ID_PATH)) {
			const raw = JSON.parse(readFileSync(DEVICE_ID_PATH, 'utf-8'));
			if (typeof raw?.deviceId === 'string' && raw.deviceId) return raw.deviceId;
		}
	} catch {}
	const newId = randomUUID();
	try {
		writeFileSync(DEVICE_ID_PATH, JSON.stringify({ deviceId: newId }));
	} catch {}
	return newId;
}

ipcMain.handle('get-device-id', () => {
	return getDeviceId();
});

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

async function handleQuickItemPicked(targetPath: string) {
	try {
		const ext = path.extname(targetPath).toLowerCase();
		const name = path.basename(targetPath, ext) || path.basename(targetPath) || '快捷项';
		recordHistoryItem({ name, path: targetPath, type: 'file' });
		win?.webContents.send('reset-search');
	} catch {}
}

function registerShortcutsForSettings(s: { searchShortcut: string; settingsShortcut: string }) {
	registerGlobalShortcuts({
		getSearchShortcut: () => s.searchShortcut,
		getSettingsShortcut: () => s.settingsShortcut,
		openSearchWindow,
		showSettingsWindow,
	});
}

function registerShortcutsFromDisk() {
	const s = loadSettings();
	registerShortcutsForSettings({ searchShortcut: s.searchShortcut, settingsShortcut: s.settingsShortcut });
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
		// 初始化时同步设置忽略规则（主进程缓存 + Worker 内索引规则）
		await fileIndex.setIgnoredPaths(initialSettings.ignoredPaths);
		createWindow();
		tray = ensureTray({
			getIconPath: getDefaultTrayIconPath,
			toggleSearchWindow,
			showSettingsWindow,
			onAddQuickItemPath: handleQuickItemPicked,
		});
		registerShortcutsForSettings({
			searchShortcut: initialSettings.searchShortcut,
			settingsShortcut: initialSettings.settingsShortcut,
		});
		loadInstalledApps();
		void ensureWindowsAppContextMenu();
		try {
			handleAddToQuickListArgv(process.argv);
		} catch {}
		void startUserDirectoryWatchers();
		app.setLoginItemSettings({ openAtLogin: initialSettings.autoStart, openAsHidden: true, path: app.getPath('exe') });

		setTimeout(() => void ensureStartMenuShortcutIndex(), 0);
		void (async () => {
			try {
				await fileIndex.loadCache();
				const meta = loadFileIndexMeta();
				if (!meta || meta.version !== FILE_INDEX_VERSION) {
					// 版本不一致时需要彻底复位再重建：避免旧索引残留影响结果
					await fileIndex.reset();
					await fileIndex.rebuild();
					saveFileIndexMeta({ version: FILE_INDEX_VERSION });
				} else {
					await fileIndex.buildIfEmpty();
				}
			} catch {}
		})();
	});
}

app.on('will-quit', () => {
	globalShortcut.unregisterAll();
	tray?.destroy();
	tray = null;
	for (const w of userDirWatchers.values()) {
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

ipcMain.handle('select-avatar-image', async () => {
	try {
		// 头像选择：仅返回本地图片路径，渲染侧通过 get-image-data-url 转为可用的 dataUrl 展示
		const result = await dialog.showOpenDialog({
			title: '选择头像图片',
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

ipcMain.handle('save-settings', async (_event, settings: AppSettings) => {
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
		defaultSearchTypeIdRaw === 'app' ||
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

	// 基础搜索类型：需要与渲染侧保持一致（包含“应用”类型）
	const baseTypeIds = ['all', 'app', 'file', 'folder', 'image', 'video', 'settings'];
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
	const customAvatarPath = typeof settings?.customAvatarPath === 'string' ? settings.customAvatarPath.trim() : '';
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

	const allowedActionIds = new Set<ResultActionButtonId>(['openFolder', 'copyPath', 'deleteHistory', 'runAsAdmin']);
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
		customAvatarPath,
		resultActionButtons,
	};

	if (next.searchShortcut === next.settingsShortcut) return { ok: false, message: '两个快捷键不能相同' };

	globalShortcut.unregisterAll();
	const okSearch = globalShortcut.register(next.searchShortcut, () => openSearchWindow());
	const okSettings = globalShortcut.register(next.settingsShortcut, () => showSettingsWindow());
	globalShortcut.unregisterAll();

	if (!okSearch) {
		registerShortcutsFromDisk();
		return { ok: false, message: '呼出搜索框快捷键已被占用' };
	}
	if (!okSettings) {
		registerShortcutsFromDisk();
		return { ok: false, message: '呼出设置界面快捷键已被占用' };
	}

	app.setLoginItemSettings({
		openAtLogin: next.autoStart,
		openAsHidden: true,
		path: app.getPath('exe'),
	});
	// 保存设置后同步更新忽略规则（主进程缓存 + Worker 内索引规则）
	await fileIndex.setIgnoredPaths(next.ignoredPaths);
	saveSettings(next);
	// historyLimit 变化时裁剪历史
	const history = loadHistory();
	saveHistory(next.historyLimit > 0 ? history.filter((h) => isExistingTarget(h)).slice(0, next.historyLimit) : []);
	registerShortcutsForSettings({ searchShortcut: next.searchShortcut, settingsShortcut: next.settingsShortcut });
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
			const iconData = await getHistoryIconForPath({ type: h.type, name: h.name, path: h.path });
			return { name: h.name, path: h.path, type: h.type, icon: iconData };
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

ipcMain.handle('clear-cache', async () => {
	// 供“clear:cache”命令调用：清空索引与缓存，但保留登录态与用户设置
	await clearLocalCacheButKeepAccountAndSettings();
	return { ok: true };
});

ipcMain.handle('open-item', async (event, item: { name: string; path: string; type?: string }) => {
	try {
		if (item?.type === 'command' && typeof item?.path === 'string' && item.path.trim().toLowerCase() === 'clear:cache') {
			// 命令：清空缓存与索引。保持窗口不强制关闭，用户可继续操作。
			await clearLocalCacheButKeepAccountAndSettings();
			return true;
		}
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

ipcMain.handle('open-folder', async (event, input: any) => {
	try {
		// 兼容旧调用：open-folder(path)；新调用：open-folder({ type, path, name })
		const p = typeof input === 'string' ? input : typeof input?.path === 'string' ? input.path : '';
		const t = typeof input?.type === 'string' ? input.type : '';
		const n = typeof input?.name === 'string' ? input.name : '';
		const resolved = resolveAppId(p);

		if (resolved.includes('\\') || resolved.includes('/')) {
			// 文件系统路径：文件选中父目录；文件夹则直接打开该目录，符合“打开目录”直觉
			try {
				const st = statSync(resolved);
				if (st.isDirectory()) {
					await shell.openPath(resolved);
				} else {
					shell.showItemInFolder(resolved);
				}
			} catch {
				// stat 失败时退化为 showItemInFolder，至少能定位到资源所在目录
				shell.showItemInFolder(resolved);
			}
		} else {
			// AppID 没有稳定“安装目录”可供打开：优先定位到开始菜单/桌面快捷方式（.lnk）所在目录，避免打开 AppsFolder 虚拟目录导致用户无法进一步操作
			await ensureStartMenuShortcutIndex();
			const shortcut = n ? findStartMenuShortcutByName(n) : '';
			if (shortcut && existsSync(shortcut)) {
				shell.showItemInFolder(shortcut);
			} else if (t === 'app' && p) {
				// 兜底：若找不到快捷方式，至少打开 AppsFolder 让用户看到应用列表
				await shell.openExternal(`shell:AppsFolder`);
			} else {
				await shell.openExternal(`shell:AppsFolder`);
			}
		}
		BrowserWindow.fromWebContents(event.sender)?.hide();
		return true;
	} catch {
		return false;
	}
});

ipcMain.handle('run-as-admin', async (event, input: any) => {
	try {
		const p = typeof input === 'string' ? input : typeof input?.path === 'string' ? input.path : '';
		if (!p) return false;
		
		const resolved = resolveAppId(p);
		
		if (process.platform === 'win32') {
			const escaped = resolved.replace(/'/g, "''");
			// 使用 PowerShell 的 Start-Process -Verb RunAs 提权运行
			const cmd = `Start-Process '${escaped}' -Verb RunAs`;
			const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
			
			const ok = await new Promise<boolean>((resolve) => {
				ps.on('close', (code) => resolve(code === 0));
				ps.on('error', () => resolve(false));
			});
			if (ok) {
				BrowserWindow.fromWebContents(event.sender)?.hide();
			}
			return ok;
		}
		// 非 Windows 平台暂不支持提权，降级为普通打开
		const ok = await openResolvedTarget(resolved);
		if (ok) BrowserWindow.fromWebContents(event.sender)?.hide();
		return ok;
	} catch {
		return false;
	}
});

ipcMain.handle('open-external', async (_event, url: string) => {
	if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
		await shell.openExternal(url);
	}
});

ipcMain.handle('get-result-icon', async (_event, item: { type: string; path: string; name?: string }) => {
	try {
		const t = typeof item?.type === 'string' ? item.type : '';
		const p = typeof item?.path === 'string' ? item.path : '';
		const n = typeof item?.name === 'string' ? item.name : '';
		if (!t || !p) return '';
		if (t === 'app') {
			await ensureStartMenuShortcutIndex();
		return await getAppIconDataStable(n, p, 3);
		}
		if (t === 'file') {
			return await getFileIconData(p);
		}
		return '';
	} catch {
		return '';
	}
});

ipcMain.handle('rebuild-file-index', async (_event, options?: { ignoredPaths?: string[] }) => {
	// 全盘索引需要尊重用户配置的限制（例如路径黑名单）：这里允许设置页把“当前配置”传进来生效
	if (Array.isArray(options?.ignoredPaths)) {
		await fileIndex.setIgnoredPaths(options.ignoredPaths);
	}
	await fileIndex.rebuild();
	return await fileIndex.getStatus();
});

ipcMain.handle('get-file-index-status', async () => {
	// 提供给设置页查询索引状态：用于“全盘建立索引”按钮跨切换保持文案
	return await fileIndex.getStatus();
});

ipcMain.handle('search-files', async (event, query: string, options?: { searchTypeId?: string; searchSessionId?: string; drive?: string }) => {
	return await handleSearchFiles(event, query, options, {
		fileIndex,
		reconcileRecentIndex: () => void reconcileRecentIndex(),
		loadSettings,
		loadHistoryStats,
		normalizeHistoryKey,
		normalizeExtKey,
		getInstalledApps: () => installedAppsCache,
		normalizeAppGroupKey,
		iconDataCache,
		isTooSmallAppIconDataUrl,
		getAppIconDataStable,
		getFileIconData,
		isIgnoredPathByCache,
		normalizeRecentKey,
		recentIndex,
		shouldSkipWatchPath,
		getWindowsFileSystemRoots,
	});
});

export async function legacySearchFilesHandler_DO_NOT_USE(event: any, query: string, options?: any) {
	if (!query || query.trim().length < 1) return { results: [], isIndexing: (await fileIndex.getStatus()).isIndexing };
	fileIndex.pauseIndexingFor(900);
	// 搜索时顺带触发一次轻量兜底扫描：提高新建/改动文件被检索到的概率（不阻塞当前请求）
	void reconcileRecentIndex();

	const lowerQuery = query.trim().toLowerCase();
	const queryParts = lowerQuery.split(/\s+/).filter(Boolean);

	const searchTypeId = typeof options?.searchTypeId === 'string' ? options.searchTypeId : 'all';
	// 搜索会话 ID：用于将后台分批推送的 more-results 与当前搜索绑定，避免切换类型后出现重复项/数量不一致
	const searchSessionId =
		typeof options?.searchSessionId === 'string' && options.searchSessionId.trim()
			? options.searchSessionId.trim()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	// 内置命令：通过搜索框触发“清空缓存与索引”，保留登录态与设置
	if (lowerQuery === 'clear:cache') {
		return {
			results: [
				{
					name: '清空缓存并重新建立索引',
					path: 'clear:cache',
					type: 'command',
					description: '保留登录账户与设置；下次呼出面板会自动重建索引',
				},
			],
			isIndexing: false,
			hasMore: false,
			searchSessionId,
			totalCount: 1,
		};
	}
	const currentIconPrefetchToken = ++iconPrefetchToken;
	const driveFilterRaw = typeof options?.drive === 'string' ? options.drive.trim() : '';
	const driveFilter = /^[a-z]$/i.test(driveFilterRaw) ? driveFilterRaw.toLowerCase() : '';
	const extFilter = searchTypeId.startsWith('ext:') ? searchTypeId.slice(4).toLowerCase() : '';
	// 综合排序权重：①名称匹配度 > ④访问频次 > ③常用类型 > ②时间（新建/改动更近）
	const now = Date.now();
	const historyStats = loadHistoryStats();
	const getLastUsedMs = (rawPath: string) => {
		const key = normalizeHistoryKey(rawPath);
		if (!key) return 0;
		const it = historyStats.byPath[key];
		const lastUsed = typeof it?.lastUsed === 'number' && it.lastUsed > 0 ? it.lastUsed : 0;
		return lastUsed;
	};
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
		const nameScore = baseScore;
		const accessBoost = getAccessBoost(rawPath);
		const typeBoost = getTypeBoost(type, rawPath);
		const timeBoost = getTimeBoost(timeMs);
		return nameScore * 1_000_000 + accessBoost * 1_000 + typeBoost * 10 + timeBoost;
	};

	const normalizeForMatchName = (name: string) => name.replace(/\.(exe|lnk)$/i, '').toLowerCase();
	const tokenizeForScore = (q: string) => q.split(/[\s._\-+\\/]+/).filter(Boolean);
	const scoreTokens = tokenizeForScore(lowerQuery);
	const countOccurrences = (hay: string, needle: string) => {
		if (!needle) return 0;
		let idx = 0;
		let count = 0;
		while (idx < hay.length) {
			const i = hay.indexOf(needle, idx);
			if (i < 0) break;
			count += 1;
			idx = i + Math.max(1, needle.length);
		}
		return count;
	};
	const computeWeightedNameMatch = (rawName: string) => {
		const nameLower = normalizeForMatchName(rawName);
		if (!nameLower) return { weightedScore: 0, matchIndex: 1_000_000, nameLen: 0 };
		const noExt = nameLower.replace(/\.[^./\\]+$/, '');
		const candidates = noExt && noExt !== nameLower ? [nameLower, noExt] : [nameLower];
		const isAsciiQuery = /^[a-z0-9\s._\-+\\/]+$/.test(lowerQuery);
		if (isAsciiQuery && hasChineseChar(rawName)) {
			const py = toPinyinFull(rawName);
			const ini = toPinyinInitials(rawName);
			if (py) candidates.push(py);
			if (ini) candidates.push(ini);
		}

		const scoreOne = (target: string) => {
			let score = 0;
			if (target === lowerQuery) score += 100;
			if (target.startsWith(lowerQuery)) score += 80;
			if (target.endsWith(lowerQuery)) score += 60;
			if (target.includes(lowerQuery)) score += 40;

			const matchedTokens = scoreTokens.filter((t) => t && target.includes(t));
			if (scoreTokens.length > 0 && matchedTokens.length === scoreTokens.length) score += 20;
			else if (matchedTokens.length > 0) score += 10;

			const occFull = countOccurrences(target, lowerQuery);
			let occTokens = 0;
			for (const t of matchedTokens) occTokens += countOccurrences(target, t);
			score += Math.min(40, (occFull + occTokens) * 2);

			const idxFull = target.indexOf(lowerQuery);
			let bestIdx = idxFull >= 0 ? idxFull : 1_000_000;
			for (const t of matchedTokens) {
				const i = target.indexOf(t);
				if (i >= 0 && i < bestIdx) bestIdx = i;
			}

			return { weightedScore: score, matchIndex: bestIdx, nameLen: target.length };
		};

		let best = scoreOne(candidates[0]);
		for (let i = 1; i < candidates.length; i++) {
			const cur = scoreOne(candidates[i]);
			if (cur.weightedScore > best.weightedScore) best = cur;
			else if (cur.weightedScore === best.weightedScore) {
				if (cur.matchIndex < best.matchIndex) best = cur;
				else if (cur.matchIndex === best.matchIndex && cur.nameLen < best.nameLen) best = cur;
			}
		}
		return best;
	};
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
			// 设置项也需要支持拼音/首字母：例如“设置”可用 “sz” 命中“系统设置”
			const weighted = computeWeightedNameMatch(it.name);
			if (weighted.weightedScore <= 0) continue;
			const baseScore = weighted.weightedScore * 400 + (weighted.matchIndex <= 2 ? 1500 : 0);
			const score = computeCombinedScore(baseScore, 'settings', it.uri, getLastUsedMs(it.uri));
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
						// 所有类型下的设置项同样支持拼音/首字母搜索
						const weighted = computeWeightedNameMatch(it.name);
						if (weighted.weightedScore <= 0) continue;
						const baseScore = weighted.weightedScore * 400 + (weighted.matchIndex <= 2 ? 1500 : 0);
						const score = computeCombinedScore(baseScore, 'settings', it.uri, getLastUsedMs(it.uri));
						out.push({ name: it.name, path: it.uri, type: 'settings', score });
					}
					return out;
			  })()
			: [];

	const appResults = await (async () => {
		// 应用结果只出现在：所有类型 / 文件（历史兼容：文件里也允许搜应用）/ 应用
		if (searchTypeId !== 'all' && searchTypeId !== 'file' && searchTypeId !== 'app') return [];
		
		// “动作类关键词”会显著影响相关性：例如搜索“卸载”时，不应该把正常应用当成相关项返回
		const actionTokens = ['卸载', 'uninstall', 'remove', '删除', '移除'];
		const isActionQuery = actionTokens.some((t) => lowerQuery.includes(t));

		// 记录“主命中应用”的分组：用于补齐卸载/升级/服务等周边应用
		const matchedGroupKeys = new Set<string>();
		const matchedAppIds = new Set<string>();
		const results: Array<{ name: string; path: string; type: string; icon?: string; score: number }> = [];
		for (const appItem of installedAppsCache) {
			// 应用匹配按“分词 + 模糊子序列”计算相关性：避免仅靠 includes 导致弱相关项混入
			const legacyScore = scoreRecentName(appItem.Name);
			const weighted = computeWeightedNameMatch(appItem.Name);
			const nameMatchScore =
				legacyScore > 0 ? legacyScore : weighted.weightedScore > 0 ? Math.round(weighted.weightedScore * 25) : 0;
			if (nameMatchScore <= 0) continue;
			// 应用图标优先用缓存：避免 search-files 里同步提取图标导致卡顿
			const cacheKey = `app:${appItem.AppID}`;
			const iconData = iconDataCache.get(cacheKey) || '';

			const groupKey = normalizeAppGroupKey(appItem.Name);
			if (groupKey) matchedGroupKeys.add(groupKey);
			matchedAppIds.add(String(appItem.AppID || '').toLowerCase());

			results.push({
				name: appItem.Name,
				path: appItem.AppID,
				type: 'app',
				icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : '',
				score: computeCombinedScore(10_000 + nameMatchScore, 'app', appItem.AppID, getLastUsedMs(appItem.AppID)),
			});

			// 未命中缓存时异步预取：主进程会分批回填 icon，避免影响输入/切换类型
			if (!iconData) void getAppIconDataStable(appItem.Name, appItem.AppID, 2);
		}

		// 周边应用补齐：当主应用命中时，将同组的“卸载/升级/服务/修复”等入口一起加入结果
		// 这些条目可能不直接包含用户输入（例如只有“卸载”或“升级服务”），但与主应用强相关
		if (matchedGroupKeys.size > 0) {
			let added = 0;
			const MAX_RELATED = 80;
			for (const appItem of installedAppsCache) {
				if (added >= MAX_RELATED) break;
				const appIdLower = String(appItem.AppID || '').toLowerCase();
				if (!appIdLower) continue;
				if (matchedAppIds.has(appIdLower)) continue;

				const groupKey = normalizeAppGroupKey(appItem.Name);
				if (!groupKey || !matchedGroupKeys.has(groupKey)) continue;

				const nameLower = appItem.Name.toLowerCase();
				// 动作查询（如“卸载”）时，只补齐同组的“卸载/移除”等入口，避免混入正常应用
				if (isActionQuery && !actionTokens.some((t) => nameLower.includes(t))) continue;

				const cacheKey = `app:${appItem.AppID}`;
				const iconData = iconDataCache.get(cacheKey) || '';
				const legacyScore = scoreRecentName(appItem.Name);
				const weighted = computeWeightedNameMatch(appItem.Name);
				const relatedMatchScore =
					legacyScore > 0 ? legacyScore : weighted.weightedScore > 0 ? Math.round(weighted.weightedScore * 25) : 0;
				const baseScore = relatedMatchScore > 0 ? 9_500 : 7_000;
				results.push({
					name: appItem.Name,
					path: appItem.AppID,
					type: 'app',
					icon: iconData && !isTooSmallAppIconDataUrl(iconData) ? iconData : '',
					score: computeCombinedScore(baseScore + Math.max(0, relatedMatchScore), 'app', appItem.AppID, getLastUsedMs(appItem.AppID)),
				});
				matchedAppIds.add(appIdLower);
				added += 1;
				if (!iconData) void getAppIconDataStable(appItem.Name, appItem.AppID, 2);
			}
		}
		return results;
	})();

	if (searchTypeId === 'app') {
		const sorted = appResults.sort((a, b) => (b.score || 0) - (a.score || 0));
		const head = sorted.slice(0, 60);
		if (head.length > 0) {
			const deadline = Date.now() + 1800;
			const queue = head.slice();
			const worker = async () => {
				while (queue.length > 0) {
					if (Date.now() >= deadline) return;
					const it = queue.shift();
					if (!it || it.icon) continue;
					const icon = await getAppIconDataStable(it.name, it.path, 3);
					if (icon) it.icon = icon;
				}
			};
			await Promise.all([worker(), worker(), worker(), worker()]);
		}
		const merged = sorted.slice(0, 100).map(({ score, ...rest }) => rest);
		(async () => {
			const batchSize = 20;
			for (let i = 0; i < merged.length; i += batchSize) {
				if (currentIconPrefetchToken !== iconPrefetchToken) return;
				const batch = merged.slice(i, i + batchSize);
				const updates: Array<{ name: string; path: string; type: string; icon: string }> = [];
				for (const it of batch) {
					if (currentIconPrefetchToken !== iconPrefetchToken) return;
					if (!it?.path || it.type !== 'app') continue;
					if (typeof (it as any).icon === 'string' && (it as any).icon) continue;
					const cached = iconDataCache.get(`app:${it.path}`) || '';
					if (cached) {
						updates.push({ ...it, icon: cached });
						continue;
					}
					const icon = await getAppIconDataStable(it.name, it.path, 3);
					if (icon) updates.push({ ...it, icon });
				}
				if (updates.length > 0) {
					event.sender.send('more-results', {
						query,
						searchTypeId,
						searchSessionId,
						results: updates,
					});
				}
				await new Promise((resolve) => setTimeout(resolve, 12));
			}
		})();
		return { results: merged, isIndexing: false, hasMore: false, searchSessionId, totalCount: appResults.length };
	}

	// 文件索引搜索的候选上限：当用户指定“文件夹/图片/视频/扩展名”等更窄的类型时，提高候选数量，
	// 避免同名文件过多导致目录/特定类型结果在 topN 之外被截断，从而出现“所有类型能搜到，但对应类型搜不到”
	const fileSearchLimit = searchTypeId === 'all' || searchTypeId === 'file' ? 500 : 5000;
	const currentSettings = loadSettings();
	const customExts = Array.isArray(currentSettings.customSearchTypes)
		? currentSettings.customSearchTypes.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : '')).filter(Boolean)
		: [];
	const where = (() => {
		const and: any[] = [];
		if (driveFilter) and.push({ drive: { eq: driveFilter } });
		if (searchTypeId === 'folder') and.push({ kind: { eq: 'folder' } });
		else if (searchTypeId === 'image') and.push({ kind: { eq: 'image' } });
		else if (searchTypeId === 'video') and.push({ kind: { eq: 'video' } });
		else if (searchTypeId === 'file') {
			and.push({ kind: { eq: 'file' } });
			if (customExts.length > 0) and.push({ ext: { nin: customExts } });
		} else if (extFilter) {
			and.push({ ext: { eq: extFilter } });
		}
		if (and.length <= 0) return undefined;
		if (and.length === 1) return and[0];
		return { and };
	})();
	const fileSearch = await fileIndex.search(query, fileSearchLimit, where ? { where } : undefined);
	const totalCount =
		searchTypeId === 'all'
			? settingsResults.length + appResults.length + fileSearch.totalCount
			: searchTypeId === 'file'
				? appResults.length + fileSearch.totalCount
				: fileSearch.totalCount;

	// 预过滤文件：避免为不需要的文件提取图标
	const filteredFiles: Array<{
		path: string;
		name: string;
		isDirectory: boolean;
		oramaTie: number;
		score: number;
		weightedScore: number;
		matchIndex: number;
		nameLen: number;
		timeMs: number;
		size: number;
	}> = [];
	for (const r of fileSearch.results) {
		if (isIgnoredPathByCache(r.path)) continue;
		// 去重：开始菜单/桌面的 .lnk/.url 本质是“应用入口”，不应作为“文件结果”与应用结果同时出现
		if (!extFilter && (searchTypeId === 'all' || searchTypeId === 'file') && isLikelyAppShortcutFile(r.path)) continue;
		const isDirectory = Boolean(r.isDirectory);
		const timeMs = 0;
		const size = 0;

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

		const { weightedScore, matchIndex, nameLen } = computeWeightedNameMatch(r.name);
		const oramaTie = Math.min(99, Math.round(Math.max(0, r.score || 0) / 100));
		const baseScore = weightedScore * 100 + oramaTie;
		const type = isDirectory ? 'folder' : 'file';
		const score = computeCombinedScore(baseScore, type, r.path, timeMs);
		filteredFiles.push({
			path: r.path,
			name: r.name,
			isDirectory,
			oramaTie,
			score,
			weightedScore,
			matchIndex,
			nameLen,
			timeMs,
			size,
		});
	}

	const appendRecentMatches = () => {
		const seen = new Set(filteredFiles.map((x) => normalizeRecentKey(x.path)));
		const items = Array.from(recentIndex.values());
		const start = Math.max(0, items.length - 6000);
		for (let i = start; i < items.length; i++) {
			const it = items[i];
			if (!it?.path) continue;
			if (driveFilter && !it.path.toLowerCase().startsWith(`${driveFilter}:`)) continue;
			const key = normalizeRecentKey(it.path);
			if (!key) continue;
			if (seen.has(key)) continue;
			if (isIgnoredPathByCache(it.path)) continue;
			// 去重：开始菜单/桌面的快捷方式不作为“文件结果”返回，避免与“应用结果”重复
			if (!extFilter && (searchTypeId === 'all' || searchTypeId === 'file') && isLikelyAppShortcutFile(it.path)) continue;

			const weighted = computeWeightedNameMatch(it.name);
			const legacy = scoreRecentName(it.name);
			const baseWeighted = weighted.weightedScore > 0 ? weighted.weightedScore : legacy > 0 ? 10 : 0;
			if (baseWeighted <= 0) continue;
			if (!existsSync(it.path)) {
				recentIndex.delete(key);
				continue;
			}

			const isDirectory = Boolean(it.isDirectory);

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
			const score = computeCombinedScore(baseWeighted * 100, type, it.path, it.timeMs || 0);
			filteredFiles.push({
				path: it.path,
				name: it.name,
				isDirectory,
				oramaTie: 0,
				score,
				weightedScore: baseWeighted,
				matchIndex: weighted.matchIndex,
				nameLen: weighted.nameLen,
				timeMs: it.timeMs || 0,
				size: 0,
			});
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
		const safeStat = (p: string) => {
			try {
				return statSync(p);
			} catch {
				return null;
			}
		};
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
					// 去重：开始菜单/桌面的快捷方式不参与文件兜底扫描，避免与应用重复
					if (!extFilter && (searchTypeId === 'all' || searchTypeId === 'file') && isLikelyAppShortcutFile(fullPath)) continue;

					const weighted = computeWeightedNameMatch(ent.name);
					const legacy = scoreRecentName(ent.name);
					const baseWeighted = weighted.weightedScore > 0 ? weighted.weightedScore : legacy > 0 ? 10 : 0;
					const likelyMatch = baseWeighted > 0;

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
					if (isIgnoredPathByCache(fullPath)) continue;

					const st = safeStat(fullPath);
					if (!st) continue;
					const isDirectory = st.isDirectory();
					const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);

					// 将兜底扫描到的条目写入“最近变更索引”与主索引，后续检索更稳定
					upsertRecentIndex(fullPath, isDirectory, timeMs);
					await fileIndex.ingestPath(fullPath, isDirectory);

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
					const score = computeCombinedScore(baseWeighted * 100, type, fullPath, timeMs);
					filteredFiles.push({
						path: fullPath,
						name: ent.name,
						isDirectory,
						oramaTie: 0,
						score,
						weightedScore: baseWeighted,
						matchIndex: weighted.matchIndex,
						nameLen: weighted.nameLen,
						timeMs,
						size: typeof (st as any)?.size === 'number' ? (st as any).size : 0,
					});
					seen.add(key);
				}
			} finally {
				try {
					await dh.close();
				} catch {}
			}
		}
	};

	const scanDriveRootForNameMatches = async (drive: string, budgetMs: number) => {
		if (process.platform !== 'win32') return;
		const d = (drive || '').trim().toLowerCase();
		if (!/^[a-z]$/.test(d)) return;
		const driveRoot = `${d.toUpperCase()}:\\`;
		if (!existsSync(driveRoot)) return;

		const startAt = Date.now();
		const MAX_DEPTH = 8;
		const MAX_VISIT = 18_000;
		let visited = 0;
		const queue: Array<{ dir: string; depth: number }> = [{ dir: driveRoot, depth: 0 }];
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
					if (visited % 450 === 0) {
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
					}
					if (Date.now() - startAt > Math.max(80, budgetMs)) break;
					if (!ent?.name) continue;

					const fullPath = path.join(dir, ent.name);
					if (shouldSkipWatchPath(fullPath)) continue;

					const weighted = computeWeightedNameMatch(ent.name);
					const legacy = scoreRecentName(ent.name);
					const baseWeighted = weighted.weightedScore > 0 ? weighted.weightedScore : legacy > 0 ? 10 : 0;
					const likelyMatch = baseWeighted > 0;

					if (ent.isDirectory && typeof ent.isDirectory === 'function' && ent.isDirectory()) {
						if (depth < MAX_DEPTH && (likelyMatch || depth < 2)) {
							queue.push({ dir: fullPath, depth: depth + 1 });
						}
					}
					if (!likelyMatch) continue;

					const key = normalizeRecentKey(fullPath);
					if (!key) continue;
					if (seen.has(key)) continue;
					if (isIgnoredPathByCache(fullPath)) continue;
					if (!existsSync(fullPath)) continue;

					// 盘符兜底扫描：只把“命中的条目”写入 recentIndex 与主索引，避免全盘扫描带来卡顿
					try {
						const st = statSync(fullPath);
						const isDirectory = st.isDirectory();
						// 快捷方式不参与索引与结果：避免出现 .lnk/.url，且避免与真实文件重复指向
						if (!isDirectory) {
							const ext = path.extname(fullPath).toLowerCase();
							if (ext === '.lnk' || ext === '.url') continue;
						}
						const timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
						upsertRecentIndex(fullPath, isDirectory, timeMs);
						await fileIndex.ingestPath(fullPath, isDirectory);

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
						const score = computeCombinedScore(baseWeighted * 100, type, fullPath, timeMs);
						filteredFiles.push({
							path: fullPath,
							name: ent.name,
							isDirectory,
							oramaTie: 0,
							score,
							weightedScore: baseWeighted,
							matchIndex: weighted.matchIndex,
							nameLen: weighted.nameLen,
							timeMs,
							size: typeof (st as any)?.size === 'number' ? (st as any).size : 0,
						});
						seen.add(key);
					} catch {}
				}
			} finally {
				try {
					await dh.close();
				} catch {}
			}
		}
	};

	// 当结果过少时启用兜底扫描，优先保障用户目录内的新建/小众文件可被检索到
	if (!driveFilter && (filteredFiles.length === 0 || (filteredFiles.length < 8 && (searchTypeId === 'all' || searchTypeId === 'folder')))) {
		await scanUserRootsForNameMatches(900);
	}
	if (driveFilter && filteredFiles.length < 12) {
		await scanDriveRootForNameMatches(driveFilter, 520);
	}

	const compareFilesByWeighted = (
		a: {
			weightedScore: number;
			nameLen: number;
			matchIndex: number;
			timeMs: number;
			size: number;
			score: number;
		},
		b: {
			weightedScore: number;
			nameLen: number;
			matchIndex: number;
			timeMs: number;
			size: number;
			score: number;
		}
	) => {
		if ((b.weightedScore || 0) !== (a.weightedScore || 0)) return (b.weightedScore || 0) - (a.weightedScore || 0);
		if ((a.nameLen || 0) !== (b.nameLen || 0)) return (a.nameLen || 0) - (b.nameLen || 0);
		if ((a.matchIndex || 0) !== (b.matchIndex || 0)) return (a.matchIndex || 0) - (b.matchIndex || 0);
		if ((b.timeMs || 0) !== (a.timeMs || 0)) return (b.timeMs || 0) - (a.timeMs || 0);
		if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) - (a.size || 0);
		return (b.score || 0) - (a.score || 0);
	};

	filteredFiles.sort(compareFilesByWeighted);

	const DISPLAY_LIMIT = 500;
	// 性能优先：statSync 属于重操作，过大的批量会导致首搜卡顿；仅在查询较稳定时对少量候选补齐 timeMs/size
	const statBudget = lowerQuery.length >= 2 ? Math.min(filteredFiles.length, 220) : 0;
	for (let i = 0; i < statBudget; i++) {
		const it = filteredFiles[i];
		if (!it) continue;
		if (it.timeMs > 0) continue;
		try {
			const st = statSync(it.path);
			it.timeMs = Math.max((st as any).mtimeMs || 0, (st as any).birthtimeMs || 0);
			it.size = typeof (st as any).size === 'number' ? (st as any).size : 0;
		} catch {}
	}
	for (let i = 0; i < statBudget; i++) {
		const it = filteredFiles[i];
		if (!it) continue;
		if (!it.timeMs) continue;
		const baseScore = (it.weightedScore || 0) * 100 + (it.oramaTie || 0);
		const type = it.isDirectory ? 'folder' : 'file';
		it.score = computeCombinedScore(baseScore, type, it.path, it.timeMs);
	}
	filteredFiles.sort(compareFilesByWeighted);

	const limitedFiles = filteredFiles.slice(0, DISPLAY_LIMIT);
	const candidates: Array<{
		name: string;
		path: string;
		type: string;
		icon?: string;
		score: number;
		weightedScore?: number;
		matchIndex?: number;
		nameLen?: number;
		timeMs?: number;
		size?: number;
	}> = [
		...settingsResults,
		...appResults,
		...limitedFiles.map((r) => ({
			name: r.name,
			path: r.path,
			type: r.isDirectory ? 'folder' : 'file',
			score: r.score,
			weightedScore: r.weightedScore,
			matchIndex: r.matchIndex,
			nameLen: r.nameLen,
			timeMs: r.timeMs,
			size: r.size,
		})),
	];
	const compareCandidates = (
		a: { type: string; score: number; weightedScore?: number; nameLen?: number; matchIndex?: number; timeMs?: number; size?: number },
		b: { type: string; score: number; weightedScore?: number; nameLen?: number; matchIndex?: number; timeMs?: number; size?: number }
	) => {
		const aIsFs = a.type === 'file' || a.type === 'folder';
		const bIsFs = b.type === 'file' || b.type === 'folder';
		if (aIsFs && bIsFs) {
			return compareFilesByWeighted(
				{
					weightedScore: a.weightedScore || 0,
					nameLen: a.nameLen || 0,
					matchIndex: a.matchIndex || 0,
					timeMs: a.timeMs || 0,
					size: a.size || 0,
					score: a.score || 0,
				},
				{
					weightedScore: b.weightedScore || 0,
					nameLen: b.nameLen || 0,
					matchIndex: b.matchIndex || 0,
					timeMs: b.timeMs || 0,
					size: b.size || 0,
					score: b.score || 0,
				}
			);
		}
		return (b.score || 0) - (a.score || 0);
	};
	candidates.sort(compareCandidates);
	const top500 = candidates.slice(0, DISPLAY_LIMIT);

	const initialLimit = 100;
	const firstBatch = top500.slice(0, initialLimit);
	const remainingBatch = top500.slice(initialLimit);

	const firstResults = firstBatch.filter(Boolean).map((r) => {
		// 文件图标优先从缓存读取：首屏尽量不出现“空白占位”
		// 文件夹在渲染侧用 📂 展示，不需要走系统图标提取（系统图标会拖慢整体首屏速度）
		if (r.type === 'file') {
			const cached = iconDataCache.get(`file:${r.path}`) || '';
			return cached ? { ...r, icon: cached } : r;
		}
		if (r.type === 'app') {
			const cached = iconDataCache.get(`app:${r.path}`) || '';
			return cached ? { ...r, icon: cached } : r;
		}
		return r;
	});

	// “应用”类型：用户更在意“名称+图标同时出现”。这里在返回首批结果前，给前若干个应用做一次“有限时长”的同步补齐。
	// 兜底：若在预算内仍未取到图标，则依赖后续 more-results 增量回填补齐，保证不会长期缺失。
	const syncPrefetchInitialAppIcons = async (items: Array<{ name: string; path: string; type: string; icon?: string }>) => {
		await ensureStartMenuShortcutIndex();
		const targets = items.filter((x) => x?.type === 'app').slice(0, 24);
		if (targets.length === 0) return;

		const deadline = Date.now() + 1200;
		const queue = targets.slice();
		const withDeadline = <T,>(p: Promise<T>, ms: number) =>
			Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve('' as any), ms))]);

		const worker = async () => {
			while (queue.length > 0) {
				const left = deadline - Date.now();
				if (left <= 0) return;
				const it = queue.shift();
				if (!it || !it.path) continue;
				if (typeof it.icon === 'string' && it.icon) continue;
				const icon = await withDeadline(getAppIconDataStable(it.name, it.path, 2), Math.min(320, left));
				if (typeof icon === 'string' && icon) it.icon = icon;
			}
		};

		// 并发数适中：避免一次性把主线程压满，同时提升命中速度
		await Promise.all([worker(), worker(), worker(), worker()]);
	};

	await syncPrefetchInitialAppIcons(firstResults as any);

	const merged = firstResults.map(({ score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest }) => rest);

	const prefetchIconsInBackground = (items: Array<{ name: string; path: string; type: string }>) => {
		(async () => {
			// 图标提取是性能敏感操作：首屏要更积极，后续批次适当让出事件循环避免卡输入
			const batchSize = 32;
			for (let i = 0; i < items.length; i += batchSize) {
				if (currentIconPrefetchToken !== iconPrefetchToken) return;
				const batch = items.slice(i, i + batchSize);
				const updates: Array<{ name: string; path: string; type: string; icon: string }> = [];

				for (const it of batch) {
					if (currentIconPrefetchToken !== iconPrefetchToken) return;
					if (!it?.path) continue;
					// 文件夹图标由渲染侧直接展示（📂），跳过系统图标提取以提升整体速度
					if (it.type === 'file') {
						const key = `file:${it.path}`;
						// 首次搜索“图标缺失”的根因：图标可能已被其他异步路径写入缓存，但这里因 has(key) 直接跳过，导致未回填到渲染端
						// 这里改为：只要缓存里已有非空 icon，就直接推送 updates；否则才去提取并推送
						const cached = iconDataCache.get(key) || '';
						if (cached) {
							updates.push({ ...it, icon: cached });
							continue;
						}
						const icon = await getFileIconData(it.path);
						if (typeof icon === 'string' && icon) updates.push({ ...it, icon });
						continue;
					}
					if (it.type === 'app') {
						const key = `app:${it.path}`;
						// 首次搜索“图标缺失”的根因：图标可能已被其他异步路径写入缓存，但这里因 has(key) 直接跳过，导致未回填到渲染端
						// 这里改为：只要缓存里已有非空 icon，就直接推送 updates；否则才去提取并推送
						const cached = iconDataCache.get(key) || '';
						if (cached) {
							if (!isTooSmallAppIconDataUrl(cached)) updates.push({ ...it, icon: cached });
							continue;
						}
						const icon = await getAppIconDataStable(it.name, it.path, 2);
						if (typeof icon === 'string' && icon) updates.push({ ...it, icon });
						continue;
					}
				}

				if (updates.length > 0) {
					event.sender.send('more-results', {
						query,
						searchTypeId,
						searchSessionId,
						results: updates,
					});
				}
				// 首批尽量不等待：让首屏图标更快回填；后续轻微让出时间片避免长任务占用
				const sleepMs = i === 0 ? 0 : 8;
				if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
				else await new Promise((resolve) => setImmediate(resolve));
			}
		})();
	};

	// “应用”类型的结果同样需要异步补齐图标：这里也走同一套增量回填逻辑
	if (searchTypeId === 'app') {
		prefetchIconsInBackground(appResults.map(({ score, ...rest }) => rest));
	}

	prefetchIconsInBackground(top500.map(({ score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest }) => rest));

	if (remainingBatch.length > 0) {
		(async () => {
			const batchSize = 50;
			for (let i = 0; i < remainingBatch.length; i += batchSize) {
				if (currentIconPrefetchToken !== iconPrefetchToken) return;
				const batch = remainingBatch.slice(i, i + batchSize);
				const backgroundResults = batch
					.filter(Boolean)
					.map((r) => {
						if (r.type === 'file' || r.type === 'folder') {
							const cached = iconDataCache.get(`file:${r.path}`) || '';
							const { score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest } = cached ? { ...r, icon: cached } : r;
							return rest;
						}
						if (r.type === 'app') {
							const cached = iconDataCache.get(`app:${r.path}`) || '';
							const valid = cached && !isTooSmallAppIconDataUrl(cached) ? cached : '';
							const { score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest } = valid ? { ...r, icon: valid } : r;
							return rest;
						}
						const { score, weightedScore, matchIndex, nameLen, timeMs, size, ...rest } = r;
						return rest;
					});

				if (backgroundResults.length > 0) {
					event.sender.send('more-results', {
						query,
						searchTypeId,
						searchSessionId,
						results: backgroundResults,
					});
				}
				await new Promise((resolve) => setTimeout(resolve, 16));
			}
		})();
	}

	return { 
		results: merged, 
		isIndexing: fileSearch.isIndexing,
		hasMore: remainingBatch.length > 0,
		searchSessionId,
		totalCount,
	};
	}
