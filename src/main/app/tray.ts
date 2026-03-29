import { app, dialog, Menu, Tray } from "electron";
import { resolvePublicAssetPath } from "../utils/publicAsset";

/** 托盘模块输入参数 */
type EnsureTrayInput = {
  /** 获取托盘图标路径 */
  getIconPath: () => string;
  /** 切换搜索窗口显示状态 */
  toggleSearchWindow: () => void;
  /** 打开设置窗口 */
  showSettingsWindow: () => void;
  /** 从文件对话框添加快捷项 */
  onAddQuickItemPath: (filePath: string) => void | Promise<void>;
  /** 手动刷新索引与盘符 */
  onManualRefresh: () => void | Promise<void>;
};

/** 创建并注册托盘菜单 */
export function ensureTray(input: EnsureTrayInput) {
  try {
    /** 托盘实例 */
    const tray = new Tray(input.getIconPath());
    /** 托盘菜单模板 */
    const contextMenu = Menu.buildFromTemplate([
      { label: "显示搜索框", click: () => input.toggleSearchWindow() },
      {
        label: "新增文件到 FileSearch 快捷列表",
        click: () => void addQuickItemFromDialog(input.onAddQuickItemPath),
      },
      { label: "设置", click: () => input.showSettingsWindow() },
      {
        label: "立即刷新索引与盘符",
        click: () => {
          /** 托盘点击失败兜底：避免未处理 Promise 警告 */
          void Promise.resolve(input.onManualRefresh()).catch(() => {});
        },
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]);

    /** 设置托盘提示文字与菜单 */
    tray.setToolTip("File Search");
    tray.setContextMenu(contextMenu);
    /** 左键点击行为：切换搜索窗口 */
    tray.on("click", () => {
      input.toggleSearchWindow();
    });
    return tray;
  } catch {
    return null;
  }
}

/** 弹出文件选择框并将文件加入快捷列表 */
async function addQuickItemFromDialog(onPicked: (filePath: string) => void | Promise<void>) {
  try {
    /** 文件选择结果 */
    const result = await dialog.showOpenDialog({
      title: "添加到 File Search 快捷列表",
      buttonLabel: "添加",
      properties: ["openFile"],
      filters: [{ name: "应用/快捷方式", extensions: ["exe", "lnk", "url"] }],
    });
    if (result.canceled) return;
    /** 目标文件路径 */
    const targetPath = result.filePaths?.[0];
    if (!targetPath) return;
    await onPicked(targetPath);
  } catch {}
}

/** 获取托盘默认图标路径 */
export function getDefaultTrayIconPath() {
  return resolvePublicAssetPath("tray.png");
}
