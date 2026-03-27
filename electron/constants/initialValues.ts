/** 主进程侧默认设置：与渲染侧共享的默认值从 shared 统一导出 */
export {
  BASE_SEARCH_TYPE_IDS,
  DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT,
  DEFAULT_RESULT_ACTION_BUTTONS,
  DEFAULT_SEARCH_SHORTCUT,
  DEFAULT_SETTINGS,
  DEFAULT_SETTINGS_SHORTCUT,
} from "../../shared/initialValues";

/** 搜索窗口初始高度：首次仅展示输入区域 */
export const SEARCH_WINDOW_INITIAL_HEIGHT = 76;
/** 主进程窗口背景色：避免透明闪烁 */
export const WINDOW_BACKGROUND_COLOR = "#0f172a";

/** 设置窗口初始宽度 */
export const SETTINGS_WINDOW_INITIAL_WIDTH = 680;
/** 设置窗口初始高度 */
export const SETTINGS_WINDOW_INITIAL_HEIGHT = 520;
/** 设置窗口最小宽度 */
export const SETTINGS_WINDOW_MIN_WIDTH = 560;
/** 设置窗口最小高度 */
export const SETTINGS_WINDOW_MIN_HEIGHT = 520;

/** 索引版本号：结构变更时递增 */
export const FILE_INDEX_VERSION = 4;
/** 索引布局版本号：布局与迁移规则变更时递增 */
export const FILE_INDEX_LAYOUT_VERSION = 2;

/** 索引 Worker 最小数量 */
export const FILE_INDEX_WORKER_MIN = 1;
/** 索引并发计算保留 CPU 核数 */
export const FILE_INDEX_WORKER_CPU_RESERVE = 1;
/** 索引并发计算预留内存（MB） */
export const FILE_INDEX_WORKER_MEMORY_HEADROOM_MB = 1024;
/** 每个 Worker 最小可用内存预算（MB） */
export const FILE_INDEX_WORKER_MIN_FREE_MB_PER_WORKER = 512;

/** 索引总条目上限 */
export const FILE_INDEX_TOTAL_MAX_ENTRIES_CAP = 2_000_000;
/** 每个 Worker 的目标条目容量 */
export const FILE_INDEX_ENTRIES_PER_WORKER = 500_000;

/** 盘符根路径刷新间隔（空闲态） */
export const WINDOWS_ROOTS_REFRESH_IDLE_INTERVAL_MS = 15 * 1000;
/** 盘符根路径刷新间隔（索引态） */
export const WINDOWS_ROOTS_REFRESH_INDEXING_INTERVAL_MS = 90 * 1000;
/** 盘符根路径刷新间隔（失败兜底） */
export const WINDOWS_ROOTS_REFRESH_FAILSAFE_INTERVAL_MS = 30 * 1000;
/** watcher backlog 触发补偿扫描阈值 */
export const WATCH_BACKLOG_RECONCILE_THRESHOLD = 300;

/** 索引状态写盘轮询间隔（索引中） */
export const INDEX_STATS_REFRESH_INDEXING_INTERVAL_MS = 2 * 1000;
/** 索引状态写盘轮询间隔（完成后冷却） */
export const INDEX_STATS_REFRESH_COOLDOWN_INTERVAL_MS = 5 * 1000;
/** 索引状态写盘轮询间隔（稳定空闲） */
export const INDEX_STATS_REFRESH_IDLE_INTERVAL_MS = 15 * 1000;
/** 索引状态写盘轮询间隔（异常兜底） */
export const INDEX_STATS_REFRESH_FAILSAFE_INTERVAL_MS = 10 * 1000;
/** 索引状态轮询最小驻留时间 */
export const INDEX_STATS_REFRESH_MIN_STAY_MS = 10 * 1000;
/** 索引完成后冷却窗口 */
export const INDEX_STATS_REFRESH_COOLDOWN_WINDOW_MS = 30 * 1000;

/** 图片扩展名集合 */
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
/** 视频扩展名集合 */
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
/** 快捷方式扩展名集合 */
export const SHORTCUT_EXTENSIONS = new Set([".lnk", ".url"]);
/** 需要跳过的目录名集合 */
export const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".svn", ".idea", "$recycle.bin", "system volume information"]);
