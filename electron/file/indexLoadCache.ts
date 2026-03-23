import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { toPinyinFull, toPinyinInitials } from "../pinyin";
import { shouldIndexFile, classifyKind, normalizeDrive } from "./utils";

export async function fileIndexLoadCache(ctx: any): Promise<boolean> {
  if (!createReadStream) return false;
  if (!(await existsSafe(ctx.cachePath))) return false;
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
    const stream = createReadStream(ctx.cachePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const batch: Array<{ path: string; isDirectory: boolean; timeMs: number }> = [];
    const BATCH_SIZE = 500;

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

    let count = 0;
    for await (const line of rl) {
      const raw = line.trim();
      if (!raw) continue;
      if (count >= ctx.maxEntries) break;

      let p = "";
      let isDirectory = false;
      let timeMs = 0;
      let op: "i" | "r" | "" = "";
      if (raw.startsWith("{")) {
        try {
          const obj = JSON.parse(raw);
          op = obj?.op === "i" || obj?.op === "r" ? obj.op : "";
          p = typeof obj?.p === "string" ? obj.p : "";
          isDirectory = obj?.d === 1 || obj?.d === true;
          timeMs = Number.isFinite(obj?.t) ? Math.max(0, Number(obj.t)) : 0;
        } catch {}
      } else {
        p = raw;
      }

      p = typeof p === "string" ? p.trim() : "";
      if (!p) continue;
      if (process.platform === "win32" && !/^[a-zA-Z]:/.test(p) && !p.startsWith("\\")) continue;

      const key = p.toLowerCase();
      if (op === "r") {
        const existed = ctx.pathToId.has(key);
        const id = ctx.pathToId.get(key);
        if (id && ctx.index) {
          try {
            ctx.index.remove(id);
          } catch {}
        }
        ctx.pathToId.delete(key);
        if (existed) ctx.bumpDriveCount(ctx.getDriveKeyFromPath(p), -1);
        continue;
      }
      if (ctx.pathToId.has(key)) continue;
      if (!isDirectory) {
        const ext = path.extname(p).toLowerCase();
        if (!shouldIndexFile(false, ext)) continue;
      }
      if (ctx.isIgnoredPath(p)) continue;

      batch.push({ path: p, isDirectory, timeMs });
      count++;
      ctx.bumpIndexingProgress(1);

      if (batch.length >= BATCH_SIZE) {
        await processBatch();
        await ctx.cooperativeYield(() => {});
      }
    }

    await processBatch();
    await ctx.cooperativeYield(() => {});
    ctx.indexedCountHint = ctx.pathToId.size;
    return count > 0;
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
