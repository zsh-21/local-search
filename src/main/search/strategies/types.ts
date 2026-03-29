export type SearchTypeId = string;

/** 搜索结果项的公共形状，供各策略统一复用。 */
export type SearchCandidate = {
  name: string;
  path: string;
  type: string;
  description?: string;
  iconKey?: string;
  timeMs?: number;
  size?: number;
  isDirectory?: boolean;
  score?: number;
  /** 预留给外部结果的原始分值，后续可以通过统一规则参与排序。 */
  sourceScore?: number;
  /** 静态匹配归一分值，便于统一进入加权模型。 */
  staticScore?: number;
  weightedScore?: number;
  matchIndex?: number;
  nameLen?: number;
};

/** 策略执行结果，返回分支只保留通用结果数组，避免引入不必要的宽类型。 */
export type SearchExecResult =
  | { kind: "continue"; items: SearchCandidate[]; meta?: { isIndexing?: boolean; totalCount?: number } }
  | {
      kind: "return";
      response: {
        results: unknown[];
        isIndexing: boolean;
        hasMore: boolean;
        searchSessionId: string;
        totalCount: number;
      };
    };

/** 搜索上下文，承载单次查询过程中的全部运行时参数。 */
export type SearchContext = {
  event: Electron.IpcMainInvokeEvent;
  query: string;
  lowerQuery: string;
  /** 索引状态提示，用于策略在索引期降低负载并优先响应输入。 */
  isIndexingHint: boolean;
  /** 路径型查询提示，用于调整评分与匹配字段。 */
  isPathQuery: boolean;
  searchTypeId: SearchTypeId;
  searchSessionId: string;
  isSessionCancelled: () => boolean;
  lane: "fast" | "full";
  queryLength: number;
  fileSearchLimit: number;
  recentLimit: number;
  driveFilter: string;
  extFilter: string;
  now: number;
  nameScorer: {
    computeWeightedNameMatch: (name: string) => { weightedScore: number; staticScore: number; matchIndex: number; nameLen: number };
  };
  scoreComputer: {
    getLastUsedMs: (rawPath: string) => number;
    computeCombinedScore: (input: {
      staticScore: number;
      type: string;
      rawPath: string;
      timeMs?: number;
      sourceScore?: number;
    }) => number;
  };
};

/** 策略依赖集合，集中描述文件索引、设置和图标等外部能力。 */
export type SearchStrategyDeps = {
  fileIndex: {
    getStatus: () => Promise<{ isIndexing: boolean }>;
    search: (query: string, limit: number, options?: { where?: unknown; sessionId?: string }) => Promise<unknown>;
    buildIfEmpty: () => Promise<void>;
    cancelSearchSession?: (sessionId: string) => void | Promise<void>;
  };
  loadSettings: () => { customSearchTypes?: string[]; ignoredPaths?: string[]; searchRanking?: unknown };
  loadHistoryStats: () => unknown;
  normalizeHistoryKey: (rawPath: string) => string;
  normalizeExtKey: (rawPath: string) => string;
  getInstalledApps: () => Array<{ Name: string; AppID: string; installTimeMs?: number }>;
  normalizeAppGroupKey: (name: string) => string;
  iconDataCache: Map<string, string>;
  isTooSmallAppIconDataUrl: (value: string) => boolean;
  getAppIconDataStable: (appName: string, appId: string, maxAttempts?: number) => Promise<string>;
  getFileIconData: (filePath: string) => Promise<string>;
  isIgnoredPathByCache: (targetPath: string) => boolean;
  normalizeRecentKey: (rawPath: string) => string;
  recentIndex: Map<string, { path: string; name: string; isDirectory: boolean; timeMs: number }>;
  getCurrentIconPrefetchToken: () => number;
  currentIconPrefetchToken: number;
};

/** 搜索策略统一接口，负责接收上下文并返回结果。 */
export type SearchStrategy = {
  id: string;
  execute: (ctx: SearchContext, deps: SearchStrategyDeps) => Promise<SearchExecResult>;
};
