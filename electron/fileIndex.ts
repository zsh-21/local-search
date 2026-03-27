import fs from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { Document } from 'flexsearch';
import { normalizeDrive, shouldSkipHiddenOrSystemPath } from './file/utils';
import { fileIndexLoadCache } from './file/indexLoadCache';
import {
  fileIndexBuildPathText,
  fileIndexExtractSearchTokens,
  fileIndexIngestPath,
  fileIndexRemovePath,
} from './file/indexPathOps';
import { fileIndexRebuild } from './file/indexRebuild';
import { fileIndexSearch } from './file/indexSearch';
import { clearTokenizeCache, createFlexsearchEncode } from './file/indexTokenize';
import { getDeltaPath } from './file/indexCacheLayout';

export interface FileIndexEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  timeMs?: number;
  kind?: string;
  ext?: string;
  drive?: string;
  pinyin?: string;
  initials?: string;
}

export interface FileIndexSearchResult extends FileIndexEntry {
  score: number;
}

export interface FileIndexStatus {
  isIndexing: boolean;
  indexedCount: number;
  progress: number;
}

interface FlexSearchDoc {
  [id: string]: any;
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
}

const IDLE_COMPACT_DELAY_MS = 45_000;
const ENABLE_IDLE_COMPACT = false;
const flexsearchEncode = createFlexsearchEncode();

export interface RebuildRoot {
  path: string;
  isSSD: boolean;
}

export class FileIndex {
  private index: Document<FlexSearchDoc> | null = null;
  private pathToId = new Map<string, string>();
  private driveCounts = new Map<string, number>();
  private readonly cachePath: string;
  private readonly deltaPath: string;
  private readonly maxEntries: number;
  private isIndexing = false;
  private abortRequested = false;
  private pauseUntil = 0;
  private lowPriority = true;
  private rebuildStartedAt = 0;
  private indexingProgressStartedAt = 0;
  private indexingProgressCount = 0;
  private indexingProgress = 0;
  private partialPublished = false;
  private lastYieldAt = 0;
  private ignoredPrefixes: Array<{ prefix: string; prefixWithSep: string }> = [];
  private ignoredAnyDirNames = new Set<string>();
  private searchWindowVisible = false;
  private isCompacted = false;
  private indexedCountHint = 0;
  private compactTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreFromCacheTask: Promise<void> | null = null;
  private preferredFileExts = new Set<string>();
  private cacheAppendWs: WriteStream | null = null;
  private cacheAppendQueue: string[] = [];
  private cacheAppendFlushing = false;
  private cacheAppendTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelledSearchSessions = new Map<string, number>();

  constructor(options: { cachePath: string; maxEntries?: number }) {
    this.cachePath = options.cachePath;
    this.deltaPath = getDeltaPath(this.cachePath);
    this.maxEntries = options.maxEntries ?? 750_000;
  }

  reset() {
    this.index = null;
    this.pathToId.clear();
    this.driveCounts.clear();
    this.searchWindowVisible = false;
    this.indexedCountHint = 0;
    this.isCompacted = false;
    this.restoreFromCacheTask = null;
    if (this.compactTimer) {
      clearTimeout(this.compactTimer);
      this.compactTimer = null;
    }
    clearTokenizeCache();
    this.isIndexing = false;
    this.resetIndexingProgress();
    this.abortRequested = false;
    this.pauseUntil = 0;
    this.rebuildStartedAt = 0;
    this.partialPublished = false;
    this.lastYieldAt = 0;
    this.cancelledSearchSessions.clear();
    this.cacheAppendQueue.length = 0;
    this.cacheAppendFlushing = false;
    if (this.cacheAppendTimer) {
      clearTimeout(this.cacheAppendTimer);
      this.cacheAppendTimer = null;
    }
    try {
      this.cacheAppendWs?.end();
    } catch {}
    this.cacheAppendWs = null;
  }

  abortRebuild() {
    if (this.isIndexing) this.abortRequested = true;
  }

  async getStatus(): Promise<FileIndexStatus> {
    return {
      isIndexing: this.isIndexing,
      indexedCount: this.isCompacted ? this.indexedCountHint : this.pathToId.size,
      progress: this.isIndexing ? Math.max(0.01, Math.min(0.99, this.indexingProgress)) : 1,
    };
  }

  private resetIndexingProgress() {
    this.indexingProgressStartedAt = 0;
    this.indexingProgressCount = 0;
    this.indexingProgress = 0;
  }

  private startIndexingProgress() {
    this.indexingProgressStartedAt = Date.now();
    this.indexingProgressCount = 0;
    this.indexingProgress = 0.01;
  }

  private bumpIndexingProgress(step = 1) {
    if (!this.isIndexing) return;
    const delta = Number.isFinite(step) ? Math.max(0, Math.floor(step)) : 0;
    if (delta > 0) this.indexingProgressCount += delta;
    const elapsedSec = Math.max(0, (Date.now() - this.indexingProgressStartedAt) / 1000);
    const countProgress = Math.min(0.96, Math.log10(this.indexingProgressCount + 1) / 5.3);
    const timeProgress = Math.min(0.9, (elapsedSec / 120) * 0.9);
    this.indexingProgress = Math.min(0.99, Math.max(this.indexingProgress, countProgress, timeProgress, 0.01));
  }

  private finishIndexingProgress() {
    this.indexingProgress = 1;
  }

  private getDriveKeyFromPath(entryPath: string) {
    const drive = normalizeDrive(entryPath);
    return drive || 'other';
  }

  private bumpDriveCount(driveKey: string, delta: number) {
    if (!driveKey) return;
    const prev = this.driveCounts.get(driveKey) || 0;
    const next = prev + delta;
    if (next <= 0) this.driveCounts.delete(driveKey);
    else this.driveCounts.set(driveKey, next);
  }

  async getDriveStats(): Promise<{ totalCount: number; drives: Array<{ drive: string; count: number }> }> {
    const drives = Array.from(this.driveCounts.entries())
      .map(([drive, count]) => ({ drive: drive === 'other' ? 'other' : `${drive.toUpperCase()}:`, count }))
      .sort((a, b) => a.drive.localeCompare(b.drive));
    const totalCount = this.isCompacted ? this.indexedCountHint : this.pathToId.size;
    return { totalCount, drives };
  }

  setSearchWindowVisible(visible: boolean) {
    this.searchWindowVisible = visible;
    // 索引优先级与窗口可见性保持一致：窗口隐藏（后台）时降为低优先级，降低对系统交互的影响。
    this.lowPriority = !visible;
    if (visible) {
      this.pauseUntil = 0;
      this.clearIdleCompactTimer();
      return;
    }
    this.scheduleIdleCompactIfNeeded();
  }

  setIgnoredPaths(paths: string[]) {
    const raw: string[] = Array.isArray(paths) ? paths : [];
    const next: Array<{ prefix: string; prefixWithSep: string }> = [];
    const seen = new Set<string>();
    const anyDirNames = new Set<string>();
    for (const v of raw) {
      if (typeof v !== 'string') continue;
      let s = v.replace(/\//g, '\\').trim();
      if (!s) continue;
      s = s.replace(/\\+/g, '\\');
      const anyDirMatch = s.match(/^\*\*\\([^\\/]+)$/) || s.match(/^\*\*\/([^\\/]+)$/);
      if (anyDirMatch) {
        const name = (anyDirMatch[1] || '').trim().toLowerCase();
        if (name) anyDirNames.add(name);
        continue;
      }
      if (/^[a-zA-Z]:$/.test(s)) s += '\\';
      if (/^[a-zA-Z]:\\$/.test(s)) {
        const p = s.toLowerCase();
        if (seen.has(p)) continue;
        seen.add(p);
        next.push({ prefix: p, prefixWithSep: p });
        continue;
      }
      s = s.replace(/\\$/g, '');
      const p = s.toLowerCase();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      next.push({ prefix: p, prefixWithSep: `${p}\\` });
    }
    next.sort((a, b) => b.prefix.length - a.prefix.length);
    this.ignoredPrefixes = next;
    this.ignoredAnyDirNames = anyDirNames;
  }

  setPreferredFileExtensions(list: string[]) {
    const raw = Array.isArray(list) ? list : [];
    const next = new Set<string>();
    for (const it of raw) {
      const s = typeof it === 'string' ? it.trim().toLowerCase() : '';
      if (!s) continue;
      const v = s.startsWith('.') ? s : `.${s}`;
      if (v.length < 2 || v.length > 12) continue;
      next.add(v);
      if (next.size >= 200) break;
    }
    this.preferredFileExts = next;
  }

  isIgnoredPath(targetPath: string) {
    if (!targetPath) return false;
    if (shouldSkipHiddenOrSystemPath(targetPath)) return true;
    const t = targetPath.replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
    if (this.ignoredAnyDirNames.size > 0) {
      for (const name of this.ignoredAnyDirNames) {
        if (!name) continue;
        const seg = `\\${name}\\`;
        if (t.includes(seg)) return true;
        if (t.endsWith(`\\${name}`) || t === name) return true;
      }
    }
    for (const it of this.ignoredPrefixes) {
      if (t === it.prefix) return true;
      if (t.startsWith(it.prefixWithSep)) return true;
    }
    return false;
  }

  pauseIndexingFor(ms: number) {
    if (!this.isIndexing) return;
    const until = Date.now() + Math.max(0, ms);
    this.pauseUntil = Math.max(this.pauseUntil, until);
  }

  cancelSearchSession(sessionId: string) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) return;
    this.cancelledSearchSessions.set(normalized, Date.now());
    if (this.cancelledSearchSessions.size <= 2000) return;
    const sorted = Array.from(this.cancelledSearchSessions.entries()).sort((a, b) => a[1] - b[1]);
    const removeCount = this.cancelledSearchSessions.size - 2000;
    for (let i = 0; i < removeCount; i++) {
      const key = sorted[i]?.[0];
      if (!key) continue;
      this.cancelledSearchSessions.delete(key);
    }
  }

  clearCancelledSearchSession(sessionId: string) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) return;
    this.cancelledSearchSessions.delete(normalized);
  }

  isSearchSessionCancelled(sessionId: string) {
    const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalized) return false;
    return this.cancelledSearchSessions.has(normalized);
  }

  private async cooperativeYield(maybePublishPartial: () => void) {
    if (!this.isIndexing) return;
    const now = Date.now();
    const sliceMs = this.lowPriority ? 8 : 14;
    if (now - this.lastYieldAt < sliceMs) return;
    this.lastYieldAt = now;
    while (this.pauseUntil > 0 && Date.now() < this.pauseUntil) {
      maybePublishPartial();
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
    maybePublishPartial();
    const sleepMs = this.lowPriority ? 20 : 0;
    if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private createIndex() {
    return new Document<FlexSearchDoc>({
      tokenize: 'strict',
      encode: flexsearchEncode,
      document: {
        id: 'id',
        index: ['name', 'pinyin', 'initials', 'pathText'],
        store: ['path', 'name', 'isDirectory', 'timeMs', 'kind', 'ext', 'drive'],
      },
    });
  }

  private async ensureIndex() {
    if (!this.index && this.isCompacted) await this.restoreFromCompactedState();
    if (!this.index) this.index = this.createIndex();
    return this.index;
  }

  private clearIdleCompactTimer() {
    if (!this.compactTimer) return;
    clearTimeout(this.compactTimer);
    this.compactTimer = null;
  }

  private scheduleIdleCompactIfNeeded() {
    if (!ENABLE_IDLE_COMPACT) {
      this.clearIdleCompactTimer();
      return;
    }
    if (this.searchWindowVisible || this.isIndexing || this.isCompacted || this.compactTimer) return;
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null;
      void this.compactForIdle();
    }, IDLE_COMPACT_DELAY_MS);
  }

  private async compactForIdle() {
    if (!ENABLE_IDLE_COMPACT) return;
    if (this.searchWindowVisible || this.isIndexing || this.isCompacted) return;
    await this.flushCacheAppendQueue();
    try {
      this.cacheAppendWs?.end();
    } catch {}
    this.cacheAppendWs = null;
    this.indexedCountHint = this.pathToId.size;
    this.index = null;
    this.pathToId.clear();
    clearTokenizeCache();
    this.isCompacted = true;
  }

  private async restoreFromCompactedState() {
    if (!this.isCompacted) return;
    if (!this.restoreFromCacheTask) {
      this.restoreFromCacheTask = (async () => {
        this.isCompacted = false;
        await this.loadCache();
      })().finally(() => {
        this.restoreFromCacheTask = null;
      });
    }
    await this.restoreFromCacheTask;
  }

  private ensureCacheAppendStream() {
    if (this.cacheAppendWs) return this.cacheAppendWs;
    try {
      this.cacheAppendWs = createWriteStream(this.deltaPath, { encoding: 'utf-8', flags: 'a' });
      this.cacheAppendWs.on('error', () => {
        try { this.cacheAppendWs?.end(); } catch {}
        this.cacheAppendWs = null;
      });
      return this.cacheAppendWs;
    } catch {
      this.cacheAppendWs = null;
      return null;
    }
  }

  private async flushCacheAppendQueue() {
    if (this.cacheAppendFlushing || this.cacheAppendQueue.length === 0) return;
    this.cacheAppendFlushing = true;
    try {
      await fs.mkdir(path.dirname(this.deltaPath), { recursive: true }).catch(() => {});
      const ws = this.ensureCacheAppendStream();
      if (!ws) return;
      while (this.cacheAppendQueue.length > 0) {
        const chunk = this.cacheAppendQueue.splice(0, Math.min(200, this.cacheAppendQueue.length)).join('');
        if (!chunk) continue;
        if (!ws.write(chunk)) await new Promise<void>((resolve) => ws.once('drain', () => resolve()));
      }
    } finally {
      this.cacheAppendFlushing = false;
    }
  }

  private enqueueCacheDelta(line: string) {
    if (!line) return;
    this.cacheAppendQueue.push(line.endsWith('\n') ? line : `${line}\n`);
    if (this.cacheAppendQueue.length >= 300) {
      void this.flushCacheAppendQueue();
      return;
    }
    if (this.cacheAppendTimer) return;
    this.cacheAppendTimer = setTimeout(() => {
      this.cacheAppendTimer = null;
      void this.flushCacheAppendQueue();
    }, 80);
  }

  private buildPathText(entryPath: string) {
    return fileIndexBuildPathText(entryPath);
  }

  private extractSearchTokens(rawQuery: string) {
    return fileIndexExtractSearchTokens(rawQuery);
  }

  async ingestPath(entryPath: string, isDirectory: boolean, timeMs?: number) {
    return fileIndexIngestPath(this, entryPath, isDirectory, timeMs);
  }

  async removePath(entryPath: string) {
    return fileIndexRemovePath(this, entryPath);
  }

  async loadCache(): Promise<boolean> {
    return fileIndexLoadCache(this);
  }

  async buildIfEmpty() {
    if (this.pathToId.size > 0 || (this.isCompacted && this.indexedCountHint > 0)) return;
    await this.rebuild();
  }

  async rebuild(explicitRoots?: (string | RebuildRoot)[]) {
    return fileIndexRebuild(this, explicitRoots);
  }

  async search(
    query: string,
    limit = 100,
    options?: { where?: any; sessionId?: string }
  ): Promise<{ results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number; rawCount: number }> {
    return fileIndexSearch(this, query, limit, options);
  }
}
