export type SearchMatchTarget = "name" | "path";

export type SearchHighlightRange = {
  start: number;
  end: number;
};

export type SearchMatchIntent = {
  rawQuery: string;
  term: string;
  tokens: string[];
  matchTarget: SearchMatchTarget;
  isPathPrefixQuery: boolean;
};

const INVISIBLE_CHAR_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const PATH_PREFIX_RE = /^[pP]\s*(?::|\uFF1A)\s*/;

function normalizeQueryInput(raw: string) {
  return String(raw || "")
    .replace(INVISIBLE_CHAR_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeTokens(tokens: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const normalized = token.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function tokenizeByTarget(term: string, matchTarget: SearchMatchTarget) {
  // 路径匹配按“路径分隔符 + 空白”拆词；名称匹配按空白拆词，避免过度稀疏匹配。
  const parts =
    matchTarget === "path"
      ? term.split(/[\\/]+|\s+/)
      : term.split(/\s+/);
  return dedupeTokens(parts);
}

export function parseSearchMatchIntent(rawQuery: string): SearchMatchIntent {
  const normalized = normalizeQueryInput(rawQuery);
  if (!normalized) {
    return {
      rawQuery: "",
      term: "",
      tokens: [],
      matchTarget: "name",
      isPathPrefixQuery: false,
    };
  }

  const pathPrefixMatch = normalized.match(PATH_PREFIX_RE);
  const isPathPrefixQuery = Boolean(pathPrefixMatch);
  const term = isPathPrefixQuery
    ? normalized.slice(pathPrefixMatch?.[0]?.length || 0).trim()
    : normalized;
  const matchTarget: SearchMatchTarget =
    isPathPrefixQuery || /[\\/]/.test(term) ? "path" : "name";

  return {
    rawQuery: normalized,
    term,
    tokens: tokenizeByTarget(term, matchTarget),
    matchTarget,
    isPathPrefixQuery,
  };
}

function mergeRanges(ranges: SearchHighlightRange[]) {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = ranges.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchHighlightRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }
    merged.push({ ...cur });
  }
  return merged;
}

export function buildSearchHighlightRanges(source: string, intent: SearchMatchIntent): SearchHighlightRange[] {
  const text = String(source || "");
  if (!text || !intent?.tokens?.length) return [];
  const lowerText = text.toLowerCase();
  const ranges: SearchHighlightRange[] = [];

  for (const rawToken of intent.tokens) {
    const token = String(rawToken || "").toLowerCase().trim();
    if (!token) continue;

    let hasHit = false;
    let cursor = 0;
    while (cursor <= lowerText.length - token.length) {
      const idx = lowerText.indexOf(token, cursor);
      if (idx < 0) break;
      hasHit = true;
      ranges.push({ start: idx, end: idx + token.length });
      cursor = idx + Math.max(1, token.length);
    }

    // 严格匹配：任一词片无法定位到连续命中区间，则整体视为不匹配。
    if (!hasHit) return [];
  }

  return mergeRanges(ranges);
}

export function isStrictSearchMatch(source: string, intent: SearchMatchIntent) {
  return buildSearchHighlightRanges(source, intent).length > 0;
}

export function pickSearchMatchTargetText(
  input: { name?: string; path?: string },
  intent: SearchMatchIntent,
) {
  return intent.matchTarget === "path"
    ? String(input?.path || "")
    : String(input?.name || "");
}
