// 这里定义“跨渲染进程/主进程共享”的设置类型：
// - 目的是让两端引用同一份类型，避免字段新增/改名后只改了一端导致不一致
// - 注意：该文件必须保持纯类型/纯常量，不得引用 electron/node 运行时 API

// 搜索结果右侧操作按钮：最多展示三项，用户可在设置里选择与排序
export type ResultActionButtonId = "openFolder" | "copyPath" | "deleteHistory" | "runAsAdmin";

export interface AppSettings {
  autoStart: boolean;
  searchShortcut: string;
  settingsShortcut: string;
  // 面板内“写入选中项到输入框”的快捷键（默认 Alt+Enter）
  acceptSelectedResultShortcut: string;
  theme: "dark" | "light" | "steam" | "trae" | "chrome" | "window11" | "linux" | "mac";
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
  // 自定义头像：存储本地图片路径（通过主进程转换为 dataUrl 显示），空字符串表示未自定义
  customAvatarPath: string;
  // 右侧按钮显示顺序：最多三项，由设置面板控制
  resultActionButtons: ResultActionButtonId[];

  // 搜索窗口尺寸：初始宽高（最小/最大限制由系统内部固定）
  searchWindowInitialWidth: number;
  searchWindowMaxHeight: number;

  // 搜索结果最大展示条数：用于限制 UI 列表渲染与交互成本
  searchDisplayLimit: number;

  compactMode: boolean;

  // 常用文件扩展名（带点号，例如 ".docx"）：
  // - 用于索引构建时“优先处理这些类型的文件”，提升办公/学习场景的边建边搜体验
  // - 仅影响索引构建顺序，不影响最终索引覆盖范围
  preferredFileExtensions: string[];
}
