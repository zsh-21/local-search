export type SearchTypeId = string;

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
  // 预留给插件/外部结果的原始分：后续可通过大分差固定插件内顺序
  sourceScore?: number;
  // 静态匹配归一分（0-1）：便于统一进入加权模型
  staticScore?: number;
  weightedScore?: number;
  matchIndex?: number;
  nameLen?: number;
};

export type SearchExecResult =
  | { kind: "continue"; items: SearchCandidate[]; meta?: { isIndexing?: boolean; totalCount?: number } }
  | { kind: "return"; response: { results: any[]; isIndexing: boolean; hasMore: boolean; searchSessionId: string; totalCount: number } };

export type SearchContext = {
  event: Electron.IpcMainInvokeEvent;
  query: string;
  lowerQuery: string;
  // 索引状态提示：用于策略在索引期降低负载、优先响应输入。
  isIndexingHint: boolean;
  // 路径型查询提示：用于调整评分与匹配字段。
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
    scoreRecentName: (name: string) => number;
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

export type SearchStrategyDeps = {
  fileIndex: {
    getStatus: () => Promise<{ isIndexing: boolean }>;
    search: (query: string, limit: number, options?: { where?: any; sessionId?: string }) => Promise<any>;
    buildIfEmpty: () => Promise<void>;
    cancelSearchSession?: (sessionId: string) => void | Promise<void>;
  };
  loadSettings: () => { customSearchTypes?: string[]; ignoredPaths?: string[]; searchRanking?: any };
  loadHistoryStats: () => any;
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

export type SearchStrategy = {
  id: string;
  execute: (ctx: SearchContext, deps: SearchStrategyDeps) => Promise<SearchExecResult>;
};
