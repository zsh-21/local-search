import type { AppSettings, ResultActionButtonId } from "../appTypes";
import { BASE_SEARCH_TYPE_IDS, DEFAULT_SETTINGS } from "../../shared/constants/initialValues";

export const API_BASE_URL = "http://localhost:3001";

export const FS_USER_KEY = "fs_user";
export const FS_TOKEN_KEY = "fs_token";
export const MEMBERSHIP_CHANGED_EVENT = "fs-membership-changed";

export const FS_LAST_LOGIN_ACCOUNT_KEY = "fs_last_login_account";
export const FS_LAST_LOGIN_PASSWORD_KEY = "fs_last_login_password";

export const FS_BACKUP_SETTINGS_KEY = "fs_backup_settings";

export { BASE_SEARCH_TYPE_IDS, DEFAULT_SETTINGS };

// 主题选项统一在这里维护，避免设置页和账户页出现不一致。
export const THEME_STYLE_OPTIONS: Array<{ id: AppSettings["theme"]; label: string }> = [
  { id: "dark", label: "Dark / 石墨工业基线" },
  { id: "dark-win", label: "dark win" },
  { id: "vector", label: "Night Glass / 极夜玻璃" },
  { id: "paper", label: "Cream Editorial / 奶油纸张" },
  { id: "blueprint", label: "Pixel Arcade / 复古像素电玩" },
  { id: "noir", label: "Obsidian Luxe / 奢雅黑金" },
  { id: "mac", label: "Pastel Flux / 糖霜未来" },
  { id: "oxide", label: "Ember Mono / 赭焰极简" },
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

