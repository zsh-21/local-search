// 统一定义应用侧核心类型：搜索结果与设置结构
export interface AppItem {
  name: string;
  path: string;
  description?: string;
  icon?: string;
  iconKey?: string;
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

// 设置类型已抽离到 shared：渲染端/主进程共享同一份类型，避免字段/默认值漂移
export type { AppSettings, ResultActionButtonId } from "../shared/settingsTypes";

// 默认设置已抽离到单独文件：便于你后续集中调整
export { DEFAULT_SETTINGS } from "./constants/initialValues";

export type SearchTypeOption = { id: string; label: string };

