// 统一定义应用侧核心类型：搜索结果与设置结构
export interface AppItem {
  name: string;
  path: string;
  description?: string;
  icon?: string;
  type?: string;
}

export interface SearchResponse {
  results: AppItem[];
  isIndexing: boolean;
  // 搜索会话 ID：用于与后台分批推送的 more-results 对齐，避免切换类型/重复搜索导致重复项
  searchSessionId?: string;
  // 是否还有更多结果：用于 UI/逻辑判断（兼容旧字段）
  hasMore?: boolean;
  // 本次搜索命中的总数量：用于展示“总结果数”与“超过 500 的提示”
  totalCount?: number;
}

export interface AppSettings {
  autoStart: boolean;
  searchShortcut: string;
  settingsShortcut: string;
  theme: "dark" | "light";
  historyLimit: number;
  defaultSearchTypeId: string;
  customSearchTypes: string[];
  searchTypeOrder: string[];
  disabledSearchTypeIds: string[];
  ignoredPaths: string[];
  keepStateOnClose: boolean;
  showResultPath: boolean;
  enableHistory: boolean;
  accentColor: string;
  enableEffect: boolean;
  effectType: "particles" | "warp" | "waves";
  backgroundImagePath: string;
  backgroundImageOpacity: number;
  // 右侧按钮显示顺序：最多三项，由设置面板控制
  resultActionButtons: ResultActionButtonId[];
}

// 搜索结果右侧操作按钮：最多展示三项，用户可在设置里选择与排序
export type ResultActionButtonId = "openFolder" | "copyPath" | "deleteHistory";

export const DEFAULT_SETTINGS: AppSettings = {
  autoStart: false,
  searchShortcut: "Alt+T",
  settingsShortcut: "Alt+Shift+T",
  theme: "dark",
  historyLimit: 5,
  defaultSearchTypeId: "all",
  customSearchTypes: [],
  searchTypeOrder: ["all", "file", "folder", "image", "video", "settings"],
  disabledSearchTypeIds: [],
  ignoredPaths: [],
  keepStateOnClose: false,
  showResultPath: false,
  enableHistory: true,
  accentColor: "#38bdf8",
  enableEffect: false,
  effectType: "particles",
  backgroundImagePath: "",
  backgroundImageOpacity: 0.25,
  resultActionButtons: ["openFolder", "copyPath", "deleteHistory"],
};

export type SearchTypeOption = { id: string; label: string };

