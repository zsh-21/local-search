import type { AppSettings, ResultActionButtonId } from "../config/settings";

// 这里集中维护“主进程侧可调的初始值/默认值”：
// - 主进程涉及窗口尺寸、快捷键、索引策略等，初始值散落会导致改动容易漏
// - 严格保持与现有逻辑一致：仅抽离常量，不改变原有功能

// =========================
// 设置默认值（主进程侧）
// =========================

// 内置基础搜索类型：用于排序/禁用等允许值集合
export const BASE_SEARCH_TYPE_IDS = ["all", "app", "file", "folder", "image", "video", "settings"] as const;

// 默认快捷键（Windows）：用于首次安装/配置缺失时回落
export const DEFAULT_SEARCH_SHORTCUT = "Alt+T";
export const DEFAULT_SETTINGS_SHORTCUT = "Alt+Shift+T";

// 默认右侧按钮顺序：用于配置缺失时回落
export const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ["openFolder", "copyPath", "deleteHistory"];

// 主进程侧默认设置：loadSettings 读盘失败或字段缺失时的最终回落
export const DEFAULT_SETTINGS = {
  autoStart: false,
  searchShortcut: DEFAULT_SEARCH_SHORTCUT,
  settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
  theme: "dark",
  historyLimit: 5,
  defaultSearchTypeId: "all",
  customSearchTypes: [],
  searchTypeOrder: [...BASE_SEARCH_TYPE_IDS],
  disabledSearchTypeIds: [],
  ignoredPaths: [],
  keepStateOnClose: false,
  showResultPath: true,
  enableHistory: true,
  accentColor: "#38bdf8",
  enableEffect: false,
  effectType: "particles",
  backgroundImagePath: "",
  backgroundImageOpacity: 0.25,
  customAvatarPath: "",
  resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
  searchWindowInitialWidth: 720,
  searchWindowMaxHeight: 760,
  searchDisplayLimit: 50,
  compactMode: false,
} satisfies AppSettings;

// =========================
// 窗口初始值（主进程侧）
// =========================

// 搜索窗口初始高度：首次展示只展示输入框（后续由渲染进程动态 resize）
export const SEARCH_WINDOW_INITIAL_HEIGHT = 76;
// 主进程窗口默认背景色：与渲染侧主题保持一致（避免透明/闪烁）
export const WINDOW_BACKGROUND_COLOR = "#0f172a";

// 设置窗口初始尺寸与最小限制：避免窗口太小导致设置项布局错乱
export const SETTINGS_WINDOW_INITIAL_WIDTH = 680;
export const SETTINGS_WINDOW_INITIAL_HEIGHT = 520;
export const SETTINGS_WINDOW_MIN_WIDTH = 560;
export const SETTINGS_WINDOW_MIN_HEIGHT = 520;

// =========================
// 文件索引初始值（主进程侧）
// =========================

// 索引版本：结构变更时递增，用于触发重建
export const FILE_INDEX_VERSION = 5;

// Worker 数量限制：避免过多线程竞争导致性能抖动
export const FILE_INDEX_WORKER_MIN = 2;
export const FILE_INDEX_WORKER_MAX = 4;

// Worker 堆大小上限：索引占用内存较多，默认上限容易触发 OOM
export const FILE_INDEX_WORKER_HEAP_MB_FOR_4 = 1536;
export const FILE_INDEX_WORKER_HEAP_MB_DEFAULT = 2048;

// 索引最大条目数上限：防止超大索引导致内存不可控
export const FILE_INDEX_TOTAL_MAX_ENTRIES_CAP = 2_000_000;
export const FILE_INDEX_ENTRIES_PER_WORKER = 400_000;

// =========================
// 文件类型/目录过滤初始值（主进程侧）
// =========================

// 图片文件扩展名集合
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
// 视频文件扩展名集合
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
// 快捷方式扩展名集合：跳过可减少搜索结果冗余
export const SHORTCUT_EXTENSIONS = new Set([".lnk", ".url"]);

// 需要跳过的目录名：过滤开发工具配置目录、版本控制目录、系统回收站/卷信息等
export const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".svn", ".idea", "$recycle.bin", "system volume information"]);
