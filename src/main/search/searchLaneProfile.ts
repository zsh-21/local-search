export type SearchMatchMode = "short" | "medium" | "full";

export type SearchLaneProfile = {
  matchMode: SearchMatchMode;
  fastFileLimit: number;
  fullFileLimit: number;
  fastRecentLimit: number;
  fullRecentLimit: number;
  enableFullLane: boolean;
};

function clampInt(value: number, min: number, max: number) {
  const n = Math.floor(Number(value) || 0);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function scaleLimit(value: number, factor: number) {
  return Math.max(0, Math.floor(value * factor));
}

export function createSearchLaneProfile(input: {
  queryLength: number;
  isIndexingHint: boolean;
  searchTypeId: string;
}): SearchLaneProfile {
  const queryLength = Math.max(1, Math.floor(Number(input.queryLength) || 1));
  const searchTypeId = typeof input.searchTypeId === "string" ? input.searchTypeId : "all";
  const isAllOrFile = searchTypeId === "all" || searchTypeId === "file";
  const isIndexingHint = Boolean(input.isIndexingHint);

  let matchMode: SearchMatchMode = "full";
  let fastFileLimit = isAllOrFile ? 90 : 160;
  let fullFileLimit = isAllOrFile ? 260 : 520;
  let fastRecentLimit = 20;
  let fullRecentLimit = 80;
  let enableFullLane = true;

  if (queryLength <= 1) {
    matchMode = "short";
    fastFileLimit = 0;
    fullFileLimit = 0;
    fastRecentLimit = 8;
    fullRecentLimit = 16;
    enableFullLane = false;
  } else if (queryLength === 2) {
    matchMode = "short";
    fastFileLimit = isAllOrFile ? 24 : 40;
    fullFileLimit = isAllOrFile ? 42 : 80;
    fastRecentLimit = 12;
    fullRecentLimit = 24;
    enableFullLane = false;
  } else if (queryLength <= 4) {
    matchMode = "medium";
    fastFileLimit = isAllOrFile ? 60 : 120;
    fullFileLimit = isAllOrFile ? 180 : 360;
    fastRecentLimit = 16;
    fullRecentLimit = 60;
    enableFullLane = true;
  }

  if (isIndexingHint) {
    fastFileLimit = scaleLimit(fastFileLimit, 0.8);
    fullFileLimit = scaleLimit(fullFileLimit, 0.85);
    fastRecentLimit = scaleLimit(fastRecentLimit, 0.9);
    fullRecentLimit = scaleLimit(fullRecentLimit, 0.9);
  }

  fastFileLimit = clampInt(fastFileLimit, 0, 1500);
  fullFileLimit = clampInt(Math.max(fullFileLimit, fastFileLimit), 0, 4000);
  fastRecentLimit = clampInt(fastRecentLimit, 0, 300);
  fullRecentLimit = clampInt(Math.max(fullRecentLimit, fastRecentLimit), 0, 600);

  return {
    matchMode,
    fastFileLimit,
    fullFileLimit,
    fastRecentLimit,
    fullRecentLimit,
    enableFullLane,
  };
}

