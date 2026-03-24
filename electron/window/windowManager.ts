import { app, BrowserWindow, screen } from 'electron';
import path from 'node:path';
import {
  loadConfig,
  saveConfig,
  loadSettingsWindowConfig,
  saveSettingsWindowConfig,
  loadSettings,
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
import { refreshBootstrapHistory } from '../app/bootstrapState';

let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let searchReadyToShow = false;
let searchViewWarmedUp = false;
let searchMainFrameReady = false;
let searchFallbackReady = false;
let pendingSearchShow = false;
let searchShowFallbackTimer: NodeJS.Timeout | null = null;

let ignoreSearchBlurUntil = 0;
let searchHideTimer: NodeJS.Timeout | null = null;
let searchWasFocusedSinceShow = false;
let settingsReadyToShow = false;
let settingsShowFallbackTimer: NodeJS.Timeout | null = null;
let searchAllowBlurHide = false;
let searchVisibleAt = 0;
let searchFirstShowCentered = false;
let settingsFirstShowCentered = false;

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const SEARCH_SHOW_FALLBACK_TIMEOUT_MS = 1200;
const SEARCH_BLUR_IGNORE_AFTER_SHOW_MS = 350;
const SEARCH_MIN_VISIBLE_BEFORE_BLUR_HIDE_MS = 220;
const SEARCH_BLUR_HIDE_DELAY_MS = 80;

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

function clearSearchShowFallbackTimer() {
  if (searchShowFallbackTimer) {
    clearTimeout(searchShowFallbackTimer);
    searchShowFallbackTimer = null;
  }
}

function ensureSearchWindowCenteredOnFirstShow() {
  if (searchFirstShowCentered) return;
  if (!win || win.isDestroyed()) return;
  try {
    win.center();
  } catch {}
  searchFirstShowCentered = true;
}

export function ensureSettingsWindowCenteredOnFirstShow() {
  if (settingsFirstShowCentered) return;
  if (!settingsWin || settingsWin.isDestroyed()) return;
  try {
    settingsWin.center();
  } catch {}
  settingsFirstShowCentered = true;
}

function showSearchWindowIfReady() {
  if (!pendingSearchShow) return;
  // 首次显示必须满足“主框架已完成加载”，避免先 show 再渲染导致白屏。
  if (!searchMainFrameReady) return;
  // 优先等待渲染层握手；仅在超时兜底触发后才允许绕过握手直接显示。
  if (!searchReadyToShow && !searchFallbackReady) return;
  showSearchWindowImmediately();
}

function showSearchWindowImmediately() {
  if (!win || win.isDestroyed()) return;
  ensureSearchWindowCenteredOnFirstShow();
  pendingSearchShow = false;
  searchFallbackReady = false;
  clearSearchShowFallbackTimer();
  win.show();
  win.focus();
  searchVisibleAt = Date.now();
  setTimeout(() => {
    if (win && !win.isDestroyed() && win.isVisible()) win.focus();
  }, 80);
}

function prepareSearchShowFallback() {
  // 冷路径兜底：首次加载或页面重载时，避免握手异常导致窗口一直不可见。
  clearSearchShowFallbackTimer();
  searchFallbackReady = false;
  searchShowFallbackTimer = setTimeout(() => {
    if (!pendingSearchShow) return;
    // 仅标记“兜底可显示”，真正 show 仍由 showSearchWindowIfReady 判断主框架是否已加载完成。
    searchFallbackReady = true;
    showSearchWindowIfReady();
  }, SEARCH_SHOW_FALLBACK_TIMEOUT_MS);
}

export function createWindow() {
  const config = loadConfig();
  const bounds = config?.bounds;
  const settings = loadSettings();
  // 窗口初始尺寸已抽离：便于统一调整首次展示高度与默认宽度。
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
    // 搜索窗口保留系统原生缩放能力，兼顾性能与交互一致性。
    resizable: true,
    minWidth: 450,
    maxWidth: 1000,
    // 无边框模式下启用原生边框命中区域，保留系统级拖拽与缩放手感。
    thickFrame: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 搜索面板保持置顶，避免被其它窗口遮挡导致“已呼出但不可见”的错觉。
    alwaysOnTop: true,
    // 允许首次点击直接聚焦窗口，减少首次交互额外点击。
    acceptFirstMouse: true,
    icon: path.join(process.env.VITE_PUBLIC || '', 'tray.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (!app.isPackaged) {
    // 开发环境快捷键：F12 打开或关闭 DevTools，生产环境不生效。
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
  win.on('will-resize', (event, newBounds) => {
    if (!win || win.isDestroyed()) return;
    const current = win.getBounds();
    if (newBounds.height === current.height) return;
    // 禁止用户拖拽调整搜索面板高度，仅允许宽度变化
    event.preventDefault();
    win.setBounds({
      x: newBounds.x,
      y: newBounds.y,
      width: newBounds.width,
      height: current.height,
    });
  });
  win.on('closed', () => {
    clearSearchShowFallbackTimer();
    searchReadyToShow = false;
    searchViewWarmedUp = false;
    searchMainFrameReady = false;
    searchFallbackReady = false;
    win = null;
  });

  win.webContents.on('did-start-loading', () => {
    // 页面真正重载时重置握手状态，防止沿用上一轮可见状态导致误显示。
    searchReadyToShow = false;
    searchViewWarmedUp = false;
    searchMainFrameReady = false;
    searchFallbackReady = false;
  });
  win.webContents.on('did-finish-load', () => {
    // 主框架加载完成后再尝试显示窗口，避免首开出现空白窗口。
    searchMainFrameReady = true;
    showSearchWindowIfReady();
  });

  win.on('focus', () => {
    searchWasFocusedSinceShow = true;
    if (searchHideTimer) {
      clearTimeout(searchHideTimer);
      searchHideTimer = null;
    }
  });

  // 面板失焦时延迟隐藏：保留防误关保护，同时缩短关闭体感延迟。
  win.on('blur', () => {
    if (!searchAllowBlurHide) return;
    if (Date.now() < ignoreSearchBlurUntil) return;
    if (Date.now() - searchVisibleAt < SEARCH_MIN_VISIBLE_BEFORE_BLUR_HIDE_MS) return;
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
    }, SEARCH_BLUR_HIDE_DELAY_MS);
  });

  win.removeMenu();
  if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(process.env.DIST || '', 'index.html'));

  if (!useBounds) win.center();
}

export function createSettingsWindow() {
  const config = loadSettingsWindowConfig();
  const bounds = config?.bounds;
  // 设置窗口初始尺寸已抽离：便于统一调整默认大小与最小限制。
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
    // 设置窗口允许调整大小，并通过最小宽高避免布局错乱。
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
    // 开发环境快捷键：F12 打开或关闭 DevTools，生产环境不生效。
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
      ensureSettingsWindowCenteredOnFirstShow();
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
    // 打开事件统一由主进程发出，保证渲染状态与窗口生命周期一致。
    if (!win || win.isDestroyed()) return;
    try {
      if (settings.keepStateOnClose) win.webContents.send('search-window-opened');
      else win.webContents.send('reset-search');
    } catch {}
  };
  const showWhenReady = () => {
    // 冷路径下等待页面首帧完成后再显示，避免首次渲染白屏。
    // 若页面已完成加载则立即进入显示流程。
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    const doOpen = () => {
      if (!win || win.isDestroyed()) return;
      sendOpenEvent();
      showSearchWindowIfReady();
    };
    if (typeof wc?.isLoading === 'function' && wc.isLoading()) {
      wc.once('did-finish-load', () => doOpen());
      return;
    }
    doOpen();
  };
  if (win && !win.isDestroyed()) {
    if (win.isVisible()) {
      win.focus();
      return;
    }

    // 非“保留状态”模式下，每次呼出恢复初始宽高，避免遗留上次窗口尺寸。
    if (!settings.keepStateOnClose) {
      try {
        win.setContentSize(Math.round(initW), Math.round(initH));
      } catch {}
    }
    fileIndex.setSearchWindowVisible(true);
    searchWasFocusedSinceShow = false;
    searchAllowBlurHide = false;
    const wc = win.webContents;
    const isRendererLoading = typeof wc?.isLoading === 'function' && wc.isLoading();
    // 热路径必须同时满足“主框架已加载 + 渲染已握手”，避免冷启动时直接 show 出现白屏。
    const canUseHotPath = searchViewWarmedUp && searchMainFrameReady && !isRendererLoading;
    // 已预热窗口走热路径秒开；未预热或重载中则继续走冷路径。
    if (canUseHotPath) {
      pendingSearchShow = false;
      searchFallbackReady = false;
      clearSearchShowFallbackTimer();
    } else {
      pendingSearchShow = true;
      if (!searchReadyToShow) prepareSearchShowFallback();
    }
    if (searchHideTimer) {
      clearTimeout(searchHideTimer);
      searchHideTimer = null;
    }
    ignoreSearchBlurUntil = Date.now() + SEARCH_BLUR_IGNORE_AFTER_SHOW_MS;
    if (canUseHotPath) {
      sendOpenEvent();
      showSearchWindowImmediately();
    } else {
      showWhenReady();
    }
    void reconcileRecentIndex().catch(() => {});
    return;
  }
  win = null;
  createWindow();
  fileIndex.setSearchWindowVisible(true);
  // 新建窗口默认走冷路径，等待渲染握手并保留超时兜底。
  pendingSearchShow = true;
  searchReadyToShow = false;
  searchMainFrameReady = false;
  searchFallbackReady = false;
  prepareSearchShowFallback();
  // 首次冷启动等待首帧就绪后再显示，避免空白闪烁。
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
      if (settingsReadyToShow) {
        ensureSettingsWindowCenteredOnFirstShow();
        settingsWin.show();
      }
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
    // 快捷项命中后同步刷新历史快照，避免下次呼出仍看到旧历史。
    const results = await refreshBootstrapHistory();
    win?.webContents.send('history-updated', { results });
    settingsWin?.webContents.send('history-updated', { results });
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

export function setSearchViewReady(ready: boolean) {
  // 渲染层握手完成后标记为已预热，后续呼出可直接走热路径。
  searchReadyToShow = ready;
  if (ready) searchFallbackReady = false;
  if (ready) {
    searchViewWarmedUp = true;
    showSearchWindowIfReady();
  }
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
  searchReadyToShow = false;
  searchViewWarmedUp = false;
  searchMainFrameReady = false;
  searchFallbackReady = false;
  pendingSearchShow = false;
  clearSearchShowFallbackTimer();
}
