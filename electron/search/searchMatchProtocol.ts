import type { SearchScoreDebugRow } from "../../shared/searchScoreDebug";

export type SearchWorkerInstalledApp = {
  Name: string;
  AppID: string;
  installTimeMs?: number;
};

export type SearchWorkerCandidate = {
  name: string;
  path: string;
  type: string;
  description?: string;
  timeMs?: number;
  size?: number;
  isDirectory?: boolean;
  source?: string;
  sourceScore?: number;
  metaFlags?: Record<string, unknown>;
  aliases?: string[];
  rawSource?: string;
};

export type SearchWorkerRankPayload = {
  sessionId: string;
  query: string;
  searchTypeId: string;
  lane: "fast" | "full";
  matchMode: "short" | "medium" | "full";
  isPathQuery: boolean;
  displayLimit: number;
  now: number;
  historyStats: any;
  searchRanking?: any;
  fileItems: SearchWorkerCandidate[];
  recentItems: SearchWorkerCandidate[];
  directItems: SearchWorkerCandidate[];
};

export type SearchWorkerRankResult = {
  items: SearchWorkerCandidate[];
  totalCount: number;
  scoreDebugRows?: SearchScoreDebugRow[];
  cancelled?: boolean;
};

export type SearchWorkerRequest =
  | { id: number; op: "syncAppsSnapshot"; payload: { apps: SearchWorkerInstalledApp[] } }
  | { id: number; op: "rankCandidatesFast"; payload: SearchWorkerRankPayload }
  | { id: number; op: "rankCandidatesFull"; payload: SearchWorkerRankPayload }
  | { id: number; op: "cancelSession"; payload: { sessionId: string } };

export type SearchWorkerResponse =
  | { id: number; ok: true; result?: any }
  | { id: number; ok: false; error: string };
