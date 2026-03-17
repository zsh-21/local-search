﻿﻿﻿﻿﻿import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Document } from 'flexsearch';
import { toPinyinFull, toPinyinInitials } from './pinyin';
import { shouldIndexFile, normalizeDrive, classifyKind, shouldSkipHiddenOrSystemPath } from './file/utils';
import { RecursiveScanner } from './file/scanners/recursiveScanner';
import { UsnScanner } from './file/scanners/usnScanner';
import { SystemDetector } from './file/systemDetector';

export interface FileIndexEntry {
	path: string;
	name: string;
	isDirectory: boolean;
	timeMs?: number;
	// 索引时使用的可选字段
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

const tokenizeCache = new Map<string, string[]>();
const flexsearchEncode = (raw: string) => {
	const s = (raw || '').toLowerCase();
	if (!s) return [];
	const cached = tokenizeCache.get(s);
	if (cached) return cached.slice();

	const out: string[] = [];
	// token 上限：过低会导致“路径组合检索”丢关键 token（如 26-3 中的 3、扩展名 doc 等）
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

	const segs = s.match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
	for (const seg of segs) {
		if (!seg) continue;
		const isAscii = /^[a-z0-9]+$/.test(seg);
		if (isAscii) {
			push(seg);
			// 长前缀适度放宽：仅对较短英文词扩大前缀长度，避免长词生成过多 token
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

		// 中文分词增强：支持“前缀组合检索”（例如：目录名“测试目录”，搜索“测试”也能命中）
		// 控制 token 数量：只添加 2/3 字前缀，避免 tokens 爆炸
		if (seg.length >= 2) push(seg.slice(0, 2));
		if (seg.length >= 3) push(seg.slice(0, 3));

		// 单字匹配会显著增加 token 数量，且容易带来噪声
		// 这里只对“极短中文词”（长度<=2）启用逐字 token，满足常用检索（如“简 历”）
		if (seg.length <= 2) {
			for (let i = 0; i < seg.length; i++) push(seg[i]);
		}
	}

	tokenizeCache.set(s, out.slice());
	return out;
};
export interface RebuildRoot {
  path: string;
  isSSD: boolean;
}

export class FileIndex {
  private index: Document<FlexSearchDoc> | null = null;
  private pathToId = new Map<string, string>();
  private driveCounts = new Map<string, number>();
  private readonly cachePath: string;
  private readonly maxEntries: number;
  private isIndexing = false;
  private abortRequested = false; // 用于中止索引任务
  private pauseUntil = 0;
  private lowPriority = true;
  private rebuildStartedAt = 0;
  private partialPublished = false;
  private lastYieldAt = 0;
  private ignoredPrefixes: Array<{ prefix: string; prefixWithSep: string }> = [];
  private ignoredAnyDirNames = new Set<string>();
	// 常用扩展名集合：用于索引构建时“优先处理这些文件”，只影响构建顺序不影响覆盖范围
	private preferredFileExts = new Set<string>();
  // 增量落盘：watcher ingest/remove 会追加写入 cache，保证跨重启持久化
  private cacheAppendWs: WriteStream | null = null;
  private cacheAppendQueue: string[] = [];
  private cacheAppendFlushing = false;
  private cacheAppendTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { cachePath: string; maxEntries?: number }) {
    this.cachePath = options.cachePath;
    this.maxEntries = options.maxEntries ?? 750_000;
  }

  reset() {
    this.index = null;
    this.pathToId.clear();
    this.driveCounts.clear();
    this.isIndexing = false;
    this.abortRequested = false;
    this.pauseUntil = 0;
    this.rebuildStartedAt = 0;
    this.partialPublished = false;
    this.lastYieldAt = 0;
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

  // 显式中止当前索引任务
  abortRebuild() {
    if (this.isIndexing) this.abortRequested = true;
  }

	async getStatus(): Promise<FileIndexStatus> {
		return {
			isIndexing: this.isIndexing,
			indexedCount: this.pathToId.size,
		};
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
			.map(([drive, count]) => ({
				drive: drive === 'other' ? 'other' : `${drive.toUpperCase()}:`,
				count,
			}))
			.sort((a, b) => a.drive.localeCompare(b.drive));
		return { totalCount: this.pathToId.size, drives };
	}

	setSearchWindowVisible(visible: boolean) {
		this.lowPriority = visible;
		if (visible) this.pauseUntil = 0;
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
			const anyDirMatch = s.match(/^\*\*\\([^\\\/]+)$/) || s.match(/^\*\*\/([^\\\/]+)$/);
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
			if (!p) continue;
			if (seen.has(p)) continue;
			seen.add(p);
			next.push({ prefix: p, prefixWithSep: `${p}\\` });
		}
		next.sort((a, b) => b.prefix.length - a.prefix.length);
		this.ignoredPrefixes = next;
		this.ignoredAnyDirNames = anyDirNames;
	}

	setPreferredFileExtensions(list: string[]) {
		// 规范化扩展名配置
		// - 统一小写
		// - 无点号时自动补点
		// - 限制长度避免异常值影响排序逻辑
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
		if (!this.ignoredPrefixes.length) return false;
		for (const it of this.ignoredPrefixes) {
			if (t === it.prefix) return true;
			if (t.startsWith(it.prefixWithSep)) return true;
		}
		return false;
	}

	pauseIndexingFor(ms: number) {
		if (!this.isIndexing) return;
		const now = Date.now();
		const until = now + Math.max(0, ms);
		this.pauseUntil = Math.max(this.pauseUntil, until);
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
		if (sleepMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
		} else {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
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
		if (!this.index) {
			this.index = this.createIndex();
		}
		return this.index;
	}

  private ensureCacheAppendStream() {
    if (this.cacheAppendWs) return this.cacheAppendWs;
    try {
      // 追加模式：避免覆盖已有缓存；目录不存在时由写入前?mkdir 负责创建
      this.cacheAppendWs = createWriteStream(this.cachePath, { encoding: 'utf-8', flags: 'a' });
      this.cacheAppendWs.on('error', () => {
        try {
          this.cacheAppendWs?.end();
        } catch {}
        this.cacheAppendWs = null;
      });
      return this.cacheAppendWs;
    } catch {
      this.cacheAppendWs = null;
      return null;
    }
  }

  private async flushCacheAppendQueue() {
    if (this.cacheAppendFlushing) return;
    if (this.cacheAppendQueue.length === 0) return;
    this.cacheAppendFlushing = true;
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true }).catch(() => {});
      const ws = this.ensureCacheAppendStream();
      if (!ws) return;
      while (this.cacheAppendQueue.length > 0) {
        const chunk = this.cacheAppendQueue.splice(0, Math.min(200, this.cacheAppendQueue.length)).join('');
        if (!chunk) continue;
        if (!ws.write(chunk)) {
          await new Promise<void>((resolve) => ws.once('drain', () => resolve()));
        }
      }
    } catch {
      // best effort: 落盘失败不影响索引内存?
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
    // 轻量延迟合并：减少高?fs.watch 事件导致的频?I/O
    if (this.cacheAppendTimer) return;
    this.cacheAppendTimer = setTimeout(() => {
      this.cacheAppendTimer = null;
      void this.flushCacheAppendQueue();
    }, 80);
  }

	private buildPathText(entryPath: string) {
		// 将路径拆分为更适合搜索的文本：
		// - 统一分隔符为 '\\'
		// - 用空格拼接各级目录与文件?
		// - 保留扩展名（?doc/docx）与数字片段（如 26-3 -> 26 3?
		const raw = typeof entryPath === 'string' ? entryPath.trim() : '';
		if (!raw) return '';
		const normalized = raw.replace(/\//g, '\\').replace(/\\+/g, '\\');
		const parts = normalized.split('\\').filter(Boolean);
		return parts.join(' ');
	}

	private extractSearchTokens(rawQuery: string) {
		// 从用户输入中提取“更可能有效”的检?token?
		// - 支持用户把一段总结/说明直接粘贴到搜索框
		// - 丢弃大量无意义停用词，保留目录名/数字/扩展?英文缩写?
		const s = (rawQuery || '').toLowerCase();
		if (!s) return [];
		const segs = s.match(/[\u3400-\u4dbf\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
		const stop = new Set([
			'比如',
			'例如',
			'那么',
			'可以',
			'通过',
			'或者',
			'可',
			'方式',
			'搜索',
			'文件',
			'这个',
			'总结',
			'复制',
			'进去',
			'还是',
			'不行',
			'怎么',
			'我要',
			'我',
		]);
		const out: string[] = [];
		const seen = new Set<string>();
		for (const seg of segs) {
			const token = String(seg || '').trim();
			if (!token) continue;
			if (stop.has(token)) continue;

			const isDigits = /^[0-9]+$/.test(token);
			const isAscii = /^[a-z0-9]+$/.test(token);
			if (isAscii) {
				// 过滤掉无意义的单字符英文，但保留数字（如 3?
				if (!isDigits && token.length <= 1) continue;
			} else {
				// 中文 token 太短往往噪声较大：长度为 1 的中文默认跳?
				if (token.length <= 1) continue;
			}

			if (seen.has(token)) continue;
			seen.add(token);
			out.push(token);
			if (out.length >= 10) break;
		}
		return out;
	}

	async ingestPath(entryPath: string, isDirectory: boolean, timeMs?: number) {
		if (!entryPath) return;
		//  ingest Ҫޣлͣյ Worker OOM
		if (this.pathToId.size >= this.maxEntries) return;
		if (process.platform === 'win32') {
			if (!/^[a-zA-Z]:/.test(entryPath) && !entryPath.startsWith('\\')) return;
		} else {
			if (!entryPath.startsWith('/')) return;
		}

		const index = await this.ensureIndex();
		const key = entryPath.toLowerCase();
		if (this.pathToId.has(key)) return;
		if (this.isIgnoredPath(entryPath)) return;

		const name = path.basename(entryPath);
		const ext = path.extname(name).toLowerCase();
		if (!shouldIndexFile(isDirectory, ext)) return;
		const kind = classifyKind(isDirectory, ext);
		const drive = normalizeDrive(entryPath);
		const driveKey = drive || 'other';
		const pinyinFull = toPinyinFull(name);
		const initials = toPinyinInitials(name);
		const pathText = this.buildPathText(entryPath);
		const normalizedTimeMs = Number.isFinite(timeMs) ? Math.max(0, Number(timeMs)) : 0;

		const doc: FlexSearchDoc = {
			id: key,
			path: entryPath,
			name,
			pinyin: pinyinFull,
			initials,
			pathText,
			isDirectory,
			timeMs: normalizedTimeMs,
			kind,
			ext,
			drive,
		};
		index.add(doc);
		this.pathToId.set(key, key);
		this.bumpDriveCount(driveKey, 1);

		// ̣insert ׷д뻺棬֤Կɿ loadCache
		this.enqueueCacheDelta(JSON.stringify({ op: 'i', p: entryPath, d: isDirectory ? 1 : 0, t: normalizedTimeMs }));
	}

	async removePath(entryPath: string) {
		if (!entryPath) return;
		const key = entryPath.toLowerCase();
		const id = this.pathToId.get(key);
		if (!id) return;
		const index = await this.ensureIndex();
		try {
			index.remove(id);
		} catch {}
		this.pathToId.delete(key);
		this.bumpDriveCount(this.getDriveKeyFromPath(entryPath), -1);

		// ̣remove ׷д뻺棨loadCache ʱطŲɾ
		this.enqueueCacheDelta(JSON.stringify({ op: 'r', p: entryPath }));
	}

	async loadCache(): Promise<boolean> {
		if (!existsSync(this.cachePath)) return false;

		this.isIndexing = true;
		this.rebuildStartedAt = Date.now();
		this.partialPublished = false;
		this.lastYieldAt = Date.now();
		this.index = this.createIndex();
		this.pathToId.clear();
		this.driveCounts.clear();

		try {
			const stream = createReadStream(this.cachePath, { encoding: 'utf-8' });
			const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

			const batch: Array<{ path: string; isDirectory: boolean; timeMs: number }> = [];
			const BATCH_SIZE = 500;

			const processBatch = async () => {
				if (batch.length === 0) return;
				if (!this.index) return;

				for (const e of batch) {
					const p = e.path;
					if (!p) continue;
					const key = p.toLowerCase();
					if (this.pathToId.has(key)) continue;
					if (this.isIgnoredPath(p)) continue;
					if (!e.isDirectory) {
						const ext = path.extname(p).toLowerCase();
						if (!shouldIndexFile(false, ext)) continue;
					}

					const name = path.basename(p);
					const ext = path.extname(p).toLowerCase();
					const doc: FlexSearchDoc = {
						id: key,
						path: p,
						name,
						pinyin: toPinyinFull(name),
						initials: toPinyinInitials(name),
						pathText: this.buildPathText(p),
						isDirectory: e.isDirectory,
						timeMs: Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0,
						kind: classifyKind(e.isDirectory, ext),
						ext,
						drive: normalizeDrive(p),
					};
					this.index.add(doc);
					this.pathToId.set(key, key);
					this.bumpDriveCount(doc.drive || 'other', 1);
				}
				batch.length = 0;
			};

			let count = 0;
			for await (const line of rl) {
				const raw = line.trim();
				if (!raw) continue;

				if (count >= this.maxEntries) break;

				let p = '';
				let isDirectory = false;
				let timeMs = 0;
				let op: 'i' | 'r' | '' = '';
				if (raw.startsWith('{')) {
					try {
						const obj = JSON.parse(raw);
						op = obj?.op === 'i' || obj?.op === 'r' ? obj.op : '';
						p = typeof obj?.p === 'string' ? obj.p : '';
						isDirectory = obj?.d === 1 || obj?.d === true;
						timeMs = Number.isFinite(obj?.t) ? Math.max(0, Number(obj.t)) : 0;
					} catch {}
				} else {
					p = raw;
				}
				p = typeof p === 'string' ? p.trim() : '';
				if (!p) continue;
				if (process.platform === 'win32' && !/^[a-zA-Z]:/.test(p) && !p.startsWith('\\')) continue;

				const key = p.toLowerCase();
				if (op === 'r') {
					const existed = this.pathToId.has(key);
					const id = this.pathToId.get(key);
					if (id && this.index) {
						try {
							this.index.remove(id);
						} catch {}
					}
					this.pathToId.delete(key);
					if (existed) this.bumpDriveCount(this.getDriveKeyFromPath(p), -1);
					continue;
				}
				if (this.pathToId.has(key)) continue;
				if (!isDirectory) {
					const ext = path.extname(p).toLowerCase();
					if (!shouldIndexFile(false, ext)) continue;
				}
				if (this.isIgnoredPath(p)) continue;

				batch.push({ path: p, isDirectory, timeMs });
				count++;

				if (batch.length >= BATCH_SIZE) {
					await processBatch();
					await this.cooperativeYield(() => {});
				}
			}
			await processBatch();
			await this.cooperativeYield(() => {});

			return count > 0;
		} catch {
			if (!this.index) this.index = this.createIndex();
			return false;
		} finally {
			this.isIndexing = false;
			this.pauseUntil = 0;
			// loadCache ɺˢһ̶Уδ flush
			void this.flushCacheAppendQueue();
		}
	}

	async buildIfEmpty() {
		if (this.pathToId.size > 0) return;
		await this.rebuild();
	}

	/**
	 * 重建索引
	 * 核心逻辑：基于文档的分级策略选择扫描?
	 * 
	 * 策略选择逻辑?
	 * 1. 尝试使用 USN 扫描?(UsnScanner)
	 *    - 前置条件：hasNativeSupport (必须) + Admin (推荐) + NTFS (必须)
	 *    - 如果检测失败或未集成，UsnScanner 会抛出异?
	 * 2. 降级使用递归扫描?(RecursiveScanner)
	 *    - 场景：无原生插件、非 NTFS 分区、权限不?
	 *    - 特性：使用并发队列优化 SSD 读取性能
	 */
	async rebuild(explicitRoots?: (string | RebuildRoot)[]) {
		if (this.isIndexing) return;
		this.isIndexing = true;
		this.abortRequested = false;
		this.rebuildStartedAt = Date.now();
		this.partialPublished = false;
		this.lastYieldAt = Date.now();

		const existingCount = this.pathToId.size;
		const publishIncrementally = existingCount <= 0;
		const nextIndex = this.createIndex();
		const nextPathToId = new Map<string, string>();
		const nextDriveCounts = new Map<string, number>();
		const tmpPath = `${this.cachePath}.tmp`;
		await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
		const cacheWs = createWriteStream(tmpPath, { encoding: 'utf-8' });
		
		let entryCount = 0;
		const batch: FileIndexEntry[] = [];
		const BATCH_SIZE = 500;
        let processedSinceYield = 0;

		const flushBatch = async () => {
			if (batch.length === 0) return;
			const toWrite = batch.slice();
			batch.length = 0; // գⲢӵµظ©

			for (const e of toWrite) {
				const ext = e.ext || path.extname(e.name).toLowerCase();
				const timeMs = Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0;
				const key = e.path.toLowerCase();
				if (nextPathToId.has(key)) continue;

				const doc: FlexSearchDoc = {
					id: key,
					path: e.path,
					name: e.name,
					pinyin: e.pinyin || toPinyinFull(e.name),
					initials: e.initials || toPinyinInitials(e.name),
					pathText: this.buildPathText(e.path),
					isDirectory: e.isDirectory,
					timeMs,
					kind: e.kind || classifyKind(e.isDirectory, ext),
					ext,
					drive: e.drive || normalizeDrive(e.path),
				};
				nextIndex.add(doc);
				nextPathToId.set(key, key);
				const driveKey = doc.drive || 'other';
				nextDriveCounts.set(driveKey, (nextDriveCounts.get(driveKey) || 0) + 1);
			}

			// д뻺ʱѹʱ write ѻڴ涶
			const CHUNK_SIZE = 200;
			let chunk: string[] = [];
			for (let i = 0; i < toWrite.length; i++) {
				const e = toWrite[i]!;
				const timeMs = Number.isFinite(e.timeMs) ? Math.max(0, Number(e.timeMs)) : 0;
				chunk.push(`${JSON.stringify({ p: e.path, d: e.isDirectory ? 1 : 0, t: timeMs })}\n`);
				if (chunk.length >= CHUNK_SIZE) {
					const lines = chunk.join('');
					chunk = [];
					if (!cacheWs.write(lines)) {
						await new Promise<void>((resolve) => cacheWs.once('drain', () => resolve()));
					}
				}
			}
			if (chunk.length > 0) {
				const lines = chunk.join('');
				if (!cacheWs.write(lines)) {
					await new Promise<void>((resolve) => cacheWs.once('drain', () => resolve()));
				}
			}
		};
		const maybePublishPartial = () => {
			if (!publishIncrementally) return;
			if (this.partialPublished) return;
			if (Date.now() - this.rebuildStartedAt < 2500) return;
			if (nextPathToId.size <= 0) return;
			this.index = nextIndex;
			this.pathToId = nextPathToId;
			this.driveCounts = nextDriveCounts;
			this.partialPublished = true;
		};

		if (publishIncrementally) {
			this.index = nextIndex;
			this.pathToId = nextPathToId;
			this.driveCounts = nextDriveCounts;
			this.partialPublished = true;
		}

		const addNext = (entry: FileIndexEntry) => {
			if (entryCount >= this.maxEntries) return;
			if (this.isIgnoredPath(entry.path)) return;
			if (nextPathToId.has(entry.path.toLowerCase())) return;
			if (!entry.isDirectory) {
				const ext = path.extname(entry.name).toLowerCase();
				if (!shouldIndexFile(false, ext)) return;
			}
			
			batch.push({ ...entry, timeMs: Number.isFinite(entry.timeMs) ? Math.max(0, Number(entry.timeMs)) : 0 });
			entryCount++;
		};

        const shouldStop = () => this.abortRequested || entryCount >= this.maxEntries;

        // 确定扫描根目录及性能配置
		let roots: string[] = [];
        let isSSD = true;

        if (explicitRoots && explicitRoots.length > 0) {
            roots = explicitRoots.map(r => typeof r === 'string' ? r : r.path);
            // 如果显式传入的根路径中有任何一个不?SSD，则采取更稳健的并发策略
            isSSD = explicitRoots.every(r => typeof r === 'string' ? true : r.isSSD);
        } else {
            try {
                const info = await SystemDetector.getInstance().detect();
                // 索引优先级：优先处理?C 盘（Windows），避免系统盘占?IO 影响体验
                roots = info.drives
                    .slice()
                    .sort((a, b) => {
                        const da = String(a?.mountPoint || '').toUpperCase();
                        const db = String(b?.mountPoint || '').toUpperCase();
                        const pa = da === 'C:' ? 1 : 0;
                        const pb = db === 'C:' ? 1 : 0;
                        if (pa !== pb) return pa - pb;
                        return da.localeCompare(db);
                    })
                    .map(d => d.mountPoint + '\\');
                isSSD = info.drives.every(d => d.isSSD);
            } catch {
                roots = ['C:\\'];
                isSSD = false;
            }
        }

        // 策略选择：尝?USN -> 降级 Recursive
        try {
            const usnScanner = new UsnScanner(this.isIgnoredPath.bind(this));
            await usnScanner.scan(roots, addNext, shouldStop);
        } catch (e) {
            const recursiveScanner = new RecursiveScanner(this.isIgnoredPath.bind(this), this.preferredFileExts);
            
            // 包装进度回调以处理协作式让步
            const wrappedProgress = async (entry: FileIndexEntry) => {
                addNext(entry);
                processedSinceYield++;
                // 索引过程中更细粒度的控制：每处理 200 个文件（或根据负载调整）执行一次让?
                const yieldBatch = this.lowPriority ? 150 : 300;
                if (processedSinceYield % yieldBatch === 0) {
                     if (batch.length >= BATCH_SIZE) await flushBatch();
                     await this.cooperativeYield(maybePublishPartial);
                }
            };
            
            await recursiveScanner.scan(roots, wrappedProgress, shouldStop, isSSD);
        }

		try {
			// 刷新剩余数据并完成构?
			await flushBatch();
			await new Promise<void>((resolve) => {
				cacheWs.on('finish', () => resolve());
				cacheWs.end();
			});
			await fs.rename(tmpPath, this.cachePath).catch(async () => {
				await fs.copyFile(tmpPath, this.cachePath);
				await fs.unlink(tmpPath);
			});

			this.index = nextIndex;
			this.pathToId = nextPathToId;
			this.driveCounts = nextDriveCounts;
		} finally {
			try {
				cacheWs.end();
			} catch {}
			this.isIndexing = false;
			this.pauseUntil = 0;
		}
	}

		async search(
		query: string,
		limit = 100,
		options?: { where?: any }
	): Promise<{ results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number; rawCount: number }> {
		const index = await this.ensureIndex();
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { results: [], isIndexing: this.isIndexing, totalCount: 0, rawCount: 0 };

		const matchesWhere = (doc: FlexSearchDoc, where?: any) => {
			if (!where) return true;
			const clauses = Array.isArray(where?.and) ? where.and : [where];
			for (const clause of clauses) {
				if (!clause) continue;
				if (typeof clause.isDirectory === 'boolean' && doc.isDirectory !== clause.isDirectory) return false;
				const ext = (doc.ext || '').toLowerCase();
				const drive = (doc.drive || '').toLowerCase();
				const inList = clause?.ext?.in;
				const notInList = clause?.ext?.nin;
				const eqDrive = clause?.drive?.eq;
				if (Array.isArray(inList) && !inList.map((x: any) => String(x).toLowerCase()).includes(ext)) return false;
				if (Array.isArray(notInList) && notInList.map((x: any) => String(x).toLowerCase()).includes(ext)) return false;
				if (typeof eqDrive === 'string' && eqDrive.toLowerCase() !== drive) return false;
			}
			return true;
		};

		const normalizeResults = (raw: any): Array<{ id: string; doc: FlexSearchDoc | null; rank: number }> => {
			const out: Array<{ id: string; doc: FlexSearchDoc | null }> = [];
			const seen = new Set<string>();
			const push = (id: any, doc: any) => {
				const key = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
				if (!key || seen.has(key)) return;
				seen.add(key);
				out.push({ id: key, doc: doc || null });
			};

			if (Array.isArray(raw)) {
				if (raw.length > 0 && raw[0] && typeof raw[0] === 'object' && 'id' in raw[0]) {
					for (const item of raw) push((item as any).id, (item as any).doc);
				} else {
					for (const group of raw) {
						const result = (group as any)?.result;
						if (!Array.isArray(result)) continue;
						for (const item of result) {
							if (item && typeof item === 'object' && 'id' in item) {
								push((item as any).id, (item as any).doc);
							} else {
								push(item, null);
							}
						}
					}
				}
			}

			const size = out.length;
			return out.map((item, idx) => ({
				...item,
				rank: Math.max(1, size - idx),
			}));
		};

		const doSearch = (term: string, l: number) => {
			const raw = index.search(term, {
				limit: l,
				enrich: true,
				merge: true,
				field: ['name', 'pinyin', 'initials', 'pathText'],
			}) as any;
			return normalizeResults(raw);
		};

		// ûճһıȡ token Ϊ
		const tokens = this.extractSearchTokens(queryLower);
		const normalizedTerm = tokens.length > 0 ? tokens.join(' ') : queryLower;

		let mergedHits = doSearch(normalizedTerm, limit * 3);

		// δ token ϶࣬򽵼Ϊ token ϲ
		if (mergedHits.length === 0 && tokens.length >= 2) {
			const merged = new Map<string, { doc: FlexSearchDoc | null; scoreSum: number; hitCount: number }>();
			const tokenList = tokens.slice(0, 6);
			for (const t of tokenList) {
				const hits = doSearch(t, Math.max(limit, 120));
				for (const hit of hits) {
					const doc = hit.doc || (index.get(hit.id) as any);
					if (!doc?.path) continue;
					const key = String(hit.id);
					const prev = merged.get(key);
					const score = hit.rank || 0;
					if (prev) {
						prev.scoreSum += score;
						prev.hitCount += 1;
					} else {
						merged.set(key, { doc, scoreSum: score, hitCount: 1 });
					}
				}
			}
			mergedHits = Array.from(merged.values())
				.map((x) => ({
					id: x.doc?.path ? x.doc.path.toLowerCase() : '',
					doc: x.doc,
					rank: x.scoreSum + x.hitCount * 0.15,
				}))
				.sort((a, b) => (b.rank || 0) - (a.rank || 0))
				.slice(0, limit * 3);
		}

		const rawCount = Array.isArray(mergedHits) ? mergedHits.length : 0;
		const results: FileIndexSearchResult[] = [];
		for (const hit of mergedHits || []) {
			const doc = (hit.doc || (index.get(hit.id) as any)) as FlexSearchDoc | null;
			const p = doc?.path as string;
			if (!p || this.isIgnoredPath(p)) continue;
			if (!doc || !matchesWhere(doc, options?.where)) continue;

			const nameLower = String(doc.name || '').toLowerCase();
			let score = Number(hit.rank || 0) * 10;
			if (nameLower === queryLower) score += 5000;
			else if (nameLower.startsWith(queryLower)) score += 2000;
			else if (nameLower.includes(queryLower)) score += 600;
			const pathLower = String(doc.path || '').toLowerCase();
			if (pathLower.includes(queryLower)) score += 200;

			results.push({
				path: p,
				name: (doc?.name as string) || '',
				isDirectory: Boolean(doc?.isDirectory),
				timeMs: Number.isFinite(doc?.timeMs) ? Math.max(0, Number(doc.timeMs)) : 0,
				score,
			});
			if (results.length >= limit) break;
		}

		const totalCount = results.length;
		return { results, isIndexing: this.isIndexing, totalCount, rawCount };

	}
}





























