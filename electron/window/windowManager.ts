import { app, BrowserWindow, screen, shell, globalShortcut } from 'electron';
import path from 'node:path';
import {
  loadConfig,
  saveConfig,
  loadSettingsWindowConfig,
  saveSettingsWindowConfig,
  loadSettings,
  AppSettings,
  DEFAULT_SEARCH_SHORTCUT,
  DEFAULT_SETTINGS_SHORTCUT,
} from '../config/settings';
import {
  DEFAULT_SETTINGS,
  SEARCH_WINDOW_INITIAL_HEIGHT,
  SETTINGS_WINDOW_INITIAL_HEIGHT,
  SETTINGS_WINDOW_INITIAL_WIDTH,
  SETTINGS_WINDOW_MIN_HEIGHT,
  SETTINGS_WINDOW_MIN_WIDTH,
  WINDOW_BACKGROUND_COLOR,
} from '../constants/initialValues';
import { fileIndex } from '../file/indexService';
import { reconcileRecentIndex } from '../file/watcher';
import { recordHistoryItem } from '../history/history';
import { registerShortcuts as registerGlobalShortcuts } from '../app/shortcuts';

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

let ignoreSearchBlurUntil = 0;
let searchHideTimer: NodeJS.Timeout | null = null;
let searchWasFocusedSinceShow = false;
let settingsReadyToShow = false;
let settingsShowFallbackTimer: NodeJS.Timeout | null = null;
let searchAllowBlurHide = false;
let searchVisibleAt = 0;

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

export function getSearchWindow() {
  return win;
}

export function getSettingsWindow() {
  return settingsWin;
}

export function createWindow() {
  const config = loadConfig();
  const bounds = config?.bounds;
  const settings = loadSettings();
  // 窗口初始尺寸已抽离：便于你统一调整首次展示的高度与默认宽度
  const width =
    typeof settings?.searchWindowInitialWidth === 'number'
      ? settings.searchWindowInitialWidth
      : DEFAULT_SETTINGS.searchWindowInitialWidth;
  const height = SEARCH_WINDOW_INITIAL_HEIGHT;

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
    backgroundColor: WINDOW_BACKGROUND_COLOR,
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

export function createSettingsWindow() {
  const config = loadSettingsWindowConfig();
  const bounds = config?.bounds;
  // 设置窗口初始尺寸已抽离：便于你统一调整设置面板的默认大小与最小限制
  const width = SETTINGS_WINDOW_INITIAL_WIDTH;
  const height = SETTINGS_WINDOW_INITIAL_HEIGHT;

  settingsReadyToShow = false;
  settingsWin = new BrowserWindow({
    width,
    height,
    x: typeof bounds?.x === 'number' ? bounds.x : undefined,
    y: typeof bounds?.y === 'number' ? bounds.y : undefined,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    roundedCorners: true,
    hasShadow: true,
    skipTaskbar: false,
    resizable: true,
    minWidth: SETTINGS_WINDOW_MIN_WIDTH,
    minHeight: SETTINGS_WINDOW_MIN_HEIGHT,
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

export function openSearchWindow() {
  const settings = loadSettings();
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const initW = clamp(
    typeof settings?.searchWindowInitialWidth === 'number' ? settings.searchWindowInitialWidth : 720,
    450,
    1000,
  );
  const initH = 76;
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

    // 未开启“保留运行状态”时，每次呼出面板都应用“初始宽高”配置（保留状态则尊重用户上次调整）
    if (!settings.keepStateOnClose) {
      try {
        win.setContentSize(Math.round(initW), Math.round(initH));
      } catch {}
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

export function toggleSearchWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) {
      try {
        win.webContents.send('search-window-hidden');
      } catch {}
      fileIndex.setSearchWindowVisible(false);
      win.hide();
    } else openSearchWindow();
    return;
  }
  openSearchWindow();
}

export function hideSearchWindow() {
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

export function showSettingsWindow() {
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

export async function handleQuickItemPicked(targetPath: string) {
  try {
    const ext = path.extname(targetPath).toLowerCase();
    const name = path.basename(targetPath, ext) || path.basename(targetPath) || '快捷项';
    recordHistoryItem({ name, path: targetPath, type: 'file' });
    win?.webContents.send('reset-search');
  } catch {}
}

export function registerShortcutsForSettings(s: { searchShortcut: string; settingsShortcut: string }) {
  registerGlobalShortcuts({
    getSearchShortcut: () => s.searchShortcut,
    getSettingsShortcut: () => s.settingsShortcut,
    openSearchWindow,
    showSettingsWindow,
  });
}

export function registerShortcutsFromDisk() {
  const s = loadSettings();
  registerShortcutsForSettings({ searchShortcut: s.searchShortcut, settingsShortcut: s.settingsShortcut });
}

// Helper to expose internal state setter (for IPC)
export function setSearchAllowBlurHide(allow: boolean) {
  searchAllowBlurHide = allow;
}

export function setSettingsReadyToShow(ready: boolean) {
  settingsReadyToShow = ready;
}

export function clearSettingsShowFallbackTimer() {
  if (settingsShowFallbackTimer) {
    clearTimeout(settingsShowFallbackTimer);
    settingsShowFallbackTimer = null;
  }
}

export function closeAllWindows() {
  win = null;
}
