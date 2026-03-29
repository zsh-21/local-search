import { ipcMain, BrowserWindow, dialog, screen } from 'electron';
import { getDeviceId } from '../config/deviceId';
import {
  setSearchAllowBlurHide,
  setSearchViewReady,
  setSettingsReadyToShow,
  clearSettingsShowFallbackTimer,
  ensureSettingsWindowCenteredOnFirstShow,
  showSettingsWindow,
  getSettingsWindow,
  getSearchWindow,
} from '../window/windowManager';
import { registerShortcutsForSettings } from '../window/windowManager';
import { loadSettings, saveSettings, AppSettings } from '../config/settings';
import { fileIndex } from '../file/indexService';
import { clearHistory, deleteHistoryItemFunc } from '../history/history';
import {
  loadCalcHistory,
  recordCalcHistoryItem,
  deleteCalcHistoryItem,
} from '../history/calcHistory';
import { resolveAppId } from '../win/resolveAppId';
import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { getBootstrapState, refreshBootstrapHistory, setBootstrapSettings } from '../app/bootstrapState';
import { registerSearchOpenIpcHandlers } from './searchOpenHandlers';
import { quoteCmdArg, sudoExec } from './adminExec';
import {
  estimateIndexProgress,
  getLastKnownIndexProgressFallback,
  rememberLastKnownIndexProgress,
} from './indexProgress';
import {
  IPC_CLEAR_HISTORY,
  IPC_DELETE_CALC_HISTORY_ITEM,
  IPC_DELETE_HISTORY_ITEM,
  IPC_GET_APP_BOOTSTRAP_STATE,
  IPC_GET_CALC_HISTORY,
  IPC_GET_DEVICE_ID,
  IPC_GET_HISTORY,
  IPC_GET_IMAGE_DATA_URL,
  IPC_GET_INDEX_PROGRESS,
  IPC_GET_SETTINGS,
  IPC_HIDE_WINDOW,
  IPC_LOGIN_REQUEST,
  IPC_MINIMIZE_WINDOW,
  IPC_OPEN_SETTINGS_WINDOW,
  IPC_RECORD_CALC_HISTORY_ITEM,
  IPC_RESIZE_WINDOW,
  IPC_SAVE_SETTINGS,
  IPC_SEARCH_VIEW_READY,
  IPC_SELECT_AVATAR_IMAGE,
  IPC_SELECT_BACKGROUND_IMAGE,
  IPC_SET_SEARCH_BLUR_HIDE_ENABLED,
  IPC_SETTINGS_VIEW_READY,
  IPC_TOGGLE_MAXIMIZE,
  IPC_EVENT_CALC_HISTORY_UPDATED,
  IPC_EVENT_HISTORY_UPDATED,
  IPC_EVENT_SEARCH_WINDOW_HIDDEN,
  IPC_EVENT_SETTINGS_UPDATED,
  IPC_EVENT_SETTINGS_WINDOW_OPENED,
} from '../../shared/ipc/channels';

/** 错误对象只读取 message，避免把未知异常强制当成宽泛类型。 */
type ErrorLike = {
  message?: unknown;
};

/** 统一提取错误信息，保证各处兜底文案一致。 */
function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as ErrorLike).message;
    return typeof message === 'string' && message ? message : fallback;
  }
  return fallback;
}

/** 历史广播统一走启动快照缓存，保证搜索页与设置页拿到同一份预热结果。 */
async function broadcastHistoryUpdated() {
  const results = await refreshBootstrapHistory();
  try {
    getSearchWindow()?.webContents.send(IPC_EVENT_HISTORY_UPDATED, { results });
  } catch {}
  try {
    getSettingsWindow()?.webContents.send(IPC_EVENT_HISTORY_UPDATED, { results });
  } catch {}
  return { results };
}

/** 计算历史与文件历史分离广播，避免两类数据互相污染。 */
function broadcastCalcHistoryUpdated() {
  const results = loadCalcHistory();
  try {
    getSearchWindow()?.webContents.send(IPC_EVENT_CALC_HISTORY_UPDATED, { results });
  } catch {}
  try {
    getSettingsWindow()?.webContents.send(IPC_EVENT_CALC_HISTORY_UPDATED, { results });
  } catch {}
  return { results };
}

export function registerIpcHandlers() {
  ipcMain.handle(IPC_GET_DEVICE_ID, () => {
    return getDeviceId();
  });

  ipcMain.handle(IPC_SEARCH_VIEW_READY, (_event, payload?: { allowBlurHide?: boolean }) => {
    /** 搜索页握手时同步当前置顶策略：置顶时关闭失焦自动隐藏，取消置顶后恢复。 */
    setSearchAllowBlurHide(payload?.allowBlurHide !== false);
    /** 渲染层就绪握手：主进程收到后才允许显示搜索窗，避免首屏白屏。 */
    setSearchViewReady(true);
    return { ok: true };
  });

  ipcMain.handle(IPC_SET_SEARCH_BLUR_HIDE_ENABLED, (_event, allow: boolean) => {
    /** 渲染层动态切换失焦隐藏能力：固定面板期间关闭，解除固定后恢复。 */
    setSearchAllowBlurHide(Boolean(allow));
    return { ok: true };
  });

  ipcMain.handle(IPC_SETTINGS_VIEW_READY, (event) => {
    try {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w) return { ok: false };
      const settingsWin = getSettingsWindow();
      if (settingsWin && w.id !== settingsWin.id) return { ok: false };
      clearSettingsShowFallbackTimer();
      setSettingsReadyToShow(true);
      if (!w.isVisible()) {
        ensureSettingsWindowCenteredOnFirstShow();
        w.show();
      }
      w.focus();
      w.webContents.send(IPC_EVENT_SETTINGS_WINDOW_OPENED);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_LOGIN_REQUEST, async (_event, { url, options }) => {
    try {
      const response = await fetch(url, options);
      const data = await response.json();
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        status: 500,
        statusText: getErrorMessage(error, '请求失败'),
        data: null,
      };
    }
  });

  ipcMain.handle(IPC_HIDE_WINDOW, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    try {
      w.webContents.send(IPC_EVENT_SEARCH_WINDOW_HIDDEN);
    } catch {}
    fileIndex.setSearchWindowVisible(false);
    w.hide();
  });

  ipcMain.handle(IPC_MINIMIZE_WINDOW, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle(
    IPC_RESIZE_WINDOW,
    (
      event,
      height: number,
      width?: number,
      limits?: { minHeight?: number; maxHeight?: number },
    ) => {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w) return;
      const settings = loadSettings();
      /** 内容区尺寸统一走主进程裁剪，避免渲染层与原生拖拽边界不一致。 */
      const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
      const [currentWidth] = w.getContentSize();
      const maxH =
        typeof settings?.searchWindowMaxHeight === 'number'
          ? settings.searchWindowMaxHeight
          : 760;
      const nextWidth = clamp(Math.round(width ?? currentWidth), 450, 1000);
      const displayMaxH = (() => {
        try {
          const d = screen.getDisplayMatching(w.getBounds());
          return d?.workAreaSize?.height;
        } catch {
          return undefined;
        }
      })();
      const upper = Math.max(
        200,
        Math.round(Math.min(Math.round(maxH), displayMaxH ?? Math.round(maxH))),
      );
      /** 高度上下限由渲染层实时提供，主进程统一兜底 clamp。 */
      const requestedMaxHeight =
        typeof limits?.maxHeight === 'number' ? Math.round(limits.maxHeight) : upper;
      const boundedMaxHeight = clamp(requestedMaxHeight, 76, upper);
      const requestedMinHeight =
        typeof limits?.minHeight === 'number' ? Math.round(limits.minHeight) : 76;
      const boundedMinHeight = clamp(requestedMinHeight, 76, boundedMaxHeight);
      w.setMinimumSize(450, boundedMinHeight);
      w.setMaximumSize(1000, boundedMaxHeight);
      const nextHeight = clamp(Math.round(height), boundedMinHeight, boundedMaxHeight);
      w.setContentSize(nextWidth, nextHeight);
    },
  );

  ipcMain.handle(IPC_OPEN_SETTINGS_WINDOW, () => {
    showSettingsWindow();
  });

  ipcMain.handle(IPC_TOGGLE_MAXIMIZE, (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return { maximized: false };
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return { maximized: w.isMaximized() };
  });

  ipcMain.handle(IPC_GET_SETTINGS, () => {
    return getBootstrapState().settings;
  });

  /** 启动快照一次返回设置与历史，renderer 启动阶段只需要打一趟 IPC。 */
  ipcMain.handle(IPC_GET_APP_BOOTSTRAP_STATE, () => {
    const snapshot = getBootstrapState();
    return {
      settings: snapshot.settings,
      history: snapshot.history,
    };
  });

  ipcMain.handle(IPC_GET_INDEX_PROGRESS, async () => {
    try {
      const status = await fileIndex.getStatus();
      const estimated = estimateIndexProgress(status ?? {});
      rememberLastKnownIndexProgress(estimated);
      return estimated;
    } catch {
      const fallback = getLastKnownIndexProgressFallback();
      if (fallback) return fallback;
      const snapshot = getBootstrapState();
      const estimated = estimateIndexProgress({
        isIndexing: snapshot.indexStatus?.isIndexing,
        indexedCount: 0,
      });
      rememberLastKnownIndexProgress(estimated);
      return estimated;
    }
  });

  ipcMain.handle(IPC_SELECT_BACKGROUND_IMAGE, async () => {
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
    } catch (error: unknown) {
      return { ok: false, message: getErrorMessage(error, '选择图片失败'), path: '' };
    }
  });

  ipcMain.handle(IPC_SELECT_AVATAR_IMAGE, async () => {
    try {
      /** 头像选择仅返回本地图片路径，渲染层通过 get-image-data-url 转为可展示 dataUrl。 */
      const result = await dialog.showOpenDialog({
        title: '选择头像图片',
        buttonLabel: '选择',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (result.canceled) return { ok: true, path: '' };
      const targetPath = result.filePaths?.[0] || '';
      return { ok: true, path: targetPath };
    } catch (error: unknown) {
      return { ok: false, message: getErrorMessage(error, '选择图片失败'), path: '' };
    }
  });

  ipcMain.handle(IPC_GET_IMAGE_DATA_URL, (_event, targetPath: string) => {
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

  ipcMain.handle(IPC_SAVE_SETTINGS, async (_event, settings: AppSettings) => {
    /** 先合并再落盘，保持旧配置字段继续生效。 */
    const next = { ...loadSettings(), ...settings };
    /** 保存设置并更新启动快照。 */
    saveSettings(next);
    setBootstrapSettings(next);
    /** 更新文件索引的忽略规则，保证新设置立刻生效。 */
    await fileIndex.setIgnoredPaths(next.ignoredPaths, next.preferredFileExtensions);
    /** 重新注册快捷键：使用静态 import，避免打包后运行期 require 路径失效。 */
    registerShortcutsForSettings({ searchShortcut: next.searchShortcut, settingsShortcut: next.settingsShortcut });
    /** 通知窗口刷新设置状态。 */
    const win = getSearchWindow();
    const settingsWin = getSettingsWindow();
    try {
      win?.webContents.send(IPC_EVENT_SETTINGS_UPDATED, next);
    } catch {}
    try {
      settingsWin?.webContents.send(IPC_EVENT_SETTINGS_UPDATED, next);
    } catch {}
    /** 历史受 enableHistory/historyLimit 影响：保存设置后同步刷新快照。 */
    await broadcastHistoryUpdated();
    /** 这里不额外触发全盘重建索引，沿用 watcher 过滤和增量 ingest 的即时生效路径。 */
    return { ok: true };
  });

  ipcMain.handle(IPC_GET_HISTORY, async () => {
    return { results: getBootstrapState().history };
  });

  ipcMain.handle(IPC_CLEAR_HISTORY, async () => {
    clearHistory();
    await broadcastHistoryUpdated();
    return { ok: true };
  });

  ipcMain.handle(IPC_DELETE_HISTORY_ITEM, async (_event, targetPath: string) => {
    deleteHistoryItemFunc(targetPath);
    await broadcastHistoryUpdated();
    return { ok: true };
  });

  ipcMain.handle(IPC_GET_CALC_HISTORY, async () => {
    return { results: loadCalcHistory() };
  });

  ipcMain.handle(
    IPC_RECORD_CALC_HISTORY_ITEM,
    async (_event, payload: { expression?: string; result?: string }) => {
      recordCalcHistoryItem({
        expression: typeof payload?.expression === 'string' ? payload.expression : '',
        result: typeof payload?.result === 'string' ? payload.result : '',
      });
      return broadcastCalcHistoryUpdated();
    },
  );

  ipcMain.handle(IPC_DELETE_CALC_HISTORY_ITEM, async (_event, expression: string) => {
    deleteCalcHistoryItem(expression);
    return broadcastCalcHistoryUpdated();
  });

  registerSearchOpenIpcHandlers({ broadcastHistoryUpdated, quoteCmdArg, sudoExec });
}
