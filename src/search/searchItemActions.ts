export function openSettingsAction() {
  window.ipcRenderer?.invoke("open-settings-window");
}

export function copyCalcResultAction(item: any, showToast: (message: string, kind?: any) => void) {
  if (!item || item.type !== "calc") return;
  const expressionText = String(item.path || "").trim();
  const resultText = String(item.name || "").trim();
  if (!expressionText || !resultText) return;
  void window.ipcRenderer?.invoke("record-calc-history-item", {
    expression: expressionText,
    result: resultText,
  });
  navigator.clipboard
    .writeText(resultText)
    .then(() => showToast("已复制计算结果", "success"))
    .catch(() => showToast("复制失败", "error"));
}

export function openFolderAction(app: any) {
  if (app.type === "calc") return;
  if (app.type === "settings") {
    window.ipcRenderer?.invoke("open-item", {
      name: app.name,
      path: app.path,
      type: app.type || "file",
    });
    return;
  }
  window.ipcRenderer?.invoke("open-folder", { type: app.type, path: app.path, name: app.name });
}

export function launchAppAction(app: any, copyCalcResult: (item: any) => void) {
  if (app.type === "calc") {
    copyCalcResult(app);
    return;
  }
  window.ipcRenderer?.invoke("open-item", {
    name: app.name,
    path: app.path,
    type: app.type || "file",
  });
}

export async function runAsAdminAction(app: any, showToast: (message: string, kind?: any) => void) {
  try {
    const resp = (await window.ipcRenderer?.invoke("run-as-admin", {
      path: app.path,
      type: app.type,
      name: app.name,
    })) as { ok: boolean; message?: string } | boolean | undefined;

    if (!resp) return;
    const ok = typeof resp === "boolean" ? resp : Boolean(resp?.ok);
    const msg = typeof resp === "object" && resp ? (resp as any).message : "";
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

export function copyPathAction(item: any, showToast: (message: string, kind?: any) => void) {
  if (!item?.path) return;
  navigator.clipboard
    .writeText(item.path)
    .then(() => showToast("已复制路径", "success"))
    .catch(() => showToast("复制失败", "error"));
}
