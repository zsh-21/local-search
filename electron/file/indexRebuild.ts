import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { toPinyinFull, toPinyinInitials } from "../pinyin";
import { classifyKind, normalizeDrive, shouldIndexFile } from "./utils";
import { RecursiveScanner } from "./scanners/recursiveScanner";
import { UsnScanner } from "./scanners/usnScanner";
import { SystemDetector } from "./systemDetector";
import type { FileIndexEntry, RebuildRoot } from "../fileIndex";

export async function fileIndexRebuild(
  ctx: any,
  explicitRoots?: (string | RebuildRoot)[],
) {
  if (ctx.isIndexing) return;
  ctx.clearIdleCompactTimer();
  ctx.isCompacted = false;
  ctx.isIndexing = true;
  ctx.startIndexingProgress();
  ctx.abortRequested = false;
  ctx.rebuildStartedAt = Date.now();
  ctx.partialPublished = false;
  ctx.lastYieldAt = Date.now();

  const existingCount = ctx.pathToId.size;
  const publishIncrementally = existingCount <= 0;
  const nextIndex = ctx.createIndex();
  const nextPathToId = new Map<string, string>();
  const nextDriveCounts = new Map<string, number>();
  const tmpPath = `${ctx.cachePath}.tmp`;
  await fs.mkdir(path.dirname(ctx.cachePath), { recursive: true });
  const cacheWs = createWriteStream(tmpPath, { encoding: "utf-8" });

  let entryCount = 0;
  const batch: FileIndexEntry[] = [];
  const BATCH_SIZE = 500;
  let processedSinceYield = 0;

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const toWrite = batch.slice();
    batch.length = 0;

    for (const e of toWrite) {
      const ext = e.ext || path.extname(e.name).toLowerCase();
      const timeMs = Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0;
      const key = e.path.toLowerCase();
      if (nextPathToId.has(key)) continue;

      const doc = {
        id: key,
        path: e.path,
        name: e.name,
        pinyin: e.pinyin || toPinyinFull(e.name),
        initials: e.initials || toPinyinInitials(e.name),
        pathText: ctx.buildPathText(e.path),
        isDirectory: e.isDirectory,
        timeMs,
        kind: e.kind || classifyKind(e.isDirectory, ext),
        ext,
        drive: e.drive || normalizeDrive(e.path),
      };
      nextIndex.add(doc);
      nextPathToId.set(key, key);
      const driveKey = doc.drive || "other";
      nextDriveCounts.set(driveKey, (nextDriveCounts.get(driveKey) || 0) + 1);
    }

    const CHUNK_SIZE = 200;
    let chunk: string[] = [];
    for (let i = 0; i < toWrite.length; i++) {
      const e = toWrite[i]!;
      const timeMs = Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0;
      chunk.push(`${JSON.stringify({ p: e.path, d: e.isDirectory ? 1 : 0, t: timeMs })}\n`);
      if (chunk.length >= CHUNK_SIZE) {
        const lines = chunk.join("");
        chunk = [];
        if (!cacheWs.write(lines)) {
          await new Promise<void>((resolve) => cacheWs.once("drain", () => resolve()));
        }
      }
    }
    if (chunk.length > 0) {
      const lines = chunk.join("");
      if (!cacheWs.write(lines)) {
        await new Promise<void>((resolve) => cacheWs.once("drain", () => resolve()));
      }
    }
  };

  const maybePublishPartial = () => {
    if (!publishIncrementally) return;
    if (ctx.partialPublished) return;
    if (Date.now() - ctx.rebuildStartedAt < 2500) return;
    if (nextPathToId.size <= 0) return;
    ctx.index = nextIndex;
    ctx.pathToId = nextPathToId;
    ctx.driveCounts = nextDriveCounts;
    ctx.partialPublished = true;
  };

  if (publishIncrementally) {
    ctx.index = nextIndex;
    ctx.pathToId = nextPathToId;
    ctx.driveCounts = nextDriveCounts;
    ctx.partialPublished = true;
  }

  const addNext = (entry: FileIndexEntry) => {
    if (entryCount >= ctx.maxEntries) return;
    if (ctx.isIgnoredPath(entry.path)) return;
    if (nextPathToId.has(entry.path.toLowerCase())) return;
    if (!entry.isDirectory) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!shouldIndexFile(false, ext)) return;
    }

    batch.push({
      ...entry,
      timeMs: Number.isFinite(entry.timeMs) ? Math.max(0, Number(entry.timeMs)) : 0,
    });
    entryCount++;
    ctx.bumpIndexingProgress(1);
  };

  const shouldStop = () => ctx.abortRequested || entryCount >= ctx.maxEntries;
  let roots: string[] = [];
  let isSSD = true;

  if (explicitRoots && explicitRoots.length > 0) {
    roots = explicitRoots.map((r) => (typeof r === "string" ? r : r.path));
    isSSD = explicitRoots.every((r) => (typeof r === "string" ? true : r.isSSD));
  } else {
    try {
      const info = await SystemDetector.getInstance().detect();
      roots = info.drives
        .slice()
        .sort((a, b) => {
          const da = String(a?.mountPoint || "").toUpperCase();
          const db = String(b?.mountPoint || "").toUpperCase();
          const pa = da === "C:" ? 1 : 0;
          const pb = db === "C:" ? 1 : 0;
          if (pa !== pb) return pa - pb;
          return da.localeCompare(db);
        })
        .map((d) => d.mountPoint + "\\");
      isSSD = info.drives.every((d) => d.isSSD);
    } catch {
      roots = ["C:\\"];
      isSSD = false;
    }
  }

  try {
    const usnScanner = new UsnScanner(ctx.isIgnoredPath.bind(ctx));
    await usnScanner.scan(roots, addNext, shouldStop);
  } catch {
    const recursiveScanner = new RecursiveScanner(
      ctx.isIgnoredPath.bind(ctx),
      ctx.preferredFileExts,
    );
    const wrappedProgress = async (entry: FileIndexEntry) => {
      addNext(entry);
      processedSinceYield++;
      const yieldBatch = ctx.lowPriority ? 150 : 300;
      if (processedSinceYield % yieldBatch === 0) {
        if (batch.length >= BATCH_SIZE) await flushBatch();
        await ctx.cooperativeYield(maybePublishPartial);
      }
    };
    await recursiveScanner.scan(roots, wrappedProgress, shouldStop, isSSD);
  }

  try {
    await flushBatch();
    await new Promise<void>((resolve) => {
      cacheWs.on("finish", () => resolve());
      cacheWs.end();
    });
    await fs.rename(tmpPath, ctx.cachePath).catch(async () => {
      await fs.copyFile(tmpPath, ctx.cachePath);
      await fs.unlink(tmpPath);
    });

    ctx.index = nextIndex;
    ctx.pathToId = nextPathToId;
    ctx.driveCounts = nextDriveCounts;
    ctx.indexedCountHint = ctx.pathToId.size;
  } finally {
    try {
      cacheWs.end();
    } catch {}
    ctx.finishIndexingProgress();
    ctx.isIndexing = false;
    ctx.pauseUntil = 0;
    ctx.scheduleIdleCompactIfNeeded();
  }
}
