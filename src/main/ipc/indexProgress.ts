/** 索引进度运行态缓存结构 */
type IndexProgressRuntime = {
  active: boolean;
  startedAt: number;
  startedCount: number;
  lastCount: number;
  lastProgress: number;
};

/** 索引进度运行态缓存 */
const indexProgressRuntime: IndexProgressRuntime = {
  active: false,
  startedAt: 0,
  startedCount: 0,
  lastCount: 0,
  lastProgress: 0,
};

/** 最近一次可回退的进度快照结构 */
type LastKnownIndexProgress = {
  hasValue: boolean;
  isIndexing: boolean;
  progress: number;
  updatedAt: number;
};

/** 进度回退快照的过期阈值（毫秒） */
const INDEX_PROGRESS_FALLBACK_STALE_MS = 20_000;

/** 最近一次可回退的进度快照 */
const lastKnownIndexProgress: LastKnownIndexProgress = {
  hasValue: false,
  isIndexing: false,
  progress: 1,
  updatedAt: 0,
};

/** 记录最近一次有效进度，用于异常时回退 */
export function rememberLastKnownIndexProgress(next: { isIndexing: boolean; progress: number }) {
  /** 原始进度值 */
  const progressRaw = Number(next?.progress);
  lastKnownIndexProgress.hasValue = true;
  lastKnownIndexProgress.isIndexing = Boolean(next?.isIndexing);
  lastKnownIndexProgress.progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(1, progressRaw)) : 1;
  lastKnownIndexProgress.updatedAt = Date.now();
}

/** 获取最近一次可用进度（含过期保护） */
export function getLastKnownIndexProgressFallback() {
  if (!lastKnownIndexProgress.hasValue) return null;
  /** 当前时间戳 */
  const now = Date.now();
  if (
    lastKnownIndexProgress.isIndexing &&
    now - lastKnownIndexProgress.updatedAt > INDEX_PROGRESS_FALLBACK_STALE_MS
  ) {
    return { isIndexing: false, progress: 1 };
  }
  return {
    isIndexing: lastKnownIndexProgress.isIndexing,
    progress: lastKnownIndexProgress.progress,
  };
}

/** 根据索引状态估算可展示的进度值 */
export function estimateIndexProgress(status: { isIndexing?: boolean; indexedCount?: number; progress?: number }) {
  /** 是否处于索引中 */
  const isIndexing = Boolean(status?.isIndexing);
  /** 直接上报进度值 */
  const directProgressRaw = Number(status?.progress);
  /** 是否有直接上报进度 */
  const hasDirectProgress = Number.isFinite(directProgressRaw);
  if (hasDirectProgress) {
    /** 归一化进度值 */
    const normalized = Math.max(0, Math.min(1, directProgressRaw));
    if (!isIndexing) return { isIndexing: false, progress: 1 };
    return { isIndexing: true, progress: Math.min(0.99, Math.max(0.01, normalized)) };
  }

  /** 当前已索引数量 */
  const indexedCountRaw = Number(status?.indexedCount);
  /** 已索引数量（兜底为 0） */
  const indexedCount = Number.isFinite(indexedCountRaw) ? Math.max(0, indexedCountRaw) : 0;

  if (!isIndexing) {
    indexProgressRuntime.active = false;
    indexProgressRuntime.startedAt = 0;
    indexProgressRuntime.startedCount = 0;
    indexProgressRuntime.lastCount = indexedCount;
    indexProgressRuntime.lastProgress = 1;
    return { isIndexing: false, progress: 1 };
  }

  /** 当前时间戳 */
  const now = Date.now();
  /** 是否判定为新索引会话 */
  const isNewSession =
    !indexProgressRuntime.active ||
    (indexedCount > 0 && indexProgressRuntime.lastCount - indexedCount > 500);
  if (isNewSession) {
    indexProgressRuntime.active = true;
    indexProgressRuntime.startedAt = now;
    indexProgressRuntime.startedCount = indexedCount;
    indexProgressRuntime.lastCount = indexedCount;
    indexProgressRuntime.lastProgress = 0.01;
  }

  /** 会话内计数增长 */
  const growth = Math.max(0, indexedCount - indexProgressRuntime.startedCount);
  /** 会话已耗时 */
  const elapsedMs = Math.max(0, now - indexProgressRuntime.startedAt);
  /** 计数驱动进度 */
  const countProgress = Math.min(0.92, Math.log10(growth + 1) / 6.0);
  /** 时间驱动进度兜底 */
  const timeProgress = Math.min(0.9, (elapsedMs / 1000 / 180) * 0.9);
  /** 最终进度值 */
  const nextProgress = Math.min(
    0.99,
    Math.max(indexProgressRuntime.lastProgress, countProgress, timeProgress, 0.01),
  );

  indexProgressRuntime.lastCount = indexedCount;
  indexProgressRuntime.lastProgress = nextProgress;
  return { isIndexing: true, progress: nextProgress };
}
