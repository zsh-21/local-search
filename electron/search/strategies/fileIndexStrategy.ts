import type { SearchCandidate, SearchContext, SearchExecResult, SearchStrategy, SearchStrategyDeps } from "./types";

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
      const and: any[] = [];
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

    let fileSearch: any = null;
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

    const rawCount = Number((fileSearch as any)?.rawCount ?? (fileSearch as any)?.totalCount ?? 0);
    if (ctx.query && ctx.query.trim() && ctx.lane === "fast") {
      console.log(`[search][${ctx.lane}] "${ctx.query}" limit=${ctx.fileSearchLimit} matches=${rawCount}`);
    }

    const fileResultsRaw: Array<{
      path: string;
      name: string;
      isDirectory: boolean;
      timeMs: number;
      size?: number;
    }> = Array.isArray((fileSearch as any)?.results) ? (fileSearch as any).results : [];

    const out: SearchCandidate[] = [];
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
      } as any);
    }

    const isIndexing = (fileSearch as any)?.isIndexing ?? (await deps.fileIndex.getStatus()).isIndexing;
    if (ctx.isSessionCancelled()) return { kind: "continue", items: [], meta: { isIndexing } };
    return { kind: "continue", items: out, meta: { isIndexing } };
  },
};
