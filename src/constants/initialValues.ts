import type { AppSettings } from "../appTypes";

// 这里集中维护“项目内可调的初始值/默认值”：
// - 便于你后续只改一处就能影响全局行为
// - 严格保持与现有逻辑一致：仅抽离常量，不改变原有功能

// =========================
// 后端接口默认值
// =========================

// 默认后端地址：渲染进程通过主进程代理请求该地址
export const API_BASE_URL = "http://localhost:3001";

// =========================
// localStorage Key（统一入口）
// =========================

// 当前登录用户信息（JSON 字符串）
export const FS_USER_KEY = "fs_user";
// 当前登录 token（字符串）
export const FS_TOKEN_KEY = "fs_token";
// 会员状态变化事件：用于跨窗口/跨页面刷新会员 UI 与能力开关
export const MEMBERSHIP_CHANGED_EVENT = "fs-membership-changed";

// 账号登录表单“上次输入”缓存：用于打开设置页时自动回填
export const FS_LAST_LOGIN_ACCOUNT_KEY = "fs_last_login_account";
export const FS_LAST_LOGIN_PASSWORD_KEY = "fs_last_login_password";

// 备份配置（会员降级时保存一份高级配置，会员恢复后再还原）
export const FS_BACKUP_SETTINGS_KEY = "fs_backup_settings";

// =========================
// 设置默认值（渲染端唯一默认来源）
// =========================

// 内置基础搜索类型：用于排序、禁用、下拉展示等逻辑的允许值集合
export const BASE_SEARCH_TYPE_IDS = ["all", "app", "file", "folder", "image", "video", "settings"] as const;

// 应用侧默认设置：当主进程未返回/配置缺失时统一回落到这里
export const DEFAULT_SETTINGS = {
  autoStart: false,
  searchShortcut: "Alt+T",
  settingsShortcut: "Alt+Shift+T",
  theme: "dark",
  historyLimit: 5,
  defaultSearchTypeId: "all",
  customSearchTypes: [],
  // 默认类型顺序：包含“应用”类型，便于 Tab/Shift+Tab 快速切换
  searchTypeOrder: [...BASE_SEARCH_TYPE_IDS],
  disabledSearchTypeIds: [],
  ignoredPaths: [],
  keepStateOnClose: false,
  // 默认显示路径：便于区分同名文件，且不再作为会员功能限制
  showResultPath: true,
  enableHistory: true,
  accentColor: "#38bdf8",
  enableEffect: false,
  effectType: "particles",
  backgroundImagePath: "",
  backgroundImageOpacity: 0.25,
  // 自定义头像：存储本地图片路径（通过主进程转换为 dataUrl 显示），空字符串表示未自定义
  customAvatarPath: "",
  // 搜索结果右侧操作按钮：最多展示三项，用户可在设置里选择与排序
  resultActionButtons: ["openFolder", "copyPath", "deleteHistory"],
  // 搜索窗口尺寸：初始宽高（最小/最大限制由系统内部固定）
  searchWindowInitialWidth: 720,
  searchWindowMaxHeight: 760,
  // 搜索结果最大展示条数：用于限制 UI 列表渲染与交互成本
  searchDisplayLimit: 50,
  compactMode: false,
} satisfies AppSettings;

// =========================
// 设置页可选项（用于下拉/按钮渲染）
// =========================

// 主题强调色候选：用于外观设置页的颜色选择
export const THEME_COLOR_OPTIONS: Array<{ name: string; color: string }> = [
  { name: "天际蓝", color: "#38bdf8" },
  { name: "罗兰紫", color: "#818cf8" },
  { name: "极光绿", color: "#34d399" },
  { name: "珊瑚红", color: "#fb7185" },
  { name: "琥珀橙", color: "#fbbf24" },
  { name: "翡翠绿", color: "#10b981" },
  { name: "深海蓝", color: "#2563eb" },
  { name: "丁香紫", color: "#a855f7" },
  { name: "玫瑰金", color: "#f43f5e" },
  { name: "钛金灰", color: "#64748b" },
] ;

// 搜索结果右侧按钮配置：新增按钮时，只需追加选项与对应渲染逻辑
export const RESULT_ACTION_OPTIONS: Array<{
  id: AppSettings["resultActionButtons"][number];
  label: string;
  note?: string;
}> = [
  { id: "openFolder", label: "打开所在目录" },
  { id: "copyPath", label: "复制路径" },
  // 管理员运行仅对“应用”有意义：文件/文件夹等不展示该按钮
  { id: "runAsAdmin", label: "使用管理员权限打开", note: "仅应用显示" },
  { id: "deleteHistory", label: "删除历史记录", note: "仅历史模式显示" },
];

// =========================
// 搜索页布局/交互初始值（便于统一调整）
// =========================

// 紧凑模式与普通模式的单项高度（影响列表虚拟滚动与窗口自适应高度）
export const SEARCH_ITEM_HEIGHT_COMPACT = 44;
export const SEARCH_ITEM_HEIGHT_NORMAL = 52;

// 搜索窗口可视区域的“固定占位高度”：用于推导列表最大高度
export const SEARCH_WINDOW_TOP_BAR_HEIGHT = 76;
export const SEARCH_WINDOW_BOTTOM_BAR_HEIGHT = 90;

// 搜索窗口最小高度：用于 resize 兜底，避免窗口高度过小导致输入/列表布局错乱
export const SEARCH_WINDOW_MIN_HEIGHT = SEARCH_WINDOW_TOP_BAR_HEIGHT;

// 列表最小高度：避免窗口太矮导致交互困难
export const SEARCH_LIST_MIN_HEIGHT = 120;

// 类型下拉菜单最小可用空间：空间不足时走“向上展开/压缩”等策略
export const TYPE_MENU_MIN_LIST_SPACE = 240;
