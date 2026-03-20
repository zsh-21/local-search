import type { SearchCandidate, SearchContext, SearchExecResult, SearchStrategy, SearchStrategyDeps } from "./types";

const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
const videoExts = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);

function isShortcutPath(p: string) {
  const lower = String(p || "").toLowerCase();
  return lower.endsWith(".lnk") || lower.endsWith(".url");
}

export const fileIndexStrategy: SearchStrategy = {
  id: "fileIndex",
  async execute(ctx: SearchContext, deps: SearchStrategyDeps): Promise<SearchExecResult> {
    // 索引期降载：降低 fileIndex 查询上限，优先保证输入响应
    const baseLimit = ctx.searchTypeId === "all" || ctx.searchTypeId === "file" ? 500 : 5000;
    const fileSearchLimit = ctx.isIndexingHint
      ? Math.min(baseLimit, ctx.searchTypeId === "all" || ctx.searchTypeId === "file" ? 120 : 600)
      : baseLimit;

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
      fileSearch = await deps.fileIndex.search(ctx.query, fileSearchLimit, where ? { where } : undefined);
    } catch {
      fileSearch = { results: [], isIndexing: false, totalCount: 0 };
    }
    const rawCount = Number((fileSearch as any)?.rawCount ?? (fileSearch as any)?.totalCount ?? 0);
    if (ctx.query && ctx.query.trim()) {
      console.log(`[search] "${ctx.query}" matches=${rawCount}`);
    }

    const fileResultsRaw: Array<{
      path: string;
      name: string;
      isDirectory: boolean;
      timeMs: number;
      size?: number;
    }> = Array.isArray((fileSearch as any)?.results) ? (fileSearch as any).results : [];

    const filteredFiles: Array<any> = [];
    for (const r of fileResultsRaw) {
      if (!r?.path) continue;
      if (isShortcutPath(r.path)) continue;
      if (deps.isIgnoredPathByCache(r.path)) continue;
      if (ctx.driveFilter && !r.path.toLowerCase().startsWith(`${ctx.driveFilter}:\\`)) continue;
      if (ctx.extFilter && !String(r.path).toLowerCase().endsWith(ctx.extFilter)) continue;
      if (ctx.searchTypeId === "file" && String(r.path).toLowerCase().endsWith(".exe")) continue;
      if (process.platform === "win32" && !/^[a-zA-Z]:/.test(r.path) && !r.path.startsWith("\\\\")) continue;
      filteredFiles.push(r);
    }

    const scoredFiles: SearchCandidate[] = [];
    for (const r of filteredFiles) {
      const type = r.isDirectory ? "folder" : "file";
      // 路径查询时优先用 path 参与匹配，提升目录片段检索的命中质量
      const matchTarget = ctx.isPathQuery ? r.path : r.name;
      const { weightedScore, staticScore, matchIndex, nameLen } = ctx.nameScorer.computeWeightedNameMatch(matchTarget);
      const timeMs = typeof r.timeMs === "number" ? r.timeMs : 0;
      const score = ctx.scoreComputer.computeCombinedScore({
        staticScore,
        type,
        rawPath: r.path,
        timeMs,
      });
      scoredFiles.push({ ...r, type, score, staticScore, weightedScore, matchIndex, nameLen });
    }

    const isIndexing = (fileSearch as any)?.isIndexing ?? (await deps.fileIndex.getStatus()).isIndexing;
    return { kind: "continue", items: scoredFiles, meta: { isIndexing } };
  },
};
