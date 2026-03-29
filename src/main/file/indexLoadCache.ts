import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { toPinyinFull, toPinyinInitials } from "../pinyin";
import { shouldIndexFile, classifyKind, normalizeDrive } from "./utils";
import { getCacheArtifactPaths } from "./indexCacheLayout";

/** 绱㈠紩瀵硅薄鐨勬渶灏忚兘鍔涖€?*/
interface FileIndexLike {
  add(doc: unknown): void;
  remove(id: string): void;
}

/** 鍔犺浇缂撳瓨鎵€闇€鐨勪笂涓嬫枃銆?*/
interface FileIndexLoadCacheContext {
  cachePath: string;
  isCompacted: boolean;
  isIndexing: boolean;
  rebuildStartedAt: number;
  partialPublished: boolean;
  lastYieldAt: number;
  indexedCountHint: number;
  pauseUntil: number;
  index: FileIndexLike | null;
  pathToId: Map<string, string>;
  driveCounts: Map<string, number>;
  maxEntries: number;
  clearIdleCompactTimer(): void;
  startIndexingProgress(): void;
  finishIndexingProgress(): void;
  createIndex(): FileIndexLike;
  isIgnoredPath(path: string): boolean;
  buildPathText(entryPath: string): string;
  bumpDriveCount(driveKey: string, delta: number): void;
  getDriveKeyFromPath(entryPath: string): string;
  bumpIndexingProgress(delta: number): void;
  cooperativeYield(onYield: () => void): Promise<void>;
  enqueueCacheDelta(delta: string): void;
  flushCacheAppendQueue(): Promise<void>;
  scheduleIdleCompactIfNeeded(): void;
}

/** 灏嗘湭鐭ュ€兼敹绐勪负缂撳瓨鍔犺浇涓婁笅鏂囥€?*/
const getLoadCacheContext = (ctx: unknown): FileIndexLoadCacheContext | null =>
  typeof ctx === "object" && ctx !== null ? (ctx as FileIndexLoadCacheContext) : null;

/** 鏅€氬璞″垽鏂€?*/
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 鍔犺浇纾佺洏缂撳瓨銆?*/
export async function fileIndexLoadCache(ctx: unknown): Promise<boolean> {
  const context = getLoadCacheContext(ctx);
  if (!context) return false;
  const artifacts = getCacheArtifactPaths(context.cachePath);
  const hasSnapshot = await existsSafe(artifacts.snapshotPath);
  const hasLegacy = await existsSafe(artifacts.legacyPath);
  if (!hasSnapshot && !hasLegacy) return false;

  context.clearIdleCompactTimer();
  context.isCompacted = false;
  context.isIndexing = true;
  context.startIndexingProgress();
  context.rebuildStartedAt = Date.now();
  context.partialPublished = false;
  context.lastYieldAt = Date.now();
  context.index = context.createIndex();
  context.pathToId.clear();
  context.driveCounts.clear();

  try {
    const batch: Array<{ path: string; isDirectory: boolean; timeMs: number }> = [];
    const BATCH_SIZE = 500;
    let touchedCount = 0;

    /** 澶勭悊鎵归噺缂撳瓨琛屻€?*/
    const processBatch = async () => {
      if (batch.length === 0) return;
      if (!context.index) return;

      for (const e of batch) {
        const p = e.path;
        if (!p) continue;
        const key = p.toLowerCase();
        if (context.pathToId.has(key)) continue;
        if (context.isIgnoredPath(p)) continue;
        if (!e.isDirectory) {
          const ext = path.extname(p).toLowerCase();
          if (!shouldIndexFile(false, ext)) continue;
        }

        const name = path.basename(p);
        const ext = path.extname(p).toLowerCase();
        const doc = {
          id: key,
          path: p,
          name,
          pinyin: toPinyinFull(name),
          initials: toPinyinInitials(name),
          pathText: context.buildPathText(p),
          isDirectory: e.isDirectory,
          timeMs: Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0,
          kind: classifyKind(e.isDirectory, ext),
          ext,
          drive: normalizeDrive(p),
        };
        context.index.add(doc);
        context.pathToId.set(key, key);
        context.bumpDriveCount(doc.drive || "other", 1);
      }
      batch.length = 0;
    };

    /** 瑙ｆ瀽骞跺簲鐢ㄥ崟琛岀紦瀛樸€?*/
    const applyLine = async (raw: string, allowOps: boolean) => {
      const line = raw.trim();
      if (!line) return;

      let p = "";
      let isDirectory = false;
      let timeMs = 0;
        let op: "i" | "r" | "" = "";
        if (line.startsWith("{")) {
        try {
          const obj: unknown = JSON.parse(line);
          const rawOp = isRecord(obj) ? obj.op : undefined;
          const rawPath = isRecord(obj) ? obj.p : undefined;
          const rawDir = isRecord(obj) ? obj.d : undefined;
          const rawTime = isRecord(obj) ? obj.t : undefined;
          op = rawOp === "i" || rawOp === "r" ? rawOp : "";
          p = typeof rawPath === "string" ? rawPath : "";
          isDirectory = rawDir === 1 || rawDir === true;
          timeMs = typeof rawTime === "number" && Number.isFinite(rawTime) ? Math.max(0, rawTime) : 0;
        } catch {
          return;
        }
      } else {
        p = line;
      }

      p = typeof p === "string" ? p.trim() : "";
      if (!p) return;
      if (process.platform === "win32" && !/^[a-zA-Z]:/.test(p) && !p.startsWith("\\")) return;

      const key = p.toLowerCase();
      if (allowOps && op === "r") {
        const existed = context.pathToId.has(key);
        const id = context.pathToId.get(key);
        if (id && context.index) {
          try {
            context.index.remove(id);
          } catch {}
        }
        context.pathToId.delete(key);
        if (existed) context.bumpDriveCount(normalizeDrive(p) || "other", -1);
        touchedCount++;
        return;
      }

      if (context.pathToId.has(key)) return;
      if (!isDirectory) {
        const ext = path.extname(p).toLowerCase();
        if (!shouldIndexFile(false, ext)) return;
      }
      if (context.isIgnoredPath(p)) return;

      batch.push({ path: p, isDirectory, timeMs });
      context.bumpIndexingProgress(1);
      touchedCount++;

      if (batch.length >= BATCH_SIZE) {
        await processBatch();
        await context.cooperativeYield(() => {});
      }
    };

    /** 璇诲彇骞舵秷璐圭紦瀛樻枃浠躲€?*/
    const consumeFile = async (targetPath: string, allowOps: boolean) => {
      if (!(await existsSafe(targetPath))) return;
      const stream = createReadStream(targetPath, { encoding: "utf-8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (context.pathToId.size >= context.maxEntries) break;
          await applyLine(line, allowOps);
        }
      } finally {
        rl.close();
      }
    };

    if (hasSnapshot) {
      await consumeFile(artifacts.snapshotPath, false);
      await consumeFile(artifacts.deltaPath, true);
    } else {
      await consumeFile(artifacts.legacyPath, true);
    }

    await processBatch();
    await context.cooperativeYield(() => {});
    context.indexedCountHint = context.pathToId.size;
    return touchedCount > 0;
  } catch {
    if (!context.index) context.index = context.createIndex();
    context.indexedCountHint = context.pathToId.size;
    return false;
  } finally {
    context.finishIndexingProgress();
    context.isIndexing = false;
    context.pauseUntil = 0;
    void context.flushCacheAppendQueue();
    context.scheduleIdleCompactIfNeeded();
  }
}

/** 妫€鏌ユ枃浠舵槸鍚﹀瓨鍦ㄣ€?*/
async function existsSafe(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}



