import type { SearchCandidate, SearchContext, SearchExecResult, SearchStrategy, SearchStrategyDeps } from "./types";

/** 判断值是否为可安全读取字段的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/** 带来源字段的索引结果类型。 */
type SearchIndexedCandidate = SearchCandidate & {
  source?: string;
  rawSource?: string;
};

/** 将索引查询返回值中的结果数组安全收敛出来。 */
function readSearchResults(value: unknown) {
  if (!isRecord(value)) return [] as Array<{ path: string; name: string; isDirectory: boolean; timeMs: number; size?: number }>;
  return Array.isArray(value.results) ? (value.results as Array<{ path: string; name: string; isDirectory: boolean; timeMs: number; size?: number }>) : [];
}

const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
const videoExts = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);

function isShortcutPath(p: string) {
  const lower = String(p || "").toLowerCase();
  return lower.endsWith(".lnk") || lower.endsWith(".url");
}

function shouldSkipByType(ctx: SearchContext) {
  return ctx.searchTypeId === "app" || ctx.searchTypeId === "settings";
}

export const fileIndexStrategy: SearchStrategy = {
  id: "fileIndex",
  async execute(ctx: SearchContext, deps: SearchStrategyDeps): Promise<SearchExecResult> {
    if (ctx.isSessionCancelled()) return { kind: "continue", items: [], meta: { isIndexing: ctx.isIndexingHint } };
    if (ctx.queryLength <= 1) return { kind: "continue", items: [], meta: { isIndexing: ctx.isIndexingHint } };
    if (shouldSkipByType(ctx)) return { kind: "continue", items: [], meta: { isIndexing: ctx.isIndexingHint } };

    const currentSettings = deps.loadSettings();
    const customExts = Array.isArray(currentSettings.customSearchTypes)
      ? currentSettings.customSearchTypes.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : "")).filter(Boolean)
      : [];

    const where = (() => {
      /** 组装索引过滤条件，保持原有筛选语义。 */
      const and: Array<Record<string, unknown>> = [];
      if (ctx.searchTypeId === "folder") and.push({ isDirectory: true });
      if (ctx.searchTypeId === "image") and.push({ ext: { in: Array.from(imageExts) } });
      if (ctx.searchTypeId === "video") and.push({ ext: { in: Array.from(videoExts) } });
      if (ctx.extFilter) and.push({ ext: { in: [ctx.extFilter] } });
      if (ctx.driveFilter) and.push({ drive: { eq: ctx.driveFilter } });
      if (ctx.searchTypeId === "file") {
        const excluded = new Set([...imageExts, ...videoExts, ...customExts, ".exe"]);
        and.push({ ext: { nin: Array.from(excluded) } });
      }
      return and.length > 0 ? { and } : null;
    })();

    /** 接收索引查询结果，先按未知值处理。 */
    let fileSearch: unknown = null;
    try {
      fileSearch = await deps.fileIndex.search(
        ctx.query,
        ctx.fileSearchLimit,
        where ? { where, sessionId: ctx.searchSessionId } : { sessionId: ctx.searchSessionId }
      );
    } catch {
      fileSearch = { results: [], isIndexing: false, totalCount: 0 };
    }
    if (ctx.isSessionCancelled()) return { kind: "continue", items: [], meta: { isIndexing: ctx.isIndexingHint } };

    const fileSearchRecord = isRecord(fileSearch) ? fileSearch : null;
    const rawCount = Number((fileSearchRecord?.rawCount ?? fileSearchRecord?.totalCount ?? 0) as number);
    if (ctx.query && ctx.query.trim() && ctx.lane === "fast") {
      console.log(`[search][${ctx.lane}] "${ctx.query}" limit=${ctx.fileSearchLimit} matches=${rawCount}`);
    }

    const fileResultsRaw = readSearchResults(fileSearchRecord);

    const out: SearchIndexedCandidate[] = [];
    for (const r of fileResultsRaw) {
      if (!r?.path) continue;
      if (isShortcutPath(r.path)) continue;
      if (deps.isIgnoredPathByCache(r.path)) continue;
      if (ctx.driveFilter && !r.path.toLowerCase().startsWith(`${ctx.driveFilter}:\\`)) continue;
      if (ctx.extFilter && !String(r.path).toLowerCase().endsWith(ctx.extFilter)) continue;
      if (ctx.searchTypeId === "file" && String(r.path).toLowerCase().endsWith(".exe")) continue;
      if (process.platform === "win32" && !/^[a-zA-Z]:/.test(r.path) && !r.path.startsWith("\\\\")) continue;

      out.push({
        ...r,
        type: r.isDirectory ? "folder" : "file",
        timeMs: typeof r.timeMs === "number" ? r.timeMs : 0,
        source: "fileIndex",
        rawSource: "fileIndex",
      } as SearchIndexedCandidate);
    }

    const isIndexing = (typeof fileSearchRecord?.isIndexing === "boolean" ? fileSearchRecord.isIndexing : undefined) ?? (await deps.fileIndex.getStatus()).isIndexing;
    if (ctx.isSessionCancelled()) return { kind: "continue", items: [], meta: { isIndexing } };
    return { kind: "continue", items: out, meta: { isIndexing } };
  },
};
