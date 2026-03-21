// 这里定义“跨渲染进程/主进程共享”的设置类型：
// - 目标是让两端引用同一份类型，避免字段新增/改名后只改一端导致不一致
// - 注意：该文件必须保持纯类型/纯常量，不得引用 electron/node 运行时 API

// 搜索结果右侧操作按钮：最多展示三项，用户可在设置里选择与排序
export type ResultActionButtonId = "openFolder" | "copyPath" | "deleteHistory" | "runAsAdmin";

// 搜索排序信号权重：保存为百分比风格数值（总和归一为 100）
export interface SearchRankingSignalWeights {
  match: number;
  frequency: number;
  recency: number;
  fileMtime: number;
}

// Frecency 参数：控制“时间衰减”和“频率放大”
export interface SearchRankingFrecency {
  decayFactor: number;
  frequencyWeight: number;
}

// 类型优先级：1-10，数值越大越优先
export interface SearchRankingTypePriority {
  app: number;
  command: number;
  settings: number;
  file: number;
  folder: number;
  image: number;
  video: number;
  web: number;
  plugin: number;
}

// 搜索排序总配置：用于主进程评分与设置页可视化编辑
export interface SearchRankingConfig {
  signalWeights: SearchRankingSignalWeights;
  frecency: SearchRankingFrecency;
  typePriority: SearchRankingTypePriority;
}

export interface AppSettings {
  autoStart: boolean;
  searchShortcut: string;
  settingsShortcut: string;
  // 面板内“写入选中项到输入框”的快捷键（默认 Alt+Enter）
  acceptSelectedResultShortcut: string;
  // 主题集合扩展为 12 款：4 个浅色（chrome/mac/blueprint/paper）+ 8 个深色（dark 与 7 个新增极客主题）
  theme:
    | "dark"
    | "terminal"
    | "vector"
    | "alloy"
    | "noir"
    | "signal"
    | "oxide"
    | "voltage"
    | "chrome"
    | "mac"
    | "blueprint"
    | "paper";
  uiFontFamily: string;
  historyLimit: number;
  defaultSearchTypeId: string;
  customSearchTypes: string[];
  searchTypeOrder: string[];
  disabledSearchTypeIds: string[];
  ignoredPaths: string[];
  keepStateOnClose: boolean;
  showResultPath: boolean;
  enableHistory: boolean;
  enableEffect: boolean;
  effectType: "particles" | "warp" | "waves";
  backgroundImagePath: string;
  backgroundImageOpacity: number;
  // 自定义头像：存储本地图片路径（通过主进程转为 dataUrl 显示）
  customAvatarPath: string;
  // 右侧按钮显示顺序：最多三项，由设置面板控制
  resultActionButtons: ResultActionButtonId[];

  // 搜索窗口尺寸：初始宽高（最小/最大限制由系统内部固定）
  searchWindowInitialWidth: number;
  searchWindowMaxHeight: number;

  // 搜索结果最大显示条数：用于限制 UI 列表渲染与交互成本
  searchDisplayLimit: number;

  // 结果排序参数：包含静态匹配、动态行为与类型优先级
  searchRanking: SearchRankingConfig;

  compactMode: boolean;

  // 常用文件扩展名（带点号，例如 ".docx"）：
  // - 用于索引构建时“优先处理这些类型的文件”，提升办公/学习场景的体验
  // - 仅影响索引构建顺序，不影响最终索引覆盖范围
  preferredFileExtensions: string[];
}
