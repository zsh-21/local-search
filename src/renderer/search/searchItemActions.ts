import {
  IPC_OPEN_FOLDER,
  IPC_OPEN_ITEM,
  IPC_OPEN_SETTINGS_WINDOW,
  IPC_RECORD_CALC_HISTORY_ITEM,
  IPC_RUN_AS_ADMIN,
} from "../../shared/ipc/channels";
import type { AppItem } from "../appTypes";

/** Toast 类型 */
type ToastKind = "success" | "error" | "info";

/** Toast 回调 */
type ShowToast = (message: string, kind?: ToastKind) => void;

/** 管理员启动 IPC 返回 */
type RunAsAdminResponse = { ok: boolean; message?: unknown } | boolean | undefined;

export function openSettingsAction() {
  window.ipcRenderer?.invoke(IPC_OPEN_SETTINGS_WINDOW);
}

export function copyCalcResultAction(item: AppItem | undefined, showToast: ShowToast) {
  if (!item || item.type !== "calc") return;
  const expressionText = String(item.path || "").trim();
  const resultText = String(item.name || "").trim();
  if (!expressionText || !resultText) return;
  void window.ipcRenderer?.invoke(IPC_RECORD_CALC_HISTORY_ITEM, {
    expression: expressionText,
    result: resultText,
  });
  navigator.clipboard
    .writeText(resultText)
    .then(() => showToast("已复制计算结果", "success"))
    .catch(() => showToast("复制失败", "error"));
}

export function openFolderAction(app: AppItem) {
  if (app.type === "calc") return;
  if (app.type === "settings") {
    window.ipcRenderer?.invoke(IPC_OPEN_ITEM, {
      name: app.name,
      path: app.path,
      type: app.type || "file",
    });
    return;
  }
  window.ipcRenderer?.invoke(IPC_OPEN_FOLDER, { type: app.type, path: app.path, name: app.name });
}

export function launchAppAction(app: AppItem, copyCalcResult: (item: AppItem | undefined) => void) {
  if (app.type === "calc") {
    copyCalcResult(app);
    return;
  }
  window.ipcRenderer?.invoke(IPC_OPEN_ITEM, {
    name: app.name,
    path: app.path,
    type: app.type || "file",
  });
}

export async function runAsAdminAction(app: AppItem, showToast: ShowToast) {
  try {
    const resp = (await window.ipcRenderer?.invoke(IPC_RUN_AS_ADMIN, {
      path: app.path,
      type: app.type,
      name: app.name,
    })) as RunAsAdminResponse;

    if (!resp) return;
    const ok = typeof resp === "boolean" ? resp : Boolean(resp?.ok);
    const msg = typeof resp === "object" && resp && "message" in resp ? resp.message : "";
    const safeMsg = String(msg || "").replace(/\s*\r?\n\s*/g, " ").trim();
    if (ok) {
      showToast("已请求管理员运行", "success");
    } else {
      showToast(safeMsg || "管理员运行失败", "error");
    }
  } catch {
    showToast("管理员运行失败", "error");
  }
}

export function copyPathAction(item: AppItem, showToast: ShowToast) {
  if (!item?.path) return;
  navigator.clipboard
    .writeText(item.path)
    .then(() => showToast("已复制路径", "success"))
    .catch(() => showToast("复制失败", "error"));
}
