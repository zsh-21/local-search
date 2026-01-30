import { app, BrowserWindow, globalShortcut, ipcMain, shell, Tray, Menu, dialog, screen } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let installedAppsCache: InstalledApp[] = [];
const fileIndex = new FileIndex({ cachePath: FILE_INDEX_PATH, maxEntries: 750_000 });

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
			};
		}
	} catch {}
	return {
		autoStart: false,
		searchShortcut: DEFAULT_SEARCH_SHORTCUT,
		settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
		theme: DEFAULT_THEME,
		historyLimit: DEFAULT_HISTORY_LIMIT,
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

function isExistingTarget(target: { path: string; type?: string }) {
	const p = target.path;
	if (!p) return false;
	if (target.type === 'app') return true;
	const resolved = resolveAppId(p);
	if (!resolved.includes('\\') && !resolved.includes('/')) return true;
	return existsSync(resolved);
}

function recordHistoryItem(item: { name: string; path: string; type?: string }) {
	if (!item?.name || !item?.path) return;
	if (!isExistingTarget(item)) return;

	const now = Date.now();
	const current = loadHistory();
	const next: HistoryItem[] = [
		{ name: item.name, path: item.path, type: item.type || 'file', lastUsed: now },
		...current.filter((h) => h.path !== item.path),
	].filter((h) => isExistingTarget(h));

	const limit = loadSettings().historyLimit;
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
	const loginSettings = app.getLoginItemSettings();
	const startHidden = Boolean(loginSettings.wasOpenedAtLogin);
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
		show: !startHidden,
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

	// 点击空白处（窗口失去焦点）时隐藏
	win.on('blur', () => {
		if (win && !win.webContents.isDevToolsOpened()) {
			win.hide();
		}
	});

	if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL);
	else win.loadFile(path.join(process.env.DIST || '', 'index.html'));

	if (!useBounds) win.center();
	if (!startHidden) {
		win.show();
		win.focus();
	}
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

function openSearchWindow() {
	if (win && !win.isDestroyed()) {
		win.show();
		win.focus();
		win.webContents.send('reset-search');
		return;
	}
	win = null;
	createWindow();
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

	const okSearch = globalShortcut.register(settings.searchShortcut, () => toggleSearchWindow());
	const okSettings = globalShortcut.register(settings.settingsShortcut, () => showSettingsWindow());

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
	app.on('second-instance', () => {
		openSearchWindow();
	});

	app.whenReady().then(async () => {
		loadInstalledApps();
		await fileIndex.loadCache();

		createWindow();
		ensureTray();
		app.setLoginItemSettings({ openAtLogin: loadSettings().autoStart, openAsHidden: true, path: app.getPath('exe') });
		registerShortcuts();

		void fileIndex.buildIfEmpty();
	});
}

app.on('will-quit', () => {
	globalShortcut.unregisterAll();
});

ipcMain.handle('hide-window', (event) => {
	BrowserWindow.fromWebContents(event.sender)?.hide();
});

ipcMain.handle('resize-window', (event, height: number) => {
	const w = BrowserWindow.fromWebContents(event.sender);
	if (!w) return;
	const [width] = w.getSize();
	w.setSize(width, height);
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
	};

	if (next.searchShortcut === next.settingsShortcut) return { ok: false, message: '两个快捷键不能相同' };

	globalShortcut.unregisterAll();
	const okSearch = globalShortcut.register(next.searchShortcut, () => toggleSearchWindow());
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
			let iconData = '';
			try {
				if (h.type !== 'app') {
					const resolved = resolveAppId(h.path);
					if (existsSync(resolved)) {
						const icon = await app.getFileIcon(resolved);
						iconData = icon.toDataURL();
					}
				}
			} catch {}
			return { name: h.name, path: h.path, type: h.type, icon: iconData };
		})
	);

	return { results };
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

ipcMain.handle('search-files', async (_event, query: string) => {
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

	const appResults = await (async () => {
		const results: Array<{ name: string; path: string; type: string; icon?: string; score: number }> = [];
		for (const appItem of installedAppsCache) {
			const nameLower = appItem.Name.toLowerCase();
			if (!keywords.some((k) => nameLower.includes(k))) continue;

			let iconData = '';
			try {
				const resolved = resolveAppId(appItem.AppID);
				if (resolved.includes('\\') || resolved.includes('/')) {
					const icon = await app.getFileIcon(resolved);
					iconData = icon.toDataURL();
				}
			} catch {}

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

	const fileSearch = fileIndex.search(query, 40);

	const fileResults = (await Promise.all(
		fileSearch.results.slice(0, 30).map(async (r) => {
			if (!existsSync(r.path)) return null;
			let iconData = '';
			try {
				const icon = await app.getFileIcon(r.path);
				iconData = icon.toDataURL();
			} catch {}
			return {
				name: r.name,
				path: r.path,
				type: r.isDirectory ? 'folder' : 'file',
				icon: iconData,
				score: r.score,
			};
		})
	)).filter((x): x is { name: string; path: string; type: string; icon: string; score: number } => x !== null);

	const merged = [...appResults, ...fileResults]
		.sort((a, b) => (b.score || 0) - (a.score || 0))
		.slice(0, 20)
		.map(({ score, ...rest }) => rest);

	return { results: merged, isIndexing: fileSearch.isIndexing };
});
