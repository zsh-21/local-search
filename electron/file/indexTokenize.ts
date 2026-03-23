const tokenizeCache = new Map<string, string[]>();
const TOKENIZE_CACHE_MAX = 4000;
const TOKENIZE_CACHE_KEY_MAX_LENGTH = 96;

function getTokenizeCacheEntry(key: string) {
  const cached = tokenizeCache.get(key);
  if (!cached) return null;
  tokenizeCache.delete(key);
  tokenizeCache.set(key, cached);
  return cached.slice();
}

function setTokenizeCacheEntry(key: string, tokens: string[]) {
  if (!key || tokens.length === 0) return;
  const snapshot = tokens.slice();
  if (tokenizeCache.has(key)) tokenizeCache.delete(key);
  tokenizeCache.set(key, snapshot);
  if (tokenizeCache.size <= TOKENIZE_CACHE_MAX) return;
  const overflow = tokenizeCache.size - TOKENIZE_CACHE_MAX;
  for (let i = 0; i < overflow; i++) {
    const oldestKey = tokenizeCache.keys().next().value;
    if (!oldestKey) break;
    tokenizeCache.delete(String(oldestKey));
  }
}

export function clearTokenizeCache() {
  tokenizeCache.clear();
}

export function createFlexsearchEncode() {
  return (raw: string) => {
    const s = (raw || "").normalize("NFKC").toLowerCase();
    if (!s) return [] as string[];
    const shouldUseCache = s.length <= TOKENIZE_CACHE_KEY_MAX_LENGTH;
    if (shouldUseCache) {
      const cached = getTokenizeCacheEntry(s);
      if (cached) return cached;
    }

    const out: string[] = [];
    const MAX_TOKENS = 24;
    let seen: Set<string> | null = null;
    const push = (t: string) => {
      if (!t) return;
      if (out.length >= MAX_TOKENS) return;
      if (seen) {
        if (seen.has(t)) return;
        seen.add(t);
      } else if (out.length >= 4) {
        seen = new Set(out);
        if (seen.has(t)) return;
        seen.add(t);
      }
      out.push(t);
    };

    const segs = s.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || [];
    for (const seg of segs) {
      if (!seg) continue;
      const isAscii = /^[a-z0-9]+$/.test(seg);
      const isHan = /[\p{Script=Han}]/u.test(seg);
      if (isAscii) {
        push(seg);
        const baseMaxPrefix = seg.length <= 10 ? 10 : 6;
        const maxPrefix = Math.min(baseMaxPrefix, seg.length);
        for (let i = 2; i <= maxPrefix; i++) push(seg.slice(0, i));
        if (seg.length >= 4 && seg.length <= 16 && out.length < MAX_TOKENS) {
          let added = 0;
          const maxNgrams = 4;
          for (let i = 0; i <= seg.length - 3; i++) {
            push(seg.slice(i, i + 3));
            added += 1;
            if (added >= maxNgrams || out.length >= MAX_TOKENS) break;
          }
        }
        continue;
      }

      push(seg);
      if (isHan) {
        if (seg.length >= 2) push(seg.slice(0, 2));
        if (seg.length >= 3) push(seg.slice(0, 3));
        if (seg.length <= 2) {
          for (let i = 0; i < seg.length; i++) push(seg[i]);
        }
        continue;
      }

      const maxPrefix = Math.min(seg.length, 6);
      for (let i = 2; i <= maxPrefix; i++) push(seg.slice(0, i));
    }

    if (shouldUseCache) setTokenizeCacheEntry(s, out);
    return out;
  };
}

