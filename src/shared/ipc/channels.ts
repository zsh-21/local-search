/** IPC 请求通道：获取设备标识 */
export const IPC_GET_DEVICE_ID = "get-device-id";
/** IPC 请求通道：搜索窗口渲染端就绪握手 */
export const IPC_SEARCH_VIEW_READY = "search-view-ready";
/** IPC 请求通道：切换搜索窗口失焦隐藏能力 */
export const IPC_SET_SEARCH_BLUR_HIDE_ENABLED = "set-search-blur-hide-enabled";
/** IPC 请求通道：设置窗口渲染端就绪握手 */
export const IPC_SETTINGS_VIEW_READY = "settings-view-ready";
/** IPC 请求通道：主进程代理登录请求 */
export const IPC_LOGIN_REQUEST = "login-request";
/** IPC 请求通道：隐藏当前窗口 */
export const IPC_HIDE_WINDOW = "hide-window";
/** IPC 请求通道：最小化当前窗口 */
export const IPC_MINIMIZE_WINDOW = "minimize-window";
/** IPC 请求通道：调整窗口尺寸 */
export const IPC_RESIZE_WINDOW = "resize-window";
/** IPC 请求通道：打开设置窗口 */
export const IPC_OPEN_SETTINGS_WINDOW = "open-settings-window";
/** IPC 请求通道：切换窗口最大化状态 */
export const IPC_TOGGLE_MAXIMIZE = "toggle-maximize";
/** IPC 请求通道：读取设置 */
export const IPC_GET_SETTINGS = "get-settings";
/** IPC 请求通道：读取启动快照 */
export const IPC_GET_APP_BOOTSTRAP_STATE = "get-app-bootstrap-state";
/** IPC 请求通道：读取索引进度 */
export const IPC_GET_INDEX_PROGRESS = "get-index-progress";
/** IPC 请求通道：选择背景图 */
export const IPC_SELECT_BACKGROUND_IMAGE = "select-background-image";
/** IPC 请求通道：选择头像图 */
export const IPC_SELECT_AVATAR_IMAGE = "select-avatar-image";
/** IPC 请求通道：读取图片 dataUrl */
export const IPC_GET_IMAGE_DATA_URL = "get-image-data-url";
/** IPC 请求通道：保存设置 */
export const IPC_SAVE_SETTINGS = "save-settings";
/** IPC 请求通道：读取历史 */
export const IPC_GET_HISTORY = "get-history";
/** IPC 请求通道：清空历史 */
export const IPC_CLEAR_HISTORY = "clear-history";
/** IPC 请求通道：删除单条历史 */
export const IPC_DELETE_HISTORY_ITEM = "delete-history-item";
/** IPC 请求通道：读取计算历史 */
export const IPC_GET_CALC_HISTORY = "get-calc-history";
/** IPC 请求通道：写入计算历史 */
export const IPC_RECORD_CALC_HISTORY_ITEM = "record-calc-history-item";
/** IPC 请求通道：删除计算历史 */
export const IPC_DELETE_CALC_HISTORY_ITEM = "delete-calc-history-item";
/** IPC 请求通道：读取索引运行时信息 */
export const IPC_GET_INDEX_RUNTIME_INFO = "get-index-runtime-info";
/** IPC 请求通道：清理本地缓存 */
export const IPC_CLEAR_CACHE = "clear-cache";
/** IPC 请求通道：打开任意搜索项 */
export const IPC_OPEN_ITEM = "open-item";
/** IPC 请求通道：打开应用 */
export const IPC_OPEN_APP = "open-app";
/** IPC 请求通道：打开所在目录 */
export const IPC_OPEN_FOLDER = "open-folder";
/** IPC 请求通道：以管理员运行 */
export const IPC_RUN_AS_ADMIN = "run-as-admin";
/** IPC 请求通道：打开外链 */
export const IPC_OPEN_EXTERNAL = "open-external";
/** IPC 请求通道：读取结果图标 */
export const IPC_GET_RESULT_ICON = "get-result-icon";
/** IPC 请求通道：批量读取图标缓存 */
export const IPC_GET_ICONS_BY_KEYS = "get-icons-by-keys";
/** IPC 请求通道：执行搜索 */
export const IPC_SEARCH_FILES = "search-files";

/** IPC 事件通道：重置搜索状态 */
export const IPC_EVENT_RESET_SEARCH = "reset-search";
/** IPC 事件通道：搜索窗口隐藏 */
export const IPC_EVENT_SEARCH_WINDOW_HIDDEN = "search-window-hidden";
/** IPC 事件通道：搜索窗口打开 */
export const IPC_EVENT_SEARCH_WINDOW_OPENED = "search-window-opened";
/** IPC 事件通道：设置窗口打开 */
export const IPC_EVENT_SETTINGS_WINDOW_OPENED = "settings-window-opened";
/** IPC 事件通道：历史更新 */
export const IPC_EVENT_HISTORY_UPDATED = "history-updated";
/** IPC 事件通道：计算历史更新 */
export const IPC_EVENT_CALC_HISTORY_UPDATED = "calc-history-updated";
/** IPC 事件通道：设置更新 */
export const IPC_EVENT_SETTINGS_UPDATED = "settings-updated";
/** IPC 事件通道：索引手动刷新完成 */
export const IPC_EVENT_INDEX_MANUAL_REFRESH_DONE = "index-manual-refresh-done";
/** IPC 事件通道：搜索增量结果 */
export const IPC_EVENT_MORE_RESULTS = "more-results";
/** IPC 事件通道：图标更新 */
export const IPC_EVENT_ICONS_UPDATED = "icons-updated";
