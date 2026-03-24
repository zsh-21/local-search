import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { toPinyinFull, toPinyinInitials } from "../pinyin";
import { shouldIndexFile, classifyKind, normalizeDrive } from "./utils";
import { getCacheArtifactPaths } from "./indexCacheLayout";

export async function fileIndexLoadCache(ctx: any): Promise<boolean> {
  const artifacts = getCacheArtifactPaths(ctx.cachePath);
  const hasSnapshot = await existsSafe(artifacts.snapshotPath);
  const hasLegacy = await existsSafe(artifacts.legacyPath);
  if (!hasSnapshot && !hasLegacy) return false;

  ctx.clearIdleCompactTimer();
  ctx.isCompacted = false;
  ctx.isIndexing = true;
  ctx.startIndexingProgress();
  ctx.rebuildStartedAt = Date.now();
  ctx.partialPublished = false;
  ctx.lastYieldAt = Date.now();
  ctx.index = ctx.createIndex();
  ctx.pathToId.clear();
  ctx.driveCounts.clear();

  try {
    const batch: Array<{ path: string; isDirectory: boolean; timeMs: number }> = [];
    const BATCH_SIZE = 500;
    let touchedCount = 0;

    const processBatch = async () => {
      if (batch.length === 0) return;
      if (!ctx.index) return;

      for (const e of batch) {
        const p = e.path;
        if (!p) continue;
        const key = p.toLowerCase();
        if (ctx.pathToId.has(key)) continue;
        if (ctx.isIgnoredPath(p)) continue;
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
          pathText: ctx.buildPathText(p),
          isDirectory: e.isDirectory,
          timeMs: Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0,
          kind: classifyKind(e.isDirectory, ext),
          ext,
          drive: normalizeDrive(p),
        };
        ctx.index.add(doc);
        ctx.pathToId.set(key, key);
        ctx.bumpDriveCount(doc.drive || "other", 1);
      }
      batch.length = 0;
    };

    const applyLine = async (raw: string, allowOps: boolean) => {
      const line = raw.trim();
      if (!line) return;

      let p = "";
      let isDirectory = false;
      let timeMs = 0;
      let op: "i" | "r" | "" = "";
      if (line.startsWith("{")) {
        try {
          const obj = JSON.parse(line);
          op = obj?.op === "i" || obj?.op === "r" ? obj.op : "";
          p = typeof obj?.p === "string" ? obj.p : "";
          isDirectory = obj?.d === 1 || obj?.d === true;
          timeMs = Number.isFinite(obj?.t) ? Math.max(0, Number(obj.t)) : 0;
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
        const existed = ctx.pathToId.has(key);
        const id = ctx.pathToId.get(key);
        if (id && ctx.index) {
          try {
            ctx.index.remove(id);
          } catch {}
        }
        ctx.pathToId.delete(key);
        if (existed) ctx.bumpDriveCount(ctx.getDriveKeyFromPath(p), -1);
        touchedCount++;
        return;
      }

      if (ctx.pathToId.has(key)) return;
      if (!isDirectory) {
        const ext = path.extname(p).toLowerCase();
        if (!shouldIndexFile(false, ext)) return;
      }
      if (ctx.isIgnoredPath(p)) return;

      batch.push({ path: p, isDirectory, timeMs });
      ctx.bumpIndexingProgress(1);
      touchedCount++;

      if (batch.length >= BATCH_SIZE) {
        await processBatch();
        await ctx.cooperativeYield(() => {});
      }
    };

    const consumeFile = async (targetPath: string, allowOps: boolean) => {
      if (!(await existsSafe(targetPath))) return;
      const stream = createReadStream(targetPath, { encoding: "utf-8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (ctx.pathToId.size >= ctx.maxEntries) break;
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
    await ctx.cooperativeYield(() => {});
    ctx.indexedCountHint = ctx.pathToId.size;
    return touchedCount > 0;
  } catch {
    if (!ctx.index) ctx.index = ctx.createIndex();
    ctx.indexedCountHint = ctx.pathToId.size;
    return false;
  } finally {
    ctx.finishIndexingProgress();
    ctx.isIndexing = false;
    ctx.pauseUntil = 0;
    void ctx.flushCacheAppendQueue();
    ctx.scheduleIdleCompactIfNeeded();
  }
}

async function existsSafe(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
