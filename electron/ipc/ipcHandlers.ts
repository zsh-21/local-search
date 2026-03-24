import { ipcMain, BrowserWindow, dialog, screen, shell } from 'electron';
import { getDeviceId } from '../config/deviceId';
import {
  setSearchAllowBlurHide,
  setSearchViewReady,
  setSettingsReadyToShow,
  clearSettingsShowFallbackTimer,
  ensureSettingsWindowCenteredOnFirstShow,
  showSettingsWindow,
  openSearchWindow,
  getSettingsWindow,
  getSearchWindow,
  hideSearchWindow,
} from '../window/windowManager';
import { registerShortcutsForSettings } from '../window/windowManager';
import { loadSettings, saveSettings, AppSettings } from '../config/settings';
import { fileIndex, isIgnoredPathByCache } from '../file/indexService';
import { handleSearchFiles } from '../search/searchFilesHandler';
import {
  reconcileRecentIndex,
  recentIndex,
  normalizeRecentKey,
} from '../file/watcher';
import {
  loadHistoryStats,
  normalizeHistoryKey,
  normalizeExtKey,
  recordHistoryItem,
  clearHistory,
  deleteHistoryItemFunc,
} from '../history/history';
import {
  loadCalcHistory,
  recordCalcHistoryItem,
  deleteCalcHistoryItem,
} from '../history/calcHistory';
import { getInstalledAppsCache } from '../apps/installedApps';
import { iconDataCache, isTooSmallAppIconDataUrl } from '../icon/iconCache';
import { getAppIconDataStable, getFileIconData } from '../icon/iconService';
import { normalizeAppGroupKey } from '../utils/normalize';
import { clearLocalCacheAll } from '../utils/cacheCleaner';
import { resolveAppId } from '../win/resolveAppId';
import { openResolvedTarget } from '../utils/open';
import { readUrlShortcut, openLnkShortcut } from '../win/shortcuts';
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from '../win/startMenuShortcutIndex';
import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { getBootstrapState, refreshBootstrapHistory, setBootstrapSettings } from '../app/bootstrapState';
import { registerSearchOpenIpcHandlers } from './searchOpenHandlers';

let sudoPromptModule: any | null = null;

async function getSudoPrompt(): Promise<any> {
  if (sudoPromptModule) return sudoPromptModule;
  const m: any = await import('sudo-prompt');
  sudoPromptModule = m?.default ?? m;
  return sudoPromptModule;
}

function quoteCmdArg(v: string) {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

async function sudoExec(commandLine: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const sudoPrompt = await getSudoPrompt();
    return await new Promise((resolve) => {
      sudoPrompt.exec(
        commandLine,
        { name: 'File Search' },
        (error: any, _stdout: any, _stderr: any) => {
          if (!error) {
            resolve({ ok: true });
            return;
          }
          const msg = typeof error?.message === 'string' ? error.message.trim() : '';
          if (msg.toLowerCase().includes('user did not grant permission')) {
            resolve({ ok: false, message: '宸插彇娑堟垨鍚姩澶辫触锛堝彲鑳芥槸 UAC 琚嫆缁濓級' });
            return;
          }
          resolve({ ok: false, message: msg || '宸插彇娑堟垨鍚姩澶辫触锛堝彲鑳芥槸 UAC 琚嫆缁濓級' });
        },
      );
    });
  } catch {
    return { ok: false, message: '宸插彇娑堟垨鍚姩澶辫触锛堝彲鑳芥槸 UAC 琚嫆缁濓級' };
  }
}

type IndexProgressRuntime = {
  active: boolean;
  startedAt: number;
  startedCount: number;
  lastCount: number;
  lastProgress: number;
};

const indexProgressRuntime: IndexProgressRuntime = {
  active: false,
  startedAt: 0,
  startedCount: 0,
  lastCount: 0,
  lastProgress: 0,
};
type LastKnownIndexProgress = {
  hasValue: boolean;
  isIndexing: boolean;
  progress: number;
  updatedAt: number;
};
const INDEX_PROGRESS_FALLBACK_STALE_MS = 20_000;
const lastKnownIndexProgress: LastKnownIndexProgress = {
  hasValue: false,
  isIndexing: false,
  progress: 1,
  updatedAt: 0,
};

function rememberLastKnownIndexProgress(next: { isIndexing: boolean; progress: number }) {
  const progressRaw = Number(next?.progress);
  lastKnownIndexProgress.hasValue = true;
  lastKnownIndexProgress.isIndexing = Boolean(next?.isIndexing);
  lastKnownIndexProgress.progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(1, progressRaw)) : 1;
  lastKnownIndexProgress.updatedAt = Date.now();
}

function getLastKnownIndexProgressFallback() {
  if (!lastKnownIndexProgress.hasValue) return null;
  const now = Date.now();
  if (
    lastKnownIndexProgress.isIndexing &&
    now - lastKnownIndexProgress.updatedAt > INDEX_PROGRESS_FALLBACK_STALE_MS
  ) {
    return { isIndexing: false, progress: 1 };
  }
  return {
    isIndexing: lastKnownIndexProgress.isIndexing,
    progress: lastKnownIndexProgress.progress,
  };
}

function estimateIndexProgress(status: { isIndexing?: boolean; indexedCount?: number; progress?: number }) {
  const isIndexing = Boolean(status?.isIndexing);
  const directProgressRaw = Number(status?.progress);
  const hasDirectProgress = Number.isFinite(directProgressRaw);
  if (hasDirectProgress) {
    const normalized = Math.max(0, Math.min(1, directProgressRaw));
    if (!isIndexing) return { isIndexing: false, progress: 1 };
    // 绱㈠紩杩涜涓椂閬垮厤鎻愬墠鍒拌揪 100%锛屽畬鎴愭€佸啀鐢?isIndexing=false 杩斿洖 1銆?
    return { isIndexing: true, progress: Math.min(0.99, Math.max(0.01, normalized)) };
  }

  const indexedCountRaw = Number(status?.indexedCount);
  const indexedCount = Number.isFinite(indexedCountRaw) ? Math.max(0, indexedCountRaw) : 0;

  if (!isIndexing) {
    indexProgressRuntime.active = false;
    indexProgressRuntime.startedAt = 0;
    indexProgressRuntime.startedCount = 0;
    indexProgressRuntime.lastCount = indexedCount;
    indexProgressRuntime.lastProgress = 1;
    return { isIndexing: false, progress: 1 };
  }

  const now = Date.now();
  const isNewSession =
    !indexProgressRuntime.active ||
    (indexedCount > 0 && indexProgressRuntime.lastCount - indexedCount > 500);
  if (isNewSession) {
    indexProgressRuntime.active = true;
    indexProgressRuntime.startedAt = now;
    indexProgressRuntime.startedCount = indexedCount;
    indexProgressRuntime.lastCount = indexedCount;
    indexProgressRuntime.lastProgress = 0.01;
  }

  const growth = Math.max(0, indexedCount - indexProgressRuntime.startedCount);
  const elapsedMs = Math.max(0, now - indexProgressRuntime.startedAt);
  // 鏂囦欢閲忓闀跨敤浜庝綋鐜扳€滅湡瀹炴帹杩涒€濓紝鎸夊鏁板帇缂╅伩鍏嶅悗鏈熷闀胯繃蹇鑷磋烦鍙樸€?
  const countProgress = Math.min(0.92, Math.log10(growth + 1) / 6.0);
  // 鏃堕棿涓嬮檺鐢ㄤ簬鍏滃簳鈥滃凡鍦ㄧ储寮曚絾鐭湡鏃犲彲瑙佽鏁板彉鍖栤€濈殑闃舵锛岄伩鍏嶈繘搴﹂暱鏃堕棿鍋滃湪 0%銆?
  const timeProgress = Math.min(0.9, (elapsedMs / 1000 / 180) * 0.9);
  const nextProgress = Math.min(
    0.99,
    Math.max(indexProgressRuntime.lastProgress, countProgress, timeProgress, 0.01),
  );

  indexProgressRuntime.lastCount = indexedCount;
  indexProgressRuntime.lastProgress = nextProgress;
  return { isIndexing: true, progress: nextProgress };
}

// 鍘嗗彶骞挎挱缁熶竴璧板惎鍔ㄥ揩鐓х紦瀛橈細杩欐牱鎼滅储椤靛拰璁剧疆椤甸兘鑳芥嬁鍒板悓涓€浠藉凡棰勭儹缁撴灉銆?
async function broadcastHistoryUpdated() {
  const results = await refreshBootstrapHistory();
  try {
    getSearchWindow()?.webContents.send('history-updated', { results });
  } catch {}
  try {
    getSettingsWindow()?.webContents.send('history-updated', { results });
  } catch {}
  return { results };
}

// 璁＄畻鍘嗗彶骞挎挱涓庢枃浠跺巻鍙叉媶鍒嗭紝閬垮厤涓ょ被鏁版嵁浜掔浉姹℃煋銆?
function broadcastCalcHistoryUpdated() {
  const results = loadCalcHistory();
  try {
    getSearchWindow()?.webContents.send('calc-history-updated', { results });
  } catch {}
  try {
    getSettingsWindow()?.webContents.send('calc-history-updated', { results });
  } catch {}
  return { results };
}

export function registerIpcHandlers() {
  ipcMain.handle('get-device-id', () => {
    return getDeviceId();
  });

  ipcMain.handle('search-view-ready', (_event, payload?: { allowBlurHide?: boolean }) => {
    // 鎼滅储椤垫彙鎵嬫椂鍚屾褰撳墠缃《绛栫暐锛氱疆椤舵椂鍏抽棴澶辩劍鑷姩闅愯棌锛屽彇娑堢疆椤跺悗鎭㈠銆?
    setSearchAllowBlurHide(payload?.allowBlurHide !== false);
    // 娓叉煋灏辩华鎻℃墜锛氫富杩涚▼鏀跺埌鍚庢墠鍏佽鏄剧ず鎼滅储绐楋紝閬垮厤棣栧睆鐧藉睆銆?
    setSearchViewReady(true);
    return { ok: true };
  });

  ipcMain.handle('set-search-blur-hide-enabled', (_event, allow: boolean) => {
    // 娓叉煋灞傚姩鎬佸垏鎹㈠け鐒﹂殣钘忚兘鍔涳細鍥哄畾闈㈡澘鏈熼棿鍏抽棴锛岃В闄ゅ浐瀹氬悗鎭㈠銆?
    setSearchAllowBlurHide(Boolean(allow));
    return { ok: true };
  });

  ipcMain.handle('settings-view-ready', (event) => {
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
        data,
      };
    } catch (error: any) {
      return {
        ok: false,
        status: 500,
        statusText: error.message,
        data: null,
      };
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

  ipcMain.handle(
    'resize-window',
    (
      event,
      height: number,
      width?: number,
      limits?: { minHeight?: number; maxHeight?: number },
    ) => {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w) return;
      const settings = loadSettings();
      const clamp = (v: number, min: number, max: number) =>
        Math.min(max, Math.max(min, v));
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
      // 楂樺害涓婁笅闄愮敱娓叉煋灞傚疄鏃舵彁渚涳紝涓昏繘绋嬬粺涓€鍏滃簳 clamp锛岀‘淇濆師鐢熸嫋鎷戒篃鍙楀唴瀹硅竟鐣岀害鏉熴€?
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
    return getBootstrapState().settings;
  });

  // 鍚姩蹇収涓€娆¤繑鍥炶缃笌鍘嗗彶锛歳enderer 鍚姩闃舵鍙渶鎵撲竴瓒?IPC銆?
  ipcMain.handle('get-app-bootstrap-state', () => {
    const snapshot = getBootstrapState();
    return {
      settings: snapshot.settings,
      history: snapshot.history,
    };
  });

  ipcMain.handle('get-index-progress', async () => {
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

  ipcMain.handle('select-background-image', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '閫夋嫨鑳屾櫙鍥剧墖',
        buttonLabel: '閫夋嫨',
        properties: ['openFile'],
        filters: [{ name: '鍥剧墖', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (result.canceled) return { ok: true, path: '' };
      const targetPath = result.filePaths?.[0] || '';
      return { ok: true, path: targetPath };
    } catch (e: any) {
      return { ok: false, message: e?.message || '閫夋嫨鍥剧墖澶辫触', path: '' };
    }
  });

  ipcMain.handle('select-avatar-image', async () => {
    try {
      // 澶村儚閫夋嫨锛氫粎杩斿洖鏈湴鍥剧墖璺緞锛屾覆鏌撲晶閫氳繃 get-image-data-url 杞负鍙敤鐨?dataUrl 灞曠ず
      const result = await dialog.showOpenDialog({
        title: '閫夋嫨澶村儚鍥剧墖',
        buttonLabel: '閫夋嫨',
        properties: ['openFile'],
        filters: [{ name: '鍥剧墖', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (result.canceled) return { ok: true, path: '' };
      const targetPath = result.filePaths?.[0] || '';
      return { ok: true, path: targetPath };
    } catch (e: any) {
      return { ok: false, message: e?.message || '閫夋嫨鍥剧墖澶辫触', path: '' };
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
    
    // Merge with existing
    const next = { ...loadSettings(), ...settings };
    
    // Save to disk
    saveSettings(next);
    setBootstrapSettings(next);
    
    // Update Ignored Paths in fileIndex
    await fileIndex.setIgnoredPaths(next.ignoredPaths, next.preferredFileExtensions);
    
    // Re-register shortcuts
    // 閲嶆柊娉ㄥ唽蹇嵎閿細浣跨敤闈欐€?import锛岄伩鍏嶆墦鍖呭悗杩愯鏈?require 璺緞澶辨晥
    registerShortcutsForSettings({ searchShortcut: next.searchShortcut, settingsShortcut: next.settingsShortcut });
    
    // Notify windows
    const win = getSearchWindow();
    const settingsWin = getSettingsWindow();
    try {
        win?.webContents.send('settings-updated', next);
    } catch {}
    try {
        settingsWin?.webContents.send('settings-updated', next);
    } catch {}

    // 鍘嗗彶鍙?enableHistory/historyLimit 褰卞搷锛氫繚瀛樿缃悗鍚屾鍒锋柊蹇収锛岄伩鍏嶇┖杈撳叆鍒楄〃浠嶆部鐢ㄦ棫闄愬埗銆?
    await broadcastHistoryUpdated();

    // Rebuild index if ignored paths changed
    // 蹇界暐璺緞瀵规瘮锛氫粎褰撯€滈泦鍚堝唴瀹光€濆彉鍖栨椂鎵嶈Е鍙戦噸寤猴紝閬垮厤鍥犱负椤哄簭鍙樺寲瀵艰嚧璇噸寤?
    const normalizeIgnoredPathsForCompare = (list: string[]) => {
      const arr = Array.isArray(list) ? list : [];
      return arr
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
        .slice()
        .sort();
    };
    const prevKey = normalizeIgnoredPathsForCompare(prevIgnoredPaths).join('|');
    const nextKey = normalizeIgnoredPathsForCompare(next.ignoredPaths).join('|');
    // 涓嶅啀瑙﹀彂鈥滃叏鐩橀噸寤虹储寮曗€濓細蹇界暐瑙勫垯浼氱珛鍗崇敓鏁堜簬 watcher 杩囨护涓庡悗缁閲?ingest銆?
    return { ok: true };
  });

  ipcMain.handle('get-history', async () => {
    return { results: getBootstrapState().history };
  });

  ipcMain.handle('clear-history', async () => {
    clearHistory();
    await broadcastHistoryUpdated();
    return { ok: true };
  });

  ipcMain.handle('delete-history-item', async (_event, targetPath: string) => {
    deleteHistoryItemFunc(targetPath);
    await broadcastHistoryUpdated();
    return { ok: true };
  });

  ipcMain.handle('get-calc-history', async () => {
    return { results: loadCalcHistory() };
  });

  ipcMain.handle(
    'record-calc-history-item',
    async (_event, payload: { expression?: string; result?: string }) => {
      recordCalcHistoryItem({
        expression: typeof payload?.expression === 'string' ? payload.expression : '',
        result: typeof payload?.result === 'string' ? payload.result : '',
      });
      return broadcastCalcHistoryUpdated();
    },
  );

  ipcMain.handle('delete-calc-history-item', async (_event, expression: string) => {
    deleteCalcHistoryItem(expression);
    return broadcastCalcHistoryUpdated();
  });

  registerSearchOpenIpcHandlers({ broadcastHistoryUpdated, quoteCmdArg, sudoExec });
}

