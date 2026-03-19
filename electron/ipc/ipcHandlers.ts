import { ipcMain, BrowserWindow, dialog, screen, shell } from 'electron';
import { getDeviceId } from '../config/deviceId';
import {
  setSearchAllowBlurHide,
  setSearchViewReady,
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
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { getBootstrapState, refreshBootstrapHistory, setBootstrapSettings } from '../app/bootstrapState';

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
            resolve({ ok: false, message: '已取消或启动失败（可能是 UAC 被拒绝）' });
            return;
          }
          resolve({ ok: false, message: msg || '已取消或启动失败（可能是 UAC 被拒绝）' });
        },
      );
    });
  } catch {
    return { ok: false, message: '已取消或启动失败（可能是 UAC 被拒绝）' };
  }
}

let isAdminProcessCache: boolean | null = null;

async function isCurrentProcessAdminOnWindows(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (typeof isAdminProcessCache === 'boolean') return isAdminProcessCache;

  const ok = await new Promise<boolean>((resolve) => {
    try {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
        ],
        { windowsHide: true },
      );
      let out = '';
      ps.stdout?.on('data', (d) => (out += String(d)));
      ps.on('close', () => {
        resolve(out.trim().toLowerCase() === 'true');
      });
      ps.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });

  isAdminProcessCache = ok;
  return ok;
}

// 历史广播统一走启动快照缓存：这样搜索页和设置页都能拿到同一份已预热结果。
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

// 计算历史广播与文件历史拆分，避免两类数据互相污染。
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
    // 搜索页握手时同步当前置顶策略：置顶时关闭失焦自动隐藏，取消置顶后恢复。
    setSearchAllowBlurHide(payload?.allowBlurHide !== false);
    // 渲染就绪握手：主进程收到后才允许显示搜索窗，避免首屏白屏。
    setSearchViewReady(true);
    return { ok: true };
  });

  ipcMain.handle('set-search-blur-hide-enabled', (_event, allow: boolean) => {
    // 渲染层动态切换失焦隐藏能力：固定面板期间关闭，解除固定后恢复。
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
    const settings = loadSettings();
    const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
    const [currentWidth] = w.getContentSize();
    const maxH = typeof settings?.searchWindowMaxHeight === 'number' ? settings.searchWindowMaxHeight : 760;
    const nextWidth = clamp(Math.round(width ?? currentWidth), 450, 1000);
    const displayMaxH = (() => {
      try {
        const d = screen.getDisplayMatching(w.getBounds());
        return d?.workAreaSize?.height;
      } catch {
        return undefined;
      }
    })();
    const upper = Math.max(200, Math.round(Math.min(Math.round(maxH), displayMaxH ?? Math.round(maxH))));
    const nextHeight = clamp(Math.round(height), 76, upper);
    w.setContentSize(nextWidth, nextHeight);
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
    return getBootstrapState().settings;
  });

  // 启动快照一次返回设置与历史：renderer 启动阶段只需打一趟 IPC。
  ipcMain.handle('get-app-bootstrap-state', () => {
    const snapshot = getBootstrapState();
    return {
      settings: snapshot.settings,
      history: snapshot.history,
    };
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
    setBootstrapSettings(next);
    
    // Update Ignored Paths in fileIndex
    await fileIndex.setIgnoredPaths(next.ignoredPaths, next.preferredFileExtensions);
    
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

    // 历史受 enableHistory/historyLimit 影响：保存设置后同步刷新快照，避免空输入列表仍沿用旧限制。
    await broadcastHistoryUpdated();

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
    // 不再触发“全盘重建索引”：忽略规则会立即生效于 watcher 过滤与后续增量 ingest。
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

  ipcMain.handle('clear-cache', async () => {
    await clearLocalCacheAll();
    return { ok: true };
  });

  ipcMain.handle('open-item', async (event, item: { name: string; path: string; type?: string }) => {
    try {
      if (item?.type === 'command' && typeof item?.path === 'string') {
        const cmd = item.path.trim().toLowerCase();
        if (cmd === 'clear:cache') {
          await clearLocalCacheAll();
          return true;
        }
        if (cmd === 'system:shutdown' || cmd === 'system:restart') {
          if (process.platform !== 'win32') return false;
          const args = cmd === 'system:shutdown' ? ['/s', '/t', '0'] : ['/r', '/t', '0'];
          try {
            const child = spawn('shutdown', args, { windowsHide: true, detached: true, stdio: 'ignore' });
            child.unref();
            return true;
          } catch {
            return false;
          }
        }
      }
      if (item?.type === 'settings' && typeof item?.path === 'string' && item.path.startsWith('ms-settings:')) {
        await shell.openExternal(item.path);
        if (item?.name && item?.path) {
          recordHistoryItem(item);
          await broadcastHistoryUpdated();
        }
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
        if (item?.name && item?.path) {
          recordHistoryItem(item);
          await broadcastHistoryUpdated();
        }
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
      const t = typeof input?.type === 'string' ? input.type : '';
      const n = typeof input?.name === 'string' ? input.name : '';
      if (!p) return { ok: false, message: '路径为空，无法以管理员身份运行' };

      const resolved = resolveAppId(p);

      if (process.platform === 'win32') {
        // 允许在非管理员模式下直接触发 UAC 弹窗：由 sudo-prompt 负责权限提升
      } else {
        const ok = await openResolvedTarget(resolved);
        if (ok) BrowserWindow.fromWebContents(event.sender)?.hide();
        return { ok: Boolean(ok) };
      }

      const looksLikePath = /^[a-zA-Z]:\\/.test(resolved) || resolved.startsWith('\\\\');

      let targetToRun = resolved;
      let shouldValidateFilePath = looksLikePath;

      if (!looksLikePath && t === 'app') {
        await ensureStartMenuShortcutIndex();
        const shortcut = n ? findStartMenuShortcutByName(n) : '';
        if (shortcut && existsSync(shortcut)) {
          targetToRun = shortcut;
          shouldValidateFilePath = true;
        } else {
          targetToRun = `shell:AppsFolder\\${resolved}`;
          shouldValidateFilePath = false;
        }
      }

      if (shouldValidateFilePath) {
        try {
          const st = statSync(targetToRun);
          if (st.isDirectory()) {
            return { ok: false, message: '文件夹不支持以管理员身份打开' };
          }
        } catch {
          return { ok: false, message: '目标不存在或不可访问' };
        }

        const ext = path.extname(targetToRun).toLowerCase();
        const allowedExts = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.lnk']);
        if (!allowedExts.has(ext)) {
          return { ok: false, message: '仅支持可执行文件（.exe/.bat/.cmd/.com/.msi）' };
        }
      }

      const commandLine = `cmd.exe /c start "" ${quoteCmdArg(targetToRun)}`;
      const resp = await sudoExec(commandLine);
      if (resp.ok) BrowserWindow.fromWebContents(event.sender)?.hide();
      return false;
    } catch {
      return { ok: false, message: '以管理员身份运行失败' };
    }
  });

  ipcMain.handle('open-external', async (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('get-result-icon', async (_event, item: { type: string; path?: string; name?: string }) => {
    try {
      const t = typeof item?.type === 'string' ? item.type : '';
      const p = typeof item?.path === 'string' ? item.path : '';
      const n = typeof item?.name === 'string' ? item.name : '';
      if (!t) return '';

      // 计算项图标与应用搜索走同一链路：优先命中已安装应用里的“计算器”候选。
      if (t === 'calc') {
        const apps = getInstalledAppsCache();
        const calcKeywords = ['计算器', 'calculator', 'windowscalculator'];
        const candidate = apps.find((app) => {
          const appName = String(app?.Name || '').toLowerCase();
          const appId = String(app?.AppID || '').toLowerCase();
          return calcKeywords.some((k) => appName.includes(k.toLowerCase()) || appId.includes(k.toLowerCase()));
        });
        if (candidate?.AppID) {
          const icon = await getAppIconDataStable(candidate.Name || '计算器', candidate.AppID, 3);
          if (icon) return icon;
        }

        // 未命中缓存候选时回退到固定 AUMID。
        const calcAumid = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
        const aumidIcon = await getAppIconDataStable('计算器', calcAumid, 3);
        if (aumidIcon) return aumidIcon;

        // 再回退到 calc.exe 文件图标，确保系统缺少 AUMID 时也可展示。
        const calcExePath = resolveAppId('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\calc.exe');
        if (calcExePath && existsSync(calcExePath)) {
          const fileIcon = await getFileIconData(calcExePath);
          if (fileIcon) return fileIcon;
        }
        return '';
      }

      if (!p) return '';
      if (t === 'app') {
        await ensureStartMenuShortcutIndex();
        return await getAppIconDataStable(n, p, 3);
      }
      if (t === 'file' || t === 'folder') {
        return await getFileIconData(p);
      }
      return '';
    } catch {
      return '';
    }
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
      });
    }
  );
}
