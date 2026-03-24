import fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { toPinyinFull, toPinyinInitials } from "../pinyin";
import { classifyKind, normalizeDrive, shouldIndexFile } from "./utils";
import { RecursiveScanner } from "./scanners/recursiveScanner";
import { UsnScanner } from "./scanners/usnScanner";
import { SystemDetector } from "./systemDetector";
import { getCacheArtifactPaths } from "./indexCacheLayout";
import type { FileIndexEntry, RebuildRoot } from "../fileIndex";

type PipelineDoc = {
  id: string;
  path: string;
  name: string;
  pinyin: string;
  initials: string;
  pathText: string;
  isDirectory: boolean;
  timeMs: number;
  kind: string;
  ext: string;
  drive: string;
};

type CommitItem = {
  key: string;
  doc: PipelineDoc;
  snapshotLine: string;
};

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
  const reservedKeys = new Set<string>();

  const artifacts = getCacheArtifactPaths(ctx.cachePath);
  await fs.mkdir(path.dirname(artifacts.snapshotPath), { recursive: true });
  const snapshotWs = createWriteStream(artifacts.snapshotTmpPath, { encoding: "utf-8" });

  let entryCount = 0;
  let processedSinceYield = 0;
  const stageAQueue: FileIndexEntry[] = [];
  const stageBQueue: CommitItem[] = [];
  const STAGE_A_BATCH = 500;
  const STAGE_B_BATCH = 400;

  const writeSnapshotLines = async (ws: WriteStream, lines: string[]) => {
    if (lines.length === 0) return;
    const CHUNK_SIZE = 200;
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      const chunk = lines.slice(i, i + CHUNK_SIZE).join("");
      if (!chunk) continue;
      if (!ws.write(chunk)) await new Promise<void>((resolve) => ws.once("drain", () => resolve()));
    }
  };

  const stageAEnrich = () => {
    while (stageAQueue.length > 0) {
      const e = stageAQueue.shift();
      if (!e) continue;
      const key = e.path.toLowerCase();
      const ext = e.ext || path.extname(e.name).toLowerCase();
      const timeMs = Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0;
      const doc: PipelineDoc = {
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
      const snapshotLine = `${JSON.stringify({ p: e.path, d: e.isDirectory ? 1 : 0, t: timeMs })}\n`;
      stageBQueue.push({ key, doc, snapshotLine });
    }
  };

  const stageBCommit = async () => {
    if (stageBQueue.length === 0) return;
    const lines: string[] = [];
    for (const it of stageBQueue.splice(0, stageBQueue.length)) {
      if (nextPathToId.has(it.key)) continue;
      nextIndex.add(it.doc);
      nextPathToId.set(it.key, it.key);
      const driveKey = it.doc.drive || "other";
      nextDriveCounts.set(driveKey, (nextDriveCounts.get(driveKey) || 0) + 1);
      lines.push(it.snapshotLine);
    }
    await writeSnapshotLines(snapshotWs, lines);
  };

  const flushPipeline = async () => {
    stageAEnrich();
    await stageBCommit();
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

  const enqueueEnumerated = (entry: FileIndexEntry) => {
    if (entryCount >= ctx.maxEntries) return;
    if (ctx.isIgnoredPath(entry.path)) return;

    const key = entry.path.toLowerCase();
    if (reservedKeys.has(key) || nextPathToId.has(key)) return;

    if (!entry.isDirectory) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!shouldIndexFile(false, ext)) return;
    }

    reservedKeys.add(key);
    stageAQueue.push({
      ...entry,
      timeMs: Number.isFinite(entry.timeMs) ? Math.max(0, Number(entry.timeMs)) : 0,
    });
    entryCount++;
    ctx.bumpIndexingProgress(1);
  };

  const flushByWatermarkIfNeeded = async () => {
    if (stageAQueue.length >= STAGE_A_BATCH || stageBQueue.length >= STAGE_B_BATCH) {
      await flushPipeline();
    }
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

  const onEnumerated = async (entry: FileIndexEntry) => {
    enqueueEnumerated(entry);
    processedSinceYield++;

    await flushByWatermarkIfNeeded();
    const yieldBatch = ctx.lowPriority ? 150 : 300;
    if (processedSinceYield % yieldBatch === 0) {
      await flushPipeline();
      await ctx.cooperativeYield(maybePublishPartial);
    }
  };

  try {
    const usnScanner = new UsnScanner(ctx.isIgnoredPath.bind(ctx));
    await usnScanner.scan(roots, onEnumerated, shouldStop);
  } catch {
    const recursiveScanner = new RecursiveScanner(
      ctx.isIgnoredPath.bind(ctx),
      ctx.preferredFileExts,
    );
    await recursiveScanner.scan(roots, onEnumerated, shouldStop, isSSD);
  }

  try {
    await flushPipeline();
    await new Promise<void>((resolve) => {
      snapshotWs.on("finish", () => resolve());
      snapshotWs.end();
    });

    await fs.rename(artifacts.snapshotTmpPath, artifacts.snapshotPath).catch(async () => {
      await fs.copyFile(artifacts.snapshotTmpPath, artifacts.snapshotPath);
      await fs.unlink(artifacts.snapshotTmpPath).catch(() => {});
    });

    if (ctx.cacheAppendTimer) {
      clearTimeout(ctx.cacheAppendTimer);
      ctx.cacheAppendTimer = null;
    }
    ctx.cacheAppendQueue.length = 0;
    try {
      ctx.cacheAppendWs?.end();
    } catch {}
    ctx.cacheAppendWs = null;

    await fs.rm(artifacts.deltaPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.legacyPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.legacyTmpPath, { force: true }).catch(() => {});

    ctx.index = nextIndex;
    ctx.pathToId = nextPathToId;
    ctx.driveCounts = nextDriveCounts;
    ctx.indexedCountHint = ctx.pathToId.size;
  } finally {
    try {
      snapshotWs.end();
    } catch {}
    ctx.finishIndexingProgress();
    ctx.isIndexing = false;
    ctx.pauseUntil = 0;
    ctx.scheduleIdleCompactIfNeeded();
  }
}
