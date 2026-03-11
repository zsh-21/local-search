export type SearchTypeId = string;

export type SearchCandidate = {
  name: string;
  path: string;
  type: string;
  description?: string;
  icon?: string;
  timeMs?: number;
  size?: number;
  isDirectory?: boolean;
  score?: number;
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
  searchTypeId: SearchTypeId;
  searchSessionId: string;
  driveFilter: string;
  extFilter: string;
  now: number;
  nameScorer: {
    computeWeightedNameMatch: (name: string) => { weightedScore: number; matchIndex: number; nameLen: number };
    scoreRecentName: (name: string) => number;
  };
  scoreComputer: {
    getLastUsedMs: (rawPath: string) => number;
    computeCombinedScore: (baseScore: number, type: string, rawPath: string, timeMs: number) => number;
  };
};

export type SearchStrategyDeps = {
  fileIndex: {
    getStatus: () => Promise<{ isIndexing: boolean }>;
    pauseIndexingFor: (ms: number) => void | Promise<void>;
    search: (query: string, limit: number, options?: { where?: any }) => Promise<any>;
    buildIfEmpty: () => Promise<void>;
  };
  reconcileRecentIndex: () => void | Promise<void>;
  loadSettings: () => { customSearchTypes?: string[]; ignoredPaths?: string[] };
  loadHistoryStats: () => any;
  normalizeHistoryKey: (rawPath: string) => string;
  normalizeExtKey: (rawPath: string) => string;
  getInstalledApps: () => Array<{ Name: string; AppID: string }>;
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
