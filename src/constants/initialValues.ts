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

// 主题色中文名称统一维护，避免各处文案不一致或出现乱码。
export const THEME_COLOR_OPTIONS: Array<{ name: string; color: string }> = [
  { name: "天际蓝", color: "#38bdf8" },
  { name: "罗兰紫", color: "#818cf8" },
  { name: "极光绿", color: "#34d399" },
  { name: "珊瑚粉", color: "#fb7185" },
  { name: "琥珀橙", color: "#fbbf24" },
  { name: "翡翠绿", color: "#10b981" },
  { name: "深海蓝", color: "#2563eb" },
  { name: "丁香紫", color: "#a855f7" },
  { name: "玫瑰红", color: "#f43f5e" },
  { name: "钛金灰", color: "#64748b" },
];

// 主题体系：保留 light/dark，并新增 6 套品牌风格主题。
export const THEME_STYLE_OPTIONS: Array<{ id: AppSettings["theme"]; label: string }> = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "steam", label: "Steam" },
  { id: "trae", label: "Trae" },
  { id: "chrome", label: "Chrome" },
  { id: "window11", label: "Windows 11" },
  { id: "linux", label: "Linux KDE" },
  { id: "mac", label: "macOS" },
];

export const RESULT_ACTION_OPTIONS: Array<{
  id: ResultActionButtonId;
  label: string;
  note?: string;
}> = [
  { id: "openFolder", label: "打开所在目录" },
  { id: "copyPath", label: "复制路径" },
  { id: "runAsAdmin", label: "使用管理员权限打开", note: "仅应用显示" },
  { id: "deleteHistory", label: "删除历史记录", note: "仅历史模式显示" },
];

export const SEARCH_ITEM_HEIGHT_COMPACT = 44;
export const SEARCH_ITEM_HEIGHT_NORMAL = 52;

export const SEARCH_WINDOW_TOP_BAR_HEIGHT = 76;
export const SEARCH_WINDOW_BOTTOM_BAR_HEIGHT = 90;

export const SEARCH_WINDOW_MIN_HEIGHT = SEARCH_WINDOW_TOP_BAR_HEIGHT;
export const SEARCH_LIST_MIN_HEIGHT = 120;

export const TYPE_MENU_MIN_LIST_SPACE = 240;
