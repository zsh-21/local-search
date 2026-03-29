import path from "node:path";
import { toPinyinFull, toPinyinInitials } from "../pinyin";
import { classifyKind, normalizeDrive, shouldIndexFile } from "./utils";

/** 索引对象的最小能力。 */
interface FileIndexLike {
  add(doc: unknown): void;
  remove(id: string): void;
}

/** 路径索引上下文。 */
interface FileIndexPathContext {
  isCompacted: boolean;
  indexedCountHint: number;
  pathToId: Map<string, string>;
  maxEntries: number;
  index: FileIndexLike | null;
  isIgnoredPath(path: string): boolean;
  enqueueCacheDelta(delta: string): void;
  ensureIndex(): Promise<FileIndexLike>;
  bumpDriveCount(driveKey: string, delta: number): void;
  buildPathText(entryPath: string): string;
  getDriveKeyFromPath(entryPath: string): string;
}

/** 将未知值收窄为路径索引上下文。 */
const getPathContext = (ctx: unknown): FileIndexPathContext | null =>
  typeof ctx === "object" && ctx !== null ? (ctx as FileIndexPathContext) : null;

/** 生成路径文本。 */
export function fileIndexBuildPathText(entryPath: string) {
  const raw = typeof entryPath === "string" ? entryPath.trim() : "";
  if (!raw) return "";
  const normalized = raw.replace(/\//g, "\\").replace(/\\+/g, "\\");
  const parts = normalized.split("\\").filter(Boolean);
  return parts.join(" ");
}

/** 提取搜索分词。 */
export function fileIndexExtractSearchTokens(rawQuery: string) {
  const s = (rawQuery || "").normalize("NFKC").toLowerCase();
  if (!s) return [];
  const segs = s.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || [];
  const stop = new Set([
    "\u6bd4\u5982",
    "\u4f8b\u5982",
    "\u90a3\u4e48",
    "\u53ef\u4ee5",
    "\u901a\u8fc7",
    "\u6216\u8005",
    "\u53ef",
    "\u65b9\u5f0f",
    "\u641c\u7d22",
    "\u6587\u4ef6",
    "\u8fd9\u4e2a",
    "\u603b\u7ed3",
    "\u590d\u5236",
    "\u8fdb\u53bb",
    "\u8fd8\u662f",
    "\u4e0d\u884c",
    "\u600e\u4e48",
    "\u6211\u8981",
    "\u6211",
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of segs) {
    const token = String(seg || "").trim();
    if (!token) continue;
    if (stop.has(token)) continue;

    const isDigits = /^[0-9]+$/.test(token);
    const isAscii = /^[a-z0-9]+$/.test(token);
    const isHan = /[\p{Script=Han}]/u.test(token);
    if (isAscii) {
      if (!isDigits && token.length <= 1) continue;
    } else if (isHan) {
      if (token.length <= 1) continue;
    } else if (token.length <= 1) {
      continue;
    }

    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 10) break;
  }
  return out;
}

/** 写入单条路径。 */
export async function fileIndexIngestPath(
  ctx: unknown,
  entryPath: string,
  isDirectory: boolean,
  timeMs?: number,
) {
  const context = getPathContext(ctx);
  if (!context) return;
  if (!entryPath) return;
  const currentCount = context.isCompacted ? context.indexedCountHint : context.pathToId.size;
  if (currentCount >= context.maxEntries) return;
  if (process.platform === "win32") {
    if (!/^[a-zA-Z]:/.test(entryPath) && !entryPath.startsWith("\\")) return;
  } else if (!entryPath.startsWith("/")) {
    return;
  }
  if (context.isIgnoredPath(entryPath)) return;

  const key = entryPath.toLowerCase();
  const name = path.basename(entryPath);
  const ext = path.extname(name).toLowerCase();
  if (!shouldIndexFile(isDirectory, ext)) return;
  const normalizedTimeMs = Number.isFinite(timeMs) ? Math.max(0, Number(timeMs)) : 0;
  if (context.isCompacted && !context.index) {
    context.enqueueCacheDelta(
      JSON.stringify({ op: "i", p: entryPath, d: isDirectory ? 1 : 0, t: normalizedTimeMs }),
    );
    return;
  }
  const index = await context.ensureIndex();
  if (context.pathToId.has(key)) return;
  const drive = normalizeDrive(entryPath);
  const driveKey = drive || "other";
  const pinyinFull = toPinyinFull(name);
  const initials = toPinyinInitials(name);
  const pathText = context.buildPathText(entryPath);

  const doc = {
    id: key,
    path: entryPath,
    name,
    pinyin: pinyinFull,
    initials,
    pathText,
    isDirectory,
    timeMs: normalizedTimeMs,
    kind: classifyKind(isDirectory, ext),
    ext,
    drive,
  };
  index.add(doc);
  context.pathToId.set(key, key);
  context.bumpDriveCount(driveKey, 1);
  context.indexedCountHint = context.pathToId.size;

  context.enqueueCacheDelta(
    JSON.stringify({ op: "i", p: entryPath, d: isDirectory ? 1 : 0, t: normalizedTimeMs }),
  );
}

/** 删除单条路径。 */
export async function fileIndexRemovePath(ctx: unknown, entryPath: string) {
  const context = getPathContext(ctx);
  if (!context) return;
  if (!entryPath) return;
  if (context.isCompacted && !context.index) {
    context.enqueueCacheDelta(JSON.stringify({ op: "r", p: entryPath }));
    return;
  }
  const key = entryPath.toLowerCase();
  const id = context.pathToId.get(key);
  if (!id) return;
  const index = await context.ensureIndex();
  try {
    index.remove(id);
  } catch {}
  context.pathToId.delete(key);
  context.bumpDriveCount(context.getDriveKeyFromPath(entryPath), -1);
  context.indexedCountHint = context.pathToId.size;

  context.enqueueCacheDelta(JSON.stringify({ op: "r", p: entryPath }));
}

