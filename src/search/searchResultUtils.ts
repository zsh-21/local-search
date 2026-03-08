import { AppItem } from "../appTypes";

export function normalizeResultKey(x: AppItem) {
  const t = typeof x?.type === "string" ? x.type : "";
  const p = typeof x?.path === "string" ? x.path.trim().toLowerCase() : "";
  return `${t}|${p}`;
}

export function dedupeResults(items: AppItem[]) {
  const seen = new Set<string>();
  const out: AppItem[] = [];
  for (const it of items) {
    const key = normalizeResultKey(it);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export function limitResults(items: AppItem[], limit: number) {
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return n > 0 ? items.slice(0, n) : [];
}

export function mergeResultsStable(prev: AppItem[], next: AppItem[]) {
  const nextByKey = new Map<string, AppItem>();
  for (const it of next) {
    const k = normalizeResultKey(it);
    if (!k) continue;
    nextByKey.set(k, it);
  }

  const seen = new Set<string>();
  const merged: AppItem[] = [];
  for (const it of prev) {
    const k = normalizeResultKey(it);
    if (!k || seen.has(k)) continue;
    const newer = nextByKey.get(k);
    if (newer) {
      merged.push({
        ...it,
        ...newer,
        icon: typeof newer.icon === "string" && newer.icon ? newer.icon : it.icon,
      });
    } else {
      merged.push(it);
    }
    seen.add(k);
  }

  for (const it of next) {
    const k = normalizeResultKey(it);
    if (!k || seen.has(k)) continue;
    merged.push(it);
    seen.add(k);
  }

  return merged;
}

export function mergeByServerOrder(prev: AppItem[], serverOrdered: AppItem[], limit: number) {
  const prevByKey = new Map<string, AppItem>();
  for (const it of prev) {
    const k = normalizeResultKey(it);
    if (!k) continue;
    prevByKey.set(k, it);
  }

  const seen = new Set<string>();
  const out: AppItem[] = [];
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;

  for (const it of serverOrdered) {
    const k = normalizeResultKey(it);
    if (!k || seen.has(k)) continue;
    const p = prevByKey.get(k);
    if (p) {
      out.push({
        ...it,
        icon: typeof it.icon === "string" && it.icon ? it.icon : p.icon,
      });
    } else {
      out.push(it);
    }
    seen.add(k);
    if (max > 0 && out.length >= max) return out;
  }

  for (const it of prev) {
    const k = normalizeResultKey(it);
    if (!k || seen.has(k)) continue;
    out.push(it);
    seen.add(k);
    if (max > 0 && out.length >= max) break;
  }

  return max > 0 ? out.slice(0, max) : [];
}

export function filterItemsBySearchType(items: AppItem[], typeId: string, customSearchTypes: string[]) {
  const id = typeof typeId === "string" && typeId.trim() ? typeId.trim() : "all";
  if (id === "all") return items;
  if (id === "app") return items.filter((x) => x.type === "app");
  if (id === "folder") return items.filter((x) => x.type === "folder");
  if (id === "settings") return items.filter((x) => x.type === "settings");

  if (id === "file") {
    const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
    const videoExts = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
    const customExts = new Set(
      (customSearchTypes || []).map((x) => (typeof x === "string" ? x.trim().toLowerCase() : "")).filter(Boolean),
    );
    return items.filter((x) => {
      if (x.type === "app") return true;
      if (x.type !== "file") return false;
      const p = (x.path || "").toLowerCase();
      const dot = p.lastIndexOf(".");
      const ext = dot >= 0 ? p.slice(dot) : "";
      if (!ext) return true;
      if (imageExts.has(ext)) return false;
      if (videoExts.has(ext)) return false;
      if (customExts.has(ext)) return false;
      return true;
    });
  }

  if (id === "image" || id === "video") {
    const exts =
      id === "image"
        ? new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"])
        : new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
    return items.filter((x) => {
      if (x.type !== "file") return false;
      const p = (x.path || "").toLowerCase();
      const dot = p.lastIndexOf(".");
      const ext = dot >= 0 ? p.slice(dot) : "";
      return exts.has(ext);
    });
  }

  if (id.startsWith("ext:")) {
    const ext = id.slice(4).toLowerCase();
    if (!ext) return items;
    return items.filter((x) => x.type === "file" && (x.path || "").toLowerCase().endsWith(ext));
  }

  return items;
}

