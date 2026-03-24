import { BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { recordHistoryItem } from "../history/history";
import { getInstalledAppsCache } from "../apps/installedApps";
import { getAppIconDataStable, getFileIconData } from "../icon/iconService";
import { clearLocalCacheAll } from "../utils/cacheCleaner";
import { resolveAppId } from "../win/resolveAppId";
import { openResolvedTarget } from "../utils/open";
import { readUrlShortcut, openLnkShortcut } from "../win/shortcuts";
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from "../win/startMenuShortcutIndex";
import { searchFilesViaService } from "../search/searchService";

type RegisterSearchOpenIpcHandlersDeps = {
  broadcastHistoryUpdated: () => Promise<{ results: any[] }>;
  quoteCmdArg: (v: string) => string;
  sudoExec: (commandLine: string) => Promise<{ ok: boolean; message?: string }>;
};

type SearchInputPayload = {
  path: string;
  type: string;
  name: string;
};

function normalizeSearchInput(input: any): SearchInputPayload {
  if (typeof input === "string") {
    return { path: input, type: "", name: "" };
  }
  return {
    path: typeof input?.path === "string" ? input.path : "",
    type: typeof input?.type === "string" ? input.type : "",
    name: typeof input?.name === "string" ? input.name : "",
  };
}

async function recordHistoryAndHideWindow(
  event: any,
  deps: RegisterSearchOpenIpcHandlersDeps,
  item?: { name?: string; path?: string; type?: string },
) {
  if (item?.name && item?.path) {
    recordHistoryItem({ name: item.name, path: item.path, type: item.type });
    await deps.broadcastHistoryUpdated();
  }
  BrowserWindow.fromWebContents(event.sender)?.hide();
}

export function registerSearchOpenIpcHandlers(deps: RegisterSearchOpenIpcHandlersDeps) {
  ipcMain.handle("clear-cache", async () => {
    await clearLocalCacheAll();
    return { ok: true };
  });

  ipcMain.handle("open-item", async (event, item: { name: string; path: string; type?: string }) => {
    try {
      if (item?.type === "command" && typeof item?.path === "string") {
        const cmd = item.path.trim().toLowerCase();
        if (cmd === "clear:cache") {
          await clearLocalCacheAll();
          return true;
        }
        if (cmd === "system:shutdown" || cmd === "system:restart") {
          if (process.platform !== "win32") return false;
          const args = cmd === "system:shutdown" ? ["/s", "/t", "0"] : ["/r", "/t", "0"];
          try {
            const child = spawn("shutdown", args, { windowsHide: true, detached: true, stdio: "ignore" });
            child.unref();
            return true;
          } catch {
            return false;
          }
        }
      }

      if (item?.type === "settings" && typeof item?.path === "string" && item.path.startsWith("ms-settings:")) {
        await shell.openExternal(item.path);
        await recordHistoryAndHideWindow(event, deps, item);
        return true;
      }

      const resolved = resolveAppId(item?.path);
      let ok = await openResolvedTarget(resolved);
      if (!ok) {
        const lower = resolved.toLowerCase();
        if (lower.endsWith(".url")) {
          const url = readUrlShortcut(resolved);
          if (url) {
            await shell.openExternal(url);
            ok = true;
          }
        } else if (lower.endsWith(".lnk")) {
          ok = await openLnkShortcut(resolved);
        }
      }
      if (ok) {
        await recordHistoryAndHideWindow(event, deps, item);
      }
      return ok;
    } catch {
      return false;
    }
  });

  ipcMain.handle("open-app", async (event, target: string) => {
    try {
      const resolved = resolveAppId(target);
      const ok = await openResolvedTarget(resolved);
      if (ok) BrowserWindow.fromWebContents(event.sender)?.hide();
      return ok;
    } catch {
      return false;
    }
  });

  ipcMain.handle("open-folder", async (event, input: any) => {
    try {
      const { path: p, name: n } = normalizeSearchInput(input);
      const resolved = resolveAppId(p);

      if (resolved.includes("\\") || resolved.includes("/")) {
        try {
          const st = statSync(resolved);
          if (st.isDirectory()) await shell.openPath(resolved);
          else shell.showItemInFolder(resolved);
        } catch {
          shell.showItemInFolder(resolved);
        }
      } else {
        await ensureStartMenuShortcutIndex();
        const shortcut = n ? findStartMenuShortcutByName(n) : "";
        if (shortcut && existsSync(shortcut)) {
          shell.showItemInFolder(shortcut);
        } else {
          await shell.openExternal("shell:AppsFolder");
        }
      }
      BrowserWindow.fromWebContents(event.sender)?.hide();
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("run-as-admin", async (event, input: any) => {
    try {
      const { path: p, type: t, name: n } = normalizeSearchInput(input);
      if (!p) return { ok: false, message: "路径为空，无法以管理员身份运行" };

      const resolved = resolveAppId(p);

      if (process.platform !== "win32") {
        const ok = await openResolvedTarget(resolved);
        if (ok) BrowserWindow.fromWebContents(event.sender)?.hide();
        return { ok: Boolean(ok) };
      }

      const looksLikePath = /^[a-zA-Z]:\\/.test(resolved) || resolved.startsWith("\\\\");
      let targetToRun = resolved;
      let shouldValidateFilePath = looksLikePath;

      if (!looksLikePath && t === "app") {
        await ensureStartMenuShortcutIndex();
        const shortcut = n ? findStartMenuShortcutByName(n) : "";
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
          if (st.isDirectory()) return { ok: false, message: "文件夹不支持以管理员身份打开" };
        } catch {
          return { ok: false, message: "目标不存在或不可访问" };
        }

        const ext = path.extname(targetToRun).toLowerCase();
        const allowedExts = new Set([".exe", ".bat", ".cmd", ".com", ".msi", ".lnk"]);
        if (!allowedExts.has(ext)) return { ok: false, message: "仅支持可执行文件（.exe/.bat/.cmd/.com/.msi）" };
      }

      const commandLine = `cmd.exe /c start \"\" ${deps.quoteCmdArg(targetToRun)}`;
      const resp = await deps.sudoExec(commandLine);
      if (resp.ok) BrowserWindow.fromWebContents(event.sender)?.hide();
      return false;
    } catch {
      return { ok: false, message: "以管理员身份运行失败" };
    }
  });

  ipcMain.handle("open-external", async (_event, url: string) => {
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle("get-result-icon", async (_event, item: { type: string; path?: string; name?: string }) => {
    try {
      const t = typeof item?.type === "string" ? item.type : "";
      const p = typeof item?.path === "string" ? item.path : "";
      const n = typeof item?.name === "string" ? item.name : "";
      if (!t) return "";

      if (t === "calc") {
        const apps = getInstalledAppsCache();
        const calcKeywords = ["计算器", "calculator", "windowscalculator"];
        const candidate = apps.find((app) => {
          const appName = String(app?.Name || "").toLowerCase();
          const appId = String(app?.AppID || "").toLowerCase();
          return calcKeywords.some((k) => appName.includes(k.toLowerCase()) || appId.includes(k.toLowerCase()));
        });
        if (candidate?.AppID) {
          const icon = await getAppIconDataStable(candidate.Name || "计算器", candidate.AppID, 3);
          if (icon) return icon;
        }
        const calcAumid = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
        const aumidIcon = await getAppIconDataStable("计算器", calcAumid, 3);
        if (aumidIcon) return aumidIcon;
        const calcExePath = resolveAppId("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\calc.exe");
        if (calcExePath && existsSync(calcExePath)) {
          const fileIcon = await getFileIconData(calcExePath);
          if (fileIcon) return fileIcon;
        }
        return "";
      }

      if (!p) return "";
      if (t === "app") {
        await ensureStartMenuShortcutIndex();
        return await getAppIconDataStable(n, p, 3);
      }
      if (t === "file" || t === "folder") return await getFileIconData(p);
      return "";
    } catch {
      return "";
    }
  });

  ipcMain.handle("search-files", async (event, query: string, options?: { searchTypeId?: string; searchSessionId?: string; drive?: string }) => {
    return await searchFilesViaService(event, query, options);
  });
}
