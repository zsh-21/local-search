import type { FileIndexSearchResult } from "../fileIndex";

interface SearchHitDoc {
  id: string;
  path: string;
  name: string;
  isDirectory: boolean;
  timeMs: number;
  ext: string;
  drive: string;
}

/** 搜索上下文的最小接口。 */
interface FileIndexSearchContext {
  clearIdleCompactTimer(): void;
  clearCancelledSearchSession(sessionId: string): void;
  isSearchSessionCancelled(sessionId: string): boolean;
  scheduleIdleCompactIfNeeded(): void;
  isIndexing: boolean;
  ensureIndex(): Promise<{
    search(term: string, options: { limit: number; enrich: true; merge: true; field: string[] }): unknown;
    get(id: string): unknown;
  }>;
  extractSearchTokens(query: string): string[];
  isIgnoredPath(path: string): boolean;
}

/** 搜索选项。 */
type FileIndexSearchOptions = { where?: unknown; sessionId?: string };

/** 普通对象判断。 */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 搜索结果的临时结构。 */
type SearchHitItem = { id: string; doc: SearchHitDoc | null; rank: number };

/** 执行索引搜索。 */
export async function fileIndexSearch(
  ctx: unknown,
  query: string,
  limit = 100,
  options?: FileIndexSearchOptions,
): Promise<{ results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number; rawCount: number }> {
  const searchCtx = ctx as FileIndexSearchContext;
  searchCtx.clearIdleCompactTimer();

  const sessionId = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
  if (sessionId && typeof searchCtx.clearCancelledSearchSession === "function") {
    searchCtx.clearCancelledSearchSession(sessionId);
  }
  const isCancelled = () => Boolean(sessionId && typeof searchCtx.isSearchSessionCancelled === "function" && searchCtx.isSearchSessionCancelled(sessionId));

  const emptyResult = () => ({ results: [], isIndexing: searchCtx.isIndexing, totalCount: 0, rawCount: 0 });
  if (isCancelled()) {
    searchCtx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  const index = await searchCtx.ensureIndex();
  const queryLower = query.trim().normalize("NFKC").toLowerCase();
  if (!queryLower) {
    searchCtx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  /** 判断命中是否满足过滤条件。 */
  const matchesWhere = (doc: SearchHitDoc, where?: unknown) => {
    if (!isRecord(where)) return true;
    const clauses = Array.isArray(where.and) ? where.and : [where];
    for (const clause of clauses) {
      if (!isRecord(clause)) continue;
      if (typeof clause.isDirectory === "boolean" && doc.isDirectory !== clause.isDirectory) return false;
      const ext = (doc.ext || "").toLowerCase();
      const drive = (doc.drive || "").toLowerCase();
      const inList = isRecord(clause.ext) ? clause.ext.in : undefined;
      const notInList = isRecord(clause.ext) ? clause.ext.nin : undefined;
      const eqDrive = isRecord(clause.drive) ? clause.drive.eq : undefined;
      if (Array.isArray(inList) && !inList.map((x: unknown) => String(x).toLowerCase()).includes(ext)) {
        return false;
      }
      if (Array.isArray(notInList) && notInList.map((x: unknown) => String(x).toLowerCase()).includes(ext)) {
        return false;
      }
      if (typeof eqDrive === "string" && eqDrive.toLowerCase() !== drive) return false;
    }
    return true;
  };

  /** 规范化搜索结果。 */
  const normalizeResults = (raw: unknown): SearchHitItem[] => {
    const out: Array<{ id: string; doc: SearchHitDoc | null }> = [];
    const seen = new Set<string>();
    const push = (id: unknown, doc: unknown) => {
      const key = typeof id === "string" || typeof id === "number" ? String(id) : "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      const normalizedDoc = doc && typeof doc === "object" ? (doc as unknown as SearchHitDoc) : null;
      out.push({ id: key, doc: normalizedDoc });
    };

    if (Array.isArray(raw)) {
      if (raw.length > 0 && isRecord(raw[0]) && "id" in raw[0]) {
        for (const item of raw) push(isRecord(item) ? item.id : item, isRecord(item) ? (item.doc as unknown as SearchHitDoc) : null);
      } else {
        for (const group of raw) {
          const result = isRecord(group) ? group.result : undefined;
          if (!Array.isArray(result)) continue;
          for (const item of result) {
            if (isRecord(item) && "id" in item) {
              push(item.id, item.doc);
            } else {
              push(item, null);
            }
          }
        }
      }
    }

    const size = out.length;
    return out.map((item, idx) => ({
      ...item,
      rank: Math.max(1, size - idx),
    }));
  };

  /** 发起一次具体搜索。 */
  const doSearch = (term: string, l: number) => {
    const raw = index.search(term, {
      limit: l,
      enrich: true,
      merge: true,
      field: ["name", "pinyin", "initials", "pathText"],
    }) as unknown;
    return normalizeResults(raw);
  };

  if (isCancelled()) {
    searchCtx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  const tokens = searchCtx.extractSearchTokens(queryLower);
  const normalizedTerm = tokens.length > 0 ? tokens.join(" ") : queryLower;
  let mergedHits = doSearch(normalizedTerm, limit * 3);

  if (isCancelled()) {
    searchCtx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  if (mergedHits.length === 0 && tokens.length >= 2) {
    const merged = new Map<string, { doc: SearchHitDoc | null; scoreSum: number; hitCount: number }>();
    const tokenList = tokens.slice(0, 6);
    for (const t of tokenList) {
      if (isCancelled()) break;

      const hits = doSearch(t, Math.max(limit, 120));
      for (const hit of hits) {
        if (isCancelled()) break;

        const rawDoc = index.get(hit.id);
        const doc = hit.doc || (rawDoc as unknown as SearchHitDoc | null);
        if (!doc?.path) continue;
        const key = String(hit.id);
        const prev = merged.get(key);
        const score = hit.rank || 0;
        if (prev) {
          prev.scoreSum += score;
          prev.hitCount += 1;
        } else {
          merged.set(key, { doc, scoreSum: score, hitCount: 1 });
        }
      }
      if (isCancelled()) break;
    }

    mergedHits = Array.from(merged.values())
      .map((x) => ({
        id: x.doc?.path ? x.doc.path.toLowerCase() : "",
        doc: x.doc,
        rank: x.scoreSum + x.hitCount * 0.15,
      }))
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .slice(0, limit * 3);
  }

  const rawCount = Array.isArray(mergedHits) ? mergedHits.length : 0;
  const results: FileIndexSearchResult[] = [];
  for (let i = 0; i < (mergedHits || []).length; i++) {
    if (i > 0 && i % 32 === 0 && isCancelled()) break;

    const hit = mergedHits[i];
    if (!hit) continue;
    const rawDoc = index.get(hit.id);
    const doc = (hit.doc || (rawDoc as unknown as SearchHitDoc | null)) as SearchHitDoc | null;
    const p = doc?.path as string;
    if (!p || searchCtx.isIgnoredPath(p)) continue;
    if (!doc || !matchesWhere(doc, options?.where)) continue;

    const nameLower = String(doc.name || "").toLowerCase();
    let score = Number(hit.rank || 0) * 10;
    if (nameLower === queryLower) score += 5000;
    else if (nameLower.startsWith(queryLower)) score += 2000;
    else if (nameLower.includes(queryLower)) score += 600;

    const pathLower = String(doc.path || "").toLowerCase();
    if (pathLower.includes(queryLower)) score += 200;

    results.push({
      path: p,
      name: (doc?.name as string) || "",
      isDirectory: Boolean(doc?.isDirectory),
      timeMs: Number.isFinite(doc?.timeMs) ? Math.max(0, Number(doc.timeMs)) : 0,
      score,
    });
    if (results.length >= limit) break;
  }

  const totalCount = results.length;
  const output = { results, isIndexing: searchCtx.isIndexing, totalCount, rawCount };
  searchCtx.scheduleIdleCompactIfNeeded();
  return isCancelled() ? emptyResult() : output;
}





