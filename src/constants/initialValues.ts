import type { AppSettings, ResultActionButtonId } from "../appTypes";
import { BASE_SEARCH_TYPE_IDS, DEFAULT_SETTINGS } from "../../shared/initialValues";

export const API_BASE_URL = "http://localhost:3001";

export const FS_USER_KEY = "fs_user";
export const FS_TOKEN_KEY = "fs_token";
export const MEMBERSHIP_CHANGED_EVENT = "fs-membership-changed";

export const FS_LAST_LOGIN_ACCOUNT_KEY = "fs_last_login_account";
export const FS_LAST_LOGIN_PASSWORD_KEY = "fs_last_login_password";

export const FS_BACKUP_SETTINGS_KEY = "fs_backup_settings";

export { BASE_SEARCH_TYPE_IDS, DEFAULT_SETTINGS };

// 主题体系：固定 12 款（4 浅色 + 8 深色），并与 AppSettings.theme 联合类型保持一致。
export const THEME_STYLE_OPTIONS: Array<{ id: AppSettings["theme"]; label: string }> = [
  // 深色主题：把极客感、仪表感和高对比层次拆成可感知的不同材质。
  { id: "dark", label: "Dark · 石墨工业 2.0" },
  { id: "terminal", label: "Terminal · 终端矩阵" },
  { id: "vector", label: "Vector · 精密示波" },
  { id: "alloy", label: "Alloy · 钛银仪表" },
  { id: "noir", label: "Noir · 黑曜剧场" },
  { id: "signal", label: "Signal · 琥珀控制台" },
  { id: "oxide", label: "Oxide · 赤铜机芯" },
  { id: "voltage", label: "Voltage · 冷电高压" },
  // 浅色主题：保留官方感与高级办公气质，同时避免浅色只剩“发白”。
  { id: "chrome", label: "Chrome · 官方品牌纸面 2.0" },
  { id: "mac", label: "macOS · 珠光玻璃 2.0" },
  { id: "blueprint", label: "Blueprint · 企业蓝图" },
  { id: "paper", label: "Paper · 白金档案" },
];

export const RESULT_ACTION_OPTIONS: Array<{
  id: ResultActionButtonId;
  label: string;
  note?: string;
}> = [
  { id: "openFolder", label: "打开所在目录" },
  { id: "copyPath", label: "复制路径" },
  { id: "runAsAdmin", label: "以管理员权限打开", note: "仅应用类型显示" },
  { id: "deleteHistory", label: "删除历史记录", note: "仅历史模式显示" },
];

export const SEARCH_ITEM_HEIGHT_COMPACT = 44;
export const SEARCH_ITEM_HEIGHT_NORMAL = 52;

export const SEARCH_WINDOW_TOP_BAR_HEIGHT = 76;
export const SEARCH_WINDOW_BOTTOM_BAR_HEIGHT = 90;

export const SEARCH_WINDOW_MIN_HEIGHT = SEARCH_WINDOW_TOP_BAR_HEIGHT;
export const SEARCH_LIST_MIN_HEIGHT = 120;

export const TYPE_MENU_MIN_LIST_SPACE = 240;
