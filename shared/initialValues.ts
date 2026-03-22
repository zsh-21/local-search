import type { AppSettings, ResultActionButtonId, SearchRankingConfig } from "./settingsTypes";

// 这里集中维护“跨渲染进程/主进程共享”的默认值：
// - 只放两端都必须一致的默认项（例如默认设置、默认快捷键、基础类型列表）
// - 渲染端/主进程各自独有的默认值仍放在各自的 constants/initialValues.ts 中

// 内置基础搜索类型：用于排序、禁用、下拉展示等逻辑的允许值集合
export const BASE_SEARCH_TYPE_IDS = ["all", "app", "file", "folder", "image", "video", "settings"] as const;

// 默认“呼出搜索窗口”的快捷键
export const DEFAULT_SEARCH_SHORTCUT = "Alt+S";
// 默认“打开设置窗口”的快捷键
export const DEFAULT_SETTINGS_SHORTCUT = "Alt+Shift+S";
// 默认“写入选中项到输入框”的面板内快捷键
export const DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT = "Alt+Enter";

// 默认搜索结果“右侧操作按钮”顺序
export const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ["openFolder", "copyPath", "deleteHistory"];

// 默认排序配置：
// - signalWeights 使用百分比风格数值，读取时会做归一化
// - typePriority 的 1-10 映射遵循“应用 > 系统命令 > 文件 > 网页 > 插件”
export const DEFAULT_SEARCH_RANKING: SearchRankingConfig = {
  signalWeights: {
    match: 40,
    frequency: 30,
    recency: 20,
    fileMtime: 10,
  },
  frecency: {
    decayFactor: 0.01,
    frequencyWeight: 1,
  },
  typePriority: {
    app: 10,
    command: 9,
    settings: 9,
    file: 8,
    folder: 8,
    image: 8,
    video: 8,
    web: 7,
    plugin: 6,
  },
};

// 默认设置（跨进程唯一默认来源）：
// - 主进程：settings.json 读取失败/字段缺失时回落
// - 渲染端：主进程尚未返回设置或返回异常时回落
// - 若需要新增设置字段，应优先在 shared/settingsTypes.ts 增加类型，再在这里补默认值
export const DEFAULT_SETTINGS = {
  // 是否开机启动
  autoStart: true,
  // 呼出搜索窗口快捷键
  searchShortcut: DEFAULT_SEARCH_SHORTCUT,
  // 打开设置窗口快捷键
  settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
  // 面板内写入选中项快捷键
  acceptSelectedResultShortcut: DEFAULT_ACCEPT_SELECTED_RESULT_SHORTCUT,
  // 主题
  theme: "dark",
  uiFontFamily: '"Microsoft YaHei", "Segoe UI", "Noto Sans", Arial, sans-serif',
  // 历史记录最大展示条数：0 表示不展示历史
  historyLimit: 5,
  // 默认搜索类型
  defaultSearchTypeId: "all",
  // 自定义扩展名搜索类型
  customSearchTypes: [],
  // 默认类型顺序
  searchTypeOrder: [...BASE_SEARCH_TYPE_IDS],
  // 被禁用的类型
  disabledSearchTypeIds: [],
  // 索引时需要跳过的路径
  ignoredPaths: [],
  // 关闭搜索窗口时是否保留输入/选择状态
  keepStateOnClose: true,
  // 默认显示路径
  showResultPath: true,
  // 是否启用历史记录
  enableHistory: true,
  // 背景特效功能已下线：不再保留特效开关与类型字段。
  // 背景图本地路径
  backgroundImagePath: "",
  // 背景图透明度：0~1
  backgroundImageOpacity: 0.25,
  // 自定义头像本地路径
  customAvatarPath: "",
  // 右侧按钮默认顺序
  resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
  // 搜索窗口初始宽度
  searchWindowInitialWidth: 600,
  // 搜索窗口最大高度
  searchWindowMaxHeight: 360,
  // 搜索结果最大显示条数
  searchDisplayLimit: 100,
  // 搜索排序默认配置
  searchRanking: {
    signalWeights: { ...DEFAULT_SEARCH_RANKING.signalWeights },
    frecency: { ...DEFAULT_SEARCH_RANKING.frecency },
    typePriority: { ...DEFAULT_SEARCH_RANKING.typePriority },
  },
  // 是否启用紧凑模式
  compactMode: false,
  // 常用文件扩展名（用于优先索引）
  preferredFileExtensions: [
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".pdf",
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".java",
    ".exe",
    ".msi",
    ".zip",
    ".rar",
    ".7z",
  ],
} satisfies AppSettings;
