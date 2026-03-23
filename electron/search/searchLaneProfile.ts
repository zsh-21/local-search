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
  return Math.max(10, Math.floor(value * factor));
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
  let fastFileLimit = isAllOrFile ? 220 : 320;
  let fullFileLimit = isAllOrFile ? 500 : 900;
  let fastRecentLimit = 48;
  let fullRecentLimit = 120;

  if (queryLength <= 2) {
    matchMode = "short";
    fastFileLimit = isAllOrFile ? 70 : 120;
    fullFileLimit = isAllOrFile ? 160 : 260;
    fastRecentLimit = 16;
    fullRecentLimit = 40;
  } else if (queryLength <= 4) {
    matchMode = "medium";
    fastFileLimit = isAllOrFile ? 120 : 220;
    fullFileLimit = isAllOrFile ? 300 : 520;
    fastRecentLimit = 32;
    fullRecentLimit = 80;
  }

  if (isIndexingHint) {
    fastFileLimit = scaleLimit(fastFileLimit, 0.7);
    fullFileLimit = scaleLimit(fullFileLimit, 0.75);
    fastRecentLimit = scaleLimit(fastRecentLimit, 0.8);
    fullRecentLimit = scaleLimit(fullRecentLimit, 0.85);
  }

  fastFileLimit = clampInt(fastFileLimit, 20, 1500);
  fullFileLimit = clampInt(Math.max(fullFileLimit, fastFileLimit + 20), 40, 4000);
  fastRecentLimit = clampInt(fastRecentLimit, 5, 300);
  fullRecentLimit = clampInt(Math.max(fullRecentLimit, fastRecentLimit), 10, 600);

  return {
    matchMode,
    fastFileLimit,
    fullFileLimit,
    fastRecentLimit,
    fullRecentLimit,
    enableFullLane: true,
  };
}

