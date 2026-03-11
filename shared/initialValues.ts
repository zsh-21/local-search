import type { AppSettings, ResultActionButtonId } from "./settingsTypes";

// 这里集中维护“跨渲染进程/主进程共享”的默认值：
// - 只放两端都必须一致的默认项（例如默认设置、默认快捷键、基础类型列表）
// - 渲染端/主进程各自独有的默认值仍放在各自的 constants/initialValues.ts 中

// 内置基础搜索类型：用于排序、禁用、下拉展示等逻辑的允许值集合
export const BASE_SEARCH_TYPE_IDS = ["all", "app", "file", "folder", "image", "video", "settings"] as const;

// 默认快捷键：两端必须一致，否则会出现 UI 初始显示与主进程真实生效不一致
export const DEFAULT_SEARCH_SHORTCUT = "Alt+S";
export const DEFAULT_SETTINGS_SHORTCUT = "Alt+Shift+S";

// 默认右侧按钮顺序：用于配置缺失时回落
export const DEFAULT_RESULT_ACTION_BUTTONS: ResultActionButtonId[] = ["openFolder", "copyPath", "deleteHistory"];

// 默认设置：两端统一从这里拿，避免“维护两份默认值”导致漂移
export const DEFAULT_SETTINGS = {
  autoStart: false,
  searchShortcut: DEFAULT_SEARCH_SHORTCUT,
  settingsShortcut: DEFAULT_SETTINGS_SHORTCUT,
  theme: "dark",
  historyLimit: 5,
  defaultSearchTypeId: "all",
  customSearchTypes: [],
  // 默认类型顺序：包含“应用”类型，便于 Tab/Shift+Tab 快速切换
  searchTypeOrder: [...BASE_SEARCH_TYPE_IDS],
  disabledSearchTypeIds: [],
  ignoredPaths: [],
  keepStateOnClose: true,
  // 默认显示路径：便于区分同名文件
  showResultPath: true,
  enableHistory: true,
  accentColor: "#38bdf8",
  enableEffect: false,
  effectType: "particles",
  backgroundImagePath: "",
  backgroundImageOpacity: 0.25,
  customAvatarPath: "",
  resultActionButtons: DEFAULT_RESULT_ACTION_BUTTONS,
  searchWindowInitialWidth: 350,
  searchWindowMaxHeight: 360,
  searchDisplayLimit: 50,
  compactMode: false,
} satisfies AppSettings;
