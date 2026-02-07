import { app, BrowserWindow, globalShortcut, ipcMain, shell, Tray, Menu, dialog, screen, nativeImage } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, statSync, watch, writeFileSync, readdirSync } from 'node:fs';
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
	keepStateOnClose: boolean;
	enableHistory: boolean;
	accentColor: string;
}

if (!app.isPackaged) {
	const baseUserData = app.getPath('userData');
	app.setPath('userData', path.join(baseUserData, 'dev'));
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'window-config.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const SETTINGS_WINDOW_CONFIG_PATH = path.join(app.getPath('userData'), 'settings-window-config.json');
const FILE_INDEX_PATH = path.join(app.getPath('userData'), 'file-index.txt');
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');

const DEFAULT_SEARCH_SHORTCUT = 'Alt+T';
const DEFAULT_SETTINGS_SHORTCUT = 'Alt+Shift+T';
const DEFAULT_THEME: AppSettings['theme'] = 'dark';
const DEFAULT_HISTORY_LIMIT = 5;
const HOTKEY_COOLDOWN_MS = 300;
const DEFAULT_SEARCH_TYPE_ID = 'all';
const WIN_CONTEXT_MENU_VERB_KEY = 'FileSearchAddToQuickList';
const WIN_CONTEXT_MENU_LABEL = '添加到FileSearch的快捷列表';

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let installedAppsCache: InstalledApp[] = [];
const fileIndex = new FileIndex({ cachePath: FILE_INDEX_PATH, maxEntries: 750_000 });
const userDirWatchers: Array<ReturnType<typeof watch>> = [];
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

async function getFileIconData(filePath: string) {
	const key = `file:${filePath}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string') return cached;
	let iconData = '';
	try {
		const ext = path.extname(filePath).toLowerCase();
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
			const icon = await app.getFileIcon(filePath);
			iconData = icon.toDataURL();
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
				(defaultSearchTypeIdRaw.startsWith('ext:') &&
					/^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
					customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
					? defaultSearchTypeIdRaw
					: DEFAULT_SEARCH_TYPE_ID;

			const baseTypeIds = ['all', 'file'];
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
				defaultSearchTypeId,
				customSearchTypes,
				searchTypeOrder,
				keepStateOnClose: Boolean(raw?.keepStateOnClose),
				enableHistory: raw?.enableHistory !== false,
				accentColor: typeof raw?.accentColor === 'string' ? raw.accentColor : '#38bdf8',
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
		searchTypeOrder: ['all', 'file'],
		keepStateOnClose: false,
		enableHistory: true,
		accentColor: '#38bdf8',
	};
}

function saveSettings(settings: AppSettings) {
	try {
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
	} catch {}
}

type HistoryItem = { name: string; path: string; type: string; lastUsed: number };

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

process.env.DIST = path.join(__dirname, '../dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

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
		transparent: true,
		hasShadow: true,
		skipTaskbar: true,
		resizable: false,
		alwaysOnTop: true,
		icon: path.join(process.env.VITE_PUBLIC || '', 'tray.png'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
		},
	});

	win.on('moved', () => {
		if (win) saveConfig(win.getBounds());
	});
	win.on('closed', () => {
		win = null;
	});

	// FLAG 点击空白处（窗口失去焦点）时隐藏
	win.on('blur', () => {
		if (win && !win.webContents.isDevToolsOpened()) {
			win.hide();
		}
	});

	if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL);
	else win.loadFile(path.join(process.env.DIST || '', 'index.html'));

	if (!useBounds) win.center();
}

function createSettingsWindow() {
	const config = loadSettingsWindowConfig();
	const bounds = config?.bounds;
	const width = 680;
	const height = 520;

	settingsWin = new BrowserWindow({
		width,
		height,
		x: typeof bounds?.x === 'number' ? bounds.x : undefined,
		y: typeof bounds?.y === 'number' ? bounds.y : undefined,
		frame: false,
		transparent: true,
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

	settingsWin.on('moved', () => {
		if (settingsWin) saveSettingsWindowConfig(settingsWin.getBounds());
	});
	settingsWin.on('resize', () => {
		if (settingsWin) saveSettingsWindowConfig(settingsWin.getBounds());
	});
	settingsWin.on('closed', () => {
		settingsWin = null;
	});

	if (VITE_DEV_SERVER_URL) {
		const u = new URL(VITE_DEV_SERVER_URL);
		u.searchParams.set('view', 'settings');
		settingsWin.loadURL(u.toString());
	} else {
		settingsWin.loadFile(path.join(process.env.DIST || '', 'index.html'), { query: { view: 'settings' } });
	}

	settingsWin.show();
	settingsWin.focus();
	settingsWin.webContents.send('settings-window-opened');
}

function startUserDirectoryWatchers() {
	const roots = [
		app.getPath('desktop'),
		app.getPath('documents'),
		app.getPath('downloads'),
	].filter((p) => typeof p === 'string' && p.trim());

	for (const root of roots) {
		if (!existsSync(root)) continue;
		try {
			const w = watch(root, { recursive: true }, (_eventType, filename) => {
				if (!filename) return;
				const fullPath = path.join(root, filename.toString());
				setTimeout(() => {
					try {
						if (!existsSync(fullPath)) return;
						const st = statSync(fullPath);
						fileIndex.ingestPath(fullPath, st.isDirectory());
					} catch {}
				}, 80);
			});
			userDirWatchers.push(w);
		} catch {}
	}
}

function openSearchWindow() {
	if (win && !win.isDestroyed()) {
		if (win.isVisible()) {
			win.focus();
			return;
		}

		win.show();
	win.focus();
	// reset-search 事件在渲染进程中根据 keepStateOnClose 设置决定是否真的重置
	win.webContents.send('reset-search');
	return;
}
win = null;
createWindow();
setTimeout(() => {
	win?.webContents.send('reset-search');
}, 60);
}

function toggleSearchWindow() {
if (win && !win.isDestroyed()) {
	if (win.isVisible()) win.hide();
	else openSearchWindow();
	return;
}
openSearchWindow();
}

function showSettingsWindow() {
	if (settingsWin && !settingsWin.isDestroyed()) {
		if (!settingsWin.isVisible()) settingsWin.show();
		settingsWin.focus();
		settingsWin.webContents.send('settings-window-opened');
		return;
	}
	settingsWin = null;
	createSettingsWindow();
}

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
		loadInstalledApps();
		await fileIndex.loadCache();
		buildStartMenuShortcutIndex();

		createWindow();
		void ensureWindowsAppContextMenu();
		try {
			handleAddToQuickListArgv(process.argv);
		} catch {}
		startUserDirectoryWatchers();
		ensureTray();
		app.setLoginItemSettings({ openAtLogin: loadSettings().autoStart, openAsHidden: true, path: app.getPath('exe') });
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
	BrowserWindow.fromWebContents(event.sender)?.hide();
});

ipcMain.handle('minimize-window', (event) => {
	BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle('resize-window', (event, height: number, width?: number) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	if (!w) return;
	const [currentWidth] = w.getSize();
	const nextWidth = width ?? currentWidth;
	
	// 如果宽度发生变化，且是从左侧拖拽（需要保持右侧不动），或者只是普通调整
	// 这里我们简单处理：如果是从 React 传来的 width，我们直接 setSize
	// 如果要实现左侧拖拽不位移，需要在 React 端计算好偏移并调用 setBounds
	w.setSize(Math.round(nextWidth), Math.round(height));
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

ipcMain.handle('save-settings', (_event, settings: AppSettings) => {
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
		(defaultSearchTypeIdRaw.startsWith('ext:') &&
			/^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
			customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
			? defaultSearchTypeIdRaw
			: DEFAULT_SEARCH_TYPE_ID;

	const baseTypeIds = ['all', 'file'];
	const customTypeIds = customSearchTypes.map((ext) => `ext:${ext}`);
	const allowedTypeIds = new Set<string>([...baseTypeIds, ...customTypeIds]);
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
		defaultSearchTypeId,
		customSearchTypes,
		searchTypeOrder,
		keepStateOnClose: Boolean(settings?.keepStateOnClose),
		enableHistory: settings?.enableHistory !== false,
		accentColor: typeof settings?.accentColor === 'string' ? settings.accentColor : '#38bdf8',
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
	saveSettings(next);
	// historyLimit 变化时裁剪历史
	const history = loadHistory();
	saveHistory(next.historyLimit > 0 ? history.filter((h) => isExistingTarget(h)).slice(0, next.historyLimit) : []);
	registerShortcuts();
	win?.webContents.send('settings-updated', next);
	settingsWin?.webContents.send('settings-updated', next);
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
		if (item?.name && item?.path) recordHistoryItem(item);

		const resolved = resolveAppId(item?.path);
		if (resolved.includes('\\') || resolved.includes('/')) await shell.openPath(resolved);
		else await shell.openExternal(`shell:AppsFolder\\${resolved}`);
		BrowserWindow.fromWebContents(event.sender)?.hide();
		return true;
	} catch {
		return false;
	}
});

ipcMain.handle('open-app', async (event, target: string) => {
	try {
		const resolved = resolveAppId(target);
		if (resolved.includes('\\') || resolved.includes('/')) await shell.openPath(resolved);
		else await shell.openExternal(`shell:AppsFolder\\${resolved}`);
		BrowserWindow.fromWebContents(event.sender)?.hide();
		return true;
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

ipcMain.handle('rebuild-file-index', async () => {
	await fileIndex.rebuild();
	return fileIndex.getStatus();
});

ipcMain.handle('search-files', async (event, query: string, options?: { searchTypeId?: string }) => {
	if (!query || query.trim().length < 2) return { results: [], isIndexing: fileIndex.getStatus().isIndexing };

	const lowerQuery = query.trim().toLowerCase();
	const aliases: Record<string, string[]> = {
		wechat: ['wechat', 'weixin', '微信'],
		微信: ['wechat', 'weixin', '微信'],
		google: ['google', 'chrome'],
		chrome: ['google', 'chrome'],
		edge: ['edge', 'microsoft edge'],
	};
	const keywords = aliases[lowerQuery] || [lowerQuery];

	const searchTypeId = typeof options?.searchTypeId === 'string' ? options.searchTypeId : 'all';
	const extFilter = searchTypeId.startsWith('ext:') ? searchTypeId.slice(4).toLowerCase() : '';

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
				score: 10_000,
			});
		}
		return results;
	})();

	const fileSearch = fileIndex.search(query, 500); // 增加搜索结果上限

	// 预过滤文件，避免为不需要的文件提取图标
	const filteredFiles = fileSearch.results.filter((r) => {
		if (searchTypeId === 'file' && r.isDirectory) return false;
		if (searchTypeId === 'folder' && !r.isDirectory) return false;
		if (extFilter && (r.isDirectory || path.extname(r.path).toLowerCase() !== extFilter)) return false;
		return existsSync(r.path);
	});

	// 取前 100 个立即返回（提高初始展示数量）
	const first100Files = filteredFiles.slice(0, 100);
	const remainingFiles = filteredFiles.slice(100); // 后续结果通过后台发送

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

	let combined = [...appResults, ...first100Results];
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
					event.sender.send('more-results', { query, results: backgroundResults });
				}
				// 给一点喘息时间
				await new Promise(resolve => setTimeout(resolve, 50));
			}
		})();
	}

	return { 
		results: merged, 
		isIndexing: fileSearch.isIndexing,
		hasMore: remainingFiles.length > 0 
	};
});
