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
	shortcut: string;
}

if (!app.isPackaged) {
	const baseUserData = app.getPath('userData');
	app.setPath('userData', path.join(baseUserData, 'dev'));
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'window-config.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const FILE_INDEX_PATH = path.join(app.getPath('userData'), 'file-index.txt');

let win: BrowserWindow | null = null;
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
		if (existsSync(SETTINGS_PATH)) return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
	} catch {}
	return { autoStart: false, shortcut: 'Alt+S' };
}

function saveSettings(settings: AppSettings) {
	try {
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
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

function ensureTray() {
	try {
		const iconPath = path.join(process.env.VITE_PUBLIC || '', 'tray.png');
		tray = new Tray(iconPath);
		const contextMenu = Menu.buildFromTemplate([
			{
				label: '显示搜索框',
				click: () => {
					if (win && !win.isDestroyed()) {
						win.show();
						win.focus();
						win.webContents.send('reset-search');
					} else {
						createWindow();
					}
				},
			},
			{
				label: '设置',
				click: () => {
					if (!win || win.isDestroyed()) createWindow();
					win?.show();
					win?.focus();
					win?.webContents.send('open-settings');
				},
			},
			{ type: 'separator' },
			{ label: '退出', click: () => app.quit() },
		]);
		tray.setToolTip('File Search');
		tray.setContextMenu(contextMenu);
		tray.on('click', () => {
			if (!win || win.isDestroyed()) {
				createWindow();
				return;
			}
			if (win.isVisible()) win.hide();
			else {
				win.show();
				win.focus();
				win.webContents.send('reset-search');
			}
		});
	} catch {}
}

function registerShortcuts() {
	globalShortcut.unregisterAll();
	const settings = loadSettings();
	let lastToggleTime = 0;
	const handler = () => {
		const now = Date.now();
		if (now - lastToggleTime < 200) return;
		lastToggleTime = now;

		if (!win || win.isDestroyed()) {
			win = null;
			createWindow();
			return;
		}

		if (win.isVisible()) {
			win.hide();
			return;
		}

		const b = win.getBounds();
		if (!isRectVisibleOnAnyDisplay({ x: b.x, y: b.y, width: b.width, height: b.height })) {
			win.center();
		}

		const bounds = win.getBounds();
		win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width || 720, height: 76 });
		win.show();
		win.setAlwaysOnTop(true);
		win.focus();
		win.webContents.send('reset-search');
	};

	const ok = globalShortcut.register(settings.shortcut, handler);

	if (!ok && settings.shortcut !== 'Alt+S') {
		const fallback = globalShortcut.register('Alt+S', handler);
		dialog.showErrorBox(
			'快捷键注册失败',
			fallback
				? `无法注册 ${settings.shortcut}，可能已被其他软件占用。\n已回退为 Alt+S。`
				: `无法注册 ${settings.shortcut}（且 Alt+S 也注册失败）。\n请关闭占用快捷键的软件后重试。`
		);
	}
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
		if (!win || win.isDestroyed()) return;
		if (!win.isVisible()) win.show();
		win.focus();
	});

	app.whenReady().then(async () => {
		loadInstalledApps();
		await fileIndex.loadCache();

		createWindow();
		ensureTray();
		app.setLoginItemSettings({ openAtLogin: loadSettings().autoStart, path: app.getPath('exe') });
		registerShortcuts();

		void fileIndex.buildIfEmpty();
	});
}

app.on('will-quit', () => {
	globalShortcut.unregisterAll();
});

ipcMain.handle('hide-window', () => {
	win?.hide();
});

ipcMain.handle('resize-window', (_event, height: number) => {
	if (!win) return;
	const [width] = win.getSize();
	win.setSize(width, height);
});

ipcMain.handle('get-settings', () => {
	return loadSettings();
});

ipcMain.handle('save-settings', (_event, settings: AppSettings) => {
	const next: AppSettings = {
		autoStart: Boolean(settings?.autoStart),
		shortcut: typeof settings?.shortcut === 'string' && settings.shortcut.trim() ? settings.shortcut.trim() : 'Alt+S',
	};

	const previous = loadSettings();

	if (next.shortcut !== previous.shortcut) {
		globalShortcut.unregisterAll();
		const ok = globalShortcut.register(next.shortcut, () => {
			if (!win || win.isDestroyed()) {
				win = null;
				createWindow();
				return;
			}
			if (win.isVisible()) win.hide();
			else {
				win.show();
				win.focus();
				win.webContents.send('reset-search');
			}
		});

		if (!ok) {
			registerShortcuts();
			return { ok: false, message: '快捷键已被占用' };
		}
	}

	app.setLoginItemSettings({
		openAtLogin: next.autoStart,
		openAsHidden: true,
		path: app.getPath('exe'),
	});
	saveSettings(next);
	registerShortcuts();
	return { ok: true };
});

ipcMain.handle('open-app', async (_event, target: string) => {
	try {
		const resolved = resolveAppId(target);
		if (resolved.includes('\\') || resolved.includes('/')) await shell.openPath(resolved);
		else await shell.openExternal(`shell:AppsFolder\\${resolved}`);
		win?.hide();
		return true;
	} catch {
		return false;
	}
});

ipcMain.handle('open-folder', async (_event, filePath: string) => {
	try {
		const resolved = resolveAppId(filePath);
		if (resolved.includes('\\') || resolved.includes('/')) {
			shell.showItemInFolder(resolved);
		} else {
			// For AppIDs, just open the apps folder
			await shell.openExternal(`shell:AppsFolder`);
		}
		win?.hide();
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

	const fileResults = await Promise.all(
		fileSearch.results.slice(0, 30).map(async (r) => {
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
	);

	const merged = [...appResults, ...fileResults]
		.sort((a, b) => (b.score || 0) - (a.score || 0))
		.slice(0, 20)
		.map(({ score, ...rest }) => rest);

	return { results: merged, isIndexing: fileSearch.isIndexing };
});
