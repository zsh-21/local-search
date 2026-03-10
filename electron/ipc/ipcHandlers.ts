import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import { getDeviceId } from '../config/deviceId';
import {
  setSearchAllowBlurHide,
  setSettingsReadyToShow,
  clearSettingsShowFallbackTimer,
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
  shouldSkipWatchPath,
  getWindowsFileSystemRoots,
  normalizeRecentKey,
} from '../file/watcher';
import {
  loadHistoryStats,
  normalizeHistoryKey,
  normalizeExtKey,
  loadHistory,
  saveHistory,
  recordHistoryItem,
  isExistingTarget,
  clearHistory,
  deleteHistoryItemFunc,
} from '../history/history';
import { getInstalledAppsCache } from '../apps/installedApps';
import { iconDataCache, isTooSmallAppIconDataUrl } from '../icon/iconCache';
import { getAppIconDataStable, getFileIconData, getHistoryIconForPath } from '../icon/iconService';
import { normalizeAppGroupKey } from '../utils/normalize';
import { clearLocalCacheButKeepAccountAndSettings } from '../utils/cacheCleaner';
import { resolveAppId } from '../win/resolveAppId';
import { openResolvedTarget } from '../utils/open';
import { readUrlShortcut, openLnkShortcut } from '../win/shortcuts';
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from '../win/startMenuShortcutIndex';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';

export function registerIpcHandlers() {
  ipcMain.handle('get-device-id', () => {
    return getDeviceId();
  });

  ipcMain.handle('search-view-ready', () => {
    setSearchAllowBlurHide(true);
  });

  ipcMain.handle('settings-view-ready', (event) => {
    try {
      const w = BrowserWindow.fromWebContents(event.sender);
      if (!w) return { ok: false };
      const settingsWin = getSettingsWindow();
      if (settingsWin && w.id !== settingsWin.id) return { ok: false };
      clearSettingsShowFallbackTimer();
      setSettingsReadyToShow(true);
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

  ipcMain.handle('resize-window', (event, height: number, width?: number) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return;
    const [currentWidth] = w.getContentSize();
    const nextWidth = width ?? currentWidth;
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
      height: bounds.height ?? current.height,
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
    
    // Merge with existing
    const next = { ...loadSettings(), ...settings };
    
    // Save to disk
    saveSettings(next);
    
    // Update Ignored Paths in fileIndex
    await fileIndex.setIgnoredPaths(next.ignoredPaths);
    
    // Re-register shortcuts
    // 重新注册快捷键：使用静态 import，避免打包后运行期 require 路径失效
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

    // Rebuild index if ignored paths changed
    // 忽略路径对比：仅当“集合内容”变化时才触发重建，避免因为顺序变化导致误重建
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
    if (prevKey !== nextKey) {
      void fileIndex.rebuild();
    }
    return { ok: true };
  });

  ipcMain.handle('get-history', async () => {
    const settings = loadSettings();
    const history =
      settings.historyLimit > 0 ? loadHistory().filter((h) => isExistingTarget(h)).slice(0, settings.historyLimit) : [];

    const results = await Promise.all(
      history.map(async (h) => {
        const iconData = await getHistoryIconForPath({ type: h.type, name: h.name, path: h.path });
        return { name: h.name, path: h.path, type: h.type, icon: iconData };
      })
    );

    return { results };
  });

  ipcMain.handle('clear-history', () => {
    clearHistory();
    getSearchWindow()?.webContents.send('reset-search');
    getSettingsWindow()?.webContents.send('reset-search');
    return { ok: true };
  });

  ipcMain.handle('delete-history-item', (_event, targetPath: string) => {
    deleteHistoryItemFunc(targetPath);
    getSearchWindow()?.webContents.send('reset-search');
    getSettingsWindow()?.webContents.send('reset-search');
    return { ok: true };
  });

  ipcMain.handle('clear-cache', async () => {
    await clearLocalCacheButKeepAccountAndSettings();
    return { ok: true };
  });

  ipcMain.handle('open-item', async (event, item: { name: string; path: string; type?: string }) => {
    try {
      if (item?.type === 'command' && typeof item?.path === 'string' && item.path.trim().toLowerCase() === 'clear:cache') {
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
      const p = typeof input === 'string' ? input : typeof input?.path === 'string' ? input.path : '';
      const t = typeof input?.type === 'string' ? input.type : '';
      const n = typeof input?.name === 'string' ? input.name : '';
      const resolved = resolveAppId(p);

      if (resolved.includes('\\') || resolved.includes('/')) {
        try {
          const st = statSync(resolved);
          if (st.isDirectory()) {
            await shell.openPath(resolved);
          } else {
            shell.showItemInFolder(resolved);
          }
        } catch {
          shell.showItemInFolder(resolved);
        }
      } else {
        await ensureStartMenuShortcutIndex();
        const shortcut = n ? findStartMenuShortcutByName(n) : '';
        if (shortcut && existsSync(shortcut)) {
          shell.showItemInFolder(shortcut);
        } else if (t === 'app' && p) {
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
    if (Array.isArray(options?.ignoredPaths)) {
      await fileIndex.setIgnoredPaths(options.ignoredPaths);
    }
    await fileIndex.rebuild();
    return await fileIndex.getStatus();
  });

  ipcMain.handle('get-file-index-status', async () => {
    return await fileIndex.getStatus();
  });

  ipcMain.handle(
    'search-files',
    async (event, query: string, options?: { searchTypeId?: string; searchSessionId?: string; drive?: string }) => {
      return await handleSearchFiles(event, query, options, {
        fileIndex,
        reconcileRecentIndex: () => void reconcileRecentIndex(),
        loadSettings,
        loadHistoryStats,
        normalizeHistoryKey,
        normalizeExtKey,
        getInstalledApps: () => getInstalledAppsCache(),
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
    }
  );
}
