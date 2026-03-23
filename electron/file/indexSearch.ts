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

export async function fileIndexSearch(
  ctx: any,
  query: string,
  limit = 100,
  options?: { where?: any; sessionId?: string },
): Promise<{ results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number; rawCount: number }> {
  ctx.clearIdleCompactTimer();

  const sessionId = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
  if (sessionId && typeof ctx.clearCancelledSearchSession === "function") {
    ctx.clearCancelledSearchSession(sessionId);
  }
  const isCancelled = () => Boolean(sessionId && typeof ctx.isSearchSessionCancelled === "function" && ctx.isSearchSessionCancelled(sessionId));

  const emptyResult = () => ({ results: [], isIndexing: ctx.isIndexing, totalCount: 0, rawCount: 0 });
  if (isCancelled()) {
    ctx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  const index = await ctx.ensureIndex();
  const queryLower = query.trim().normalize("NFKC").toLowerCase();
  if (!queryLower) {
    ctx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  const matchesWhere = (doc: SearchHitDoc, where?: any) => {
    if (!where) return true;
    const clauses = Array.isArray(where?.and) ? where.and : [where];
    for (const clause of clauses) {
      if (!clause) continue;
      if (typeof clause.isDirectory === "boolean" && doc.isDirectory !== clause.isDirectory) return false;
      const ext = (doc.ext || "").toLowerCase();
      const drive = (doc.drive || "").toLowerCase();
      const inList = clause?.ext?.in;
      const notInList = clause?.ext?.nin;
      const eqDrive = clause?.drive?.eq;
      if (Array.isArray(inList) && !inList.map((x: any) => String(x).toLowerCase()).includes(ext)) {
        return false;
      }
      if (Array.isArray(notInList) && notInList.map((x: any) => String(x).toLowerCase()).includes(ext)) {
        return false;
      }
      if (typeof eqDrive === "string" && eqDrive.toLowerCase() !== drive) return false;
    }
    return true;
  };

  const normalizeResults = (raw: any): Array<{ id: string; doc: SearchHitDoc | null; rank: number }> => {
    const out: Array<{ id: string; doc: SearchHitDoc | null }> = [];
    const seen = new Set<string>();
    const push = (id: any, doc: any) => {
      const key = typeof id === "string" || typeof id === "number" ? String(id) : "";
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, doc: doc || null });
    };

    if (Array.isArray(raw)) {
      if (raw.length > 0 && raw[0] && typeof raw[0] === "object" && "id" in raw[0]) {
        for (const item of raw) push((item as any).id, (item as any).doc);
      } else {
        for (const group of raw) {
          const result = (group as any)?.result;
          if (!Array.isArray(result)) continue;
          for (const item of result) {
            if (item && typeof item === "object" && "id" in item) {
              push((item as any).id, (item as any).doc);
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

  const doSearch = (term: string, l: number) => {
    const raw = index.search(term, {
      limit: l,
      enrich: true,
      merge: true,
      field: ["name", "pinyin", "initials", "pathText"],
    }) as any;
    return normalizeResults(raw);
  };

  if (isCancelled()) {
    ctx.scheduleIdleCompactIfNeeded();
    return emptyResult();
  }

  const tokens = ctx.extractSearchTokens(queryLower);
  const normalizedTerm = tokens.length > 0 ? tokens.join(" ") : queryLower;
  let mergedHits = doSearch(normalizedTerm, limit * 3);

  if (isCancelled()) {
    ctx.scheduleIdleCompactIfNeeded();
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

        const doc = hit.doc || (index.get(hit.id) as any);
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
    const doc = (hit.doc || (index.get(hit.id) as any)) as SearchHitDoc | null;
    const p = doc?.path as string;
    if (!p || ctx.isIgnoredPath(p)) continue;
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
  const output = { results, isIndexing: ctx.isIndexing, totalCount, rawCount };
  ctx.scheduleIdleCompactIfNeeded();
  return isCancelled() ? emptyResult() : output;
}
