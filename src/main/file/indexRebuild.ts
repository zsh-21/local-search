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

/** 索引对象的最小能力。 */
interface FileIndexLike {
  add(doc: unknown): void;
  remove(id: string): void;
}

/** 重建流程所需的上下文。 */
interface FileIndexRebuildContext {
  isIndexing: boolean;
  clearIdleCompactTimer(): void;
  isCompacted: boolean;
  startIndexingProgress(): void;
  abortRequested: boolean;
  rebuildStartedAt: number;
  partialPublished: boolean;
  lastYieldAt: number;
  pathToId: Map<string, string>;
  createIndex(): FileIndexLike;
  cachePath: string;
  maxEntries: number;
  isIgnoredPath(path: string): boolean;
  buildPathText(entryPath: string): string;
  bumpIndexingProgress(delta: number): void;
  cooperativeYield(onYield: () => void): Promise<void>;
  lowPriority: boolean;
  preferredFileExts: Set<string>;
  cacheAppendTimer: ReturnType<typeof setTimeout> | null;
  cacheAppendQueue: string[];
  cacheAppendWs: WriteStream | null;
  index: FileIndexLike | null;
  driveCounts: Map<string, number>;
  indexedCountHint: number;
  finishIndexingProgress(): void;
  pauseUntil: number;
  scheduleIdleCompactIfNeeded(): void;
}

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
  ctx: unknown,
  explicitRoots?: (string | RebuildRoot)[],
) {
  if (typeof ctx !== "object" || ctx === null) return;
  const context = ctx as FileIndexRebuildContext;
  if (context.isIndexing) return;
  context.clearIdleCompactTimer();
  context.isCompacted = false;
  context.isIndexing = true;
  context.startIndexingProgress();
  context.abortRequested = false;
  context.rebuildStartedAt = Date.now();
  context.partialPublished = false;
  context.lastYieldAt = Date.now();

  const existingCount = context.pathToId.size;
  const publishIncrementally = existingCount <= 0;
  const nextIndex = context.createIndex();
  const nextPathToId = new Map<string, string>();
  const nextDriveCounts = new Map<string, number>();
  const reservedKeys = new Set<string>();

  const artifacts = getCacheArtifactPaths(context.cachePath);
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
        pathText: context.buildPathText(e.path),
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
    if (context.partialPublished) return;
    if (Date.now() - context.rebuildStartedAt < 2500) return;
    if (nextPathToId.size <= 0) return;
    context.index = nextIndex;
    context.pathToId = nextPathToId;
    context.driveCounts = nextDriveCounts;
    context.partialPublished = true;
  };

  if (publishIncrementally) {
    context.index = nextIndex;
    context.pathToId = nextPathToId;
    context.driveCounts = nextDriveCounts;
    context.partialPublished = true;
  }

  const enqueueEnumerated = (entry: FileIndexEntry) => {
    if (entryCount >= context.maxEntries) return;
    if (context.isIgnoredPath(entry.path)) return;

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
    context.bumpIndexingProgress(1);
  };

  const flushByWatermarkIfNeeded = async () => {
    if (stageAQueue.length >= STAGE_A_BATCH || stageBQueue.length >= STAGE_B_BATCH) {
      await flushPipeline();
    }
  };

  const shouldStop = () => context.abortRequested || entryCount >= context.maxEntries;
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
    const yieldBatch = context.lowPriority ? 150 : 300;
    if (processedSinceYield % yieldBatch === 0) {
      await flushPipeline();
      await context.cooperativeYield(maybePublishPartial);
    }
  };

  try {
    const usnScanner = new UsnScanner(context.isIgnoredPath.bind(context));
    await usnScanner.scan(roots, onEnumerated, shouldStop);
  } catch {
    const recursiveScanner = new RecursiveScanner(
      context.isIgnoredPath.bind(context),
      context.preferredFileExts,
    );
    await recursiveScanner.scan(roots, onEnumerated, shouldStop, isSSD);
  }
  const rebuildAborted = Boolean(context.abortRequested);

  try {
    await flushPipeline();
    await new Promise<void>((resolve) => {
      snapshotWs.on("finish", () => resolve());
      snapshotWs.end();
    });
    if (rebuildAborted) {
      // 中断时不提升临时快照，避免把半成品写成正式缓存。
      await fs.rm(artifacts.snapshotTmpPath, { force: true }).catch(() => {});
      return;
    }

    await fs.rename(artifacts.snapshotTmpPath, artifacts.snapshotPath).catch(async () => {
      await fs.copyFile(artifacts.snapshotTmpPath, artifacts.snapshotPath);
      await fs.unlink(artifacts.snapshotTmpPath).catch(() => {});
    });

    if (context.cacheAppendTimer) {
      clearTimeout(context.cacheAppendTimer);
      context.cacheAppendTimer = null;
    }
    context.cacheAppendQueue.length = 0;
    try {
      context.cacheAppendWs?.end();
    } catch {}
    context.cacheAppendWs = null;

    await fs.rm(artifacts.deltaPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.legacyPath, { force: true }).catch(() => {});
    await fs.rm(artifacts.legacyTmpPath, { force: true }).catch(() => {});

    context.index = nextIndex;
    context.pathToId = nextPathToId;
    context.driveCounts = nextDriveCounts;
    context.indexedCountHint = context.pathToId.size;
  } finally {
    try {
      snapshotWs.end();
    } catch {}
    context.finishIndexingProgress();
    context.isIndexing = false;
    context.pauseUntil = 0;
    context.scheduleIdleCompactIfNeeded();
  }
}
