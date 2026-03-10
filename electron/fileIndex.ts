import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { create, insert, insertMultiple, search, count, remove, type Orama } from '@orama/orama';
import { toPinyinFull, toPinyinInitials } from './pinyin';
import { shouldIndexFile, normalizeDrive, classifyKind } from './file/utils';
import { RecursiveScanner } from './file/scanners/recursiveScanner';
import { UsnScanner } from './file/scanners/usnScanner';
import { SystemDetector } from './file/systemDetector';

export interface FileIndexEntry {
	path: string;
	name: string;
	isDirectory: boolean;
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

const SCHEMA = {
	name: 'string',
	pinyin: 'string',
	initials: 'string',
	path: 'string',
	// 用于“路径分词搜索”：把完整路径拆成更适合分词的文本，支持用目录名/数字/扩展名组合检索
	pathText: 'string',
	isDirectory: 'boolean',
	kind: 'enum',
	ext: 'enum',
	drive: 'enum',
} as const;

type FileDB = Orama<typeof SCHEMA>;

const tokenizer = {
	language: 'custom',
	normalizationCache: new Map<string, string>(),
	tokenize: (raw: string) => {
		const s = (raw || '').toLowerCase();
		if (!s) return [];

		const out: string[] = [];
		// token 上限：过低会导致“路径组合查询”丢关键 token（如 26-3 中的 3、扩展名 doc 等）
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
				const maxPrefix = Math.min(4, seg.length);
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

			// 中文分词增强：支持“前缀组合检索”（例如：目录名“杂七杂八”，搜索“杂七”也能命中）
			// 控制 token 数量：只添加 2/3 字前缀，避免 tokens 爆炸
			if (seg.length >= 2) push(seg.slice(0, 2));
			if (seg.length >= 3) push(seg.slice(0, 3));

			// 单字匹配会显著增加 token 数量，且容易带来噪声。
			// 这里仅对“极短中文词”（长度<=2）启用逐字 token，满足常用检索（如“简 历”）
			if (seg.length <= 2) {
				for (let i = 0; i < seg.length; i++) push(seg[i]);
			}
		}

		return out;
	},
};

export class FileIndex {
	private db: FileDB | null = null;
	private pathToId = new Map<string, string>();
	private readonly cachePath: string;
	private readonly maxEntries: number;
	private isIndexing = false;
	private pauseUntil = 0;
	private lowPriority = true;
	private rebuildStartedAt = 0;
	private partialPublished = false;
	private lastYieldAt = 0;
	private ignoredPrefixes: Array<{ prefix: string; prefixWithSep: string }> = [];
	private ignoredAnyDirNames = new Set<string>();

	constructor(options: { cachePath: string; maxEntries?: number }) {
		this.cachePath = options.cachePath;
		this.maxEntries = options.maxEntries ?? 750_000;
	}

	reset() {
		this.db = null;
		this.pathToId.clear();
		this.isIndexing = false;
		this.pauseUntil = 0;
		this.rebuildStartedAt = 0;
		this.partialPublished = false;
		this.lastYieldAt = 0;
	}

	async getStatus(): Promise<FileIndexStatus> {
		return {
			isIndexing: this.isIndexing,
			indexedCount: this.db ? await count(this.db) : 0,
		};
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

	isIgnoredPath(targetPath: string) {
		if (!targetPath) return false;
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

	private async ensureDB() {
		if (!this.db) {
			this.db = await create({ schema: SCHEMA, components: { tokenizer } as any });
		}
		return this.db;
	}

	private buildPathText(entryPath: string) {
		// 将路径拆分为更适合搜索的文本：
		// - 统一分隔符为 '\\'
		// - 用空格拼接各级目录与文件名
		// - 保留扩展名（如 doc/docx）与数字片段（如 26-3 -> 26 3）
		const raw = typeof entryPath === 'string' ? entryPath.trim() : '';
		if (!raw) return '';
		const normalized = raw.replace(/\//g, '\\').replace(/\\+/g, '\\');
		const parts = normalized.split('\\').filter(Boolean);
		return parts.join(' ');
	}

	private extractSearchTokens(rawQuery: string) {
		// 从用户输入中提取“更可能有效”的检索 token：
		// - 支持用户把一段总结/说明直接粘贴到搜索框
		// - 丢弃大量无意义停用词，保留目录名/数字/扩展名/英文缩写等
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
			'又',
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
				// 过滤掉无意义的单字符英文，但保留数字（如 3）
				if (!isDigits && token.length <= 1) continue;
			} else {
				// 中文 token 太短往往噪声较大：长度为 1 的中文默认跳过
				if (token.length <= 1) continue;
			}

			if (seen.has(token)) continue;
			seen.add(token);
			out.push(token);
			if (out.length >= 10) break;
		}
		return out;
	}

	async ingestPath(entryPath: string, isDirectory: boolean) {
		if (!entryPath) return;
		if (process.platform === 'win32') {
			if (!/^[a-zA-Z]:/.test(entryPath) && !entryPath.startsWith('\\\\')) return;
		} else {
			if (!entryPath.startsWith('/')) return;
		}

		const db = await this.ensureDB();
		const key = entryPath.toLowerCase();
		if (this.pathToId.has(key)) return;
		if (this.isIgnoredPath(entryPath)) return;

		const name = path.basename(entryPath);
		const ext = path.extname(name).toLowerCase();
		if (!shouldIndexFile(isDirectory, ext)) return;
		const kind = classifyKind(isDirectory, ext);
		const drive = normalizeDrive(entryPath);
		const pinyinFull = toPinyinFull(name);
		const initials = toPinyinInitials(name);
		const pathText = this.buildPathText(entryPath);
		const id = await insert(db, {
			path: entryPath,
			name,
			pinyin: pinyinFull,
			initials,
			pathText,
			isDirectory,
			kind,
			ext,
			drive,
		});
		if (typeof id === 'string' && id) this.pathToId.set(key, id);
	}

	async removePath(entryPath: string) {
		if (!entryPath) return;
		const key = entryPath.toLowerCase();
		const id = this.pathToId.get(key);
		if (!id) return;
		const db = await this.ensureDB();
		try {
			await remove(db, id);
		} catch {}
		this.pathToId.delete(key);
	}

	async loadCache(): Promise<boolean> {
		if (!existsSync(this.cachePath)) return false;

		this.isIndexing = true;
		this.rebuildStartedAt = Date.now();
		this.partialPublished = false;
		this.lastYieldAt = Date.now();
		this.db = await create({ schema: SCHEMA, components: { tokenizer } as any });
		this.pathToId.clear();

		try {
			const stream = createReadStream(this.cachePath, { encoding: 'utf-8' });
			const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
			
			const batch: Array<{ path: string; name: string; isDirectory: boolean; kind: string; ext: string; drive: string }> = [];
			const BATCH_SIZE = 5000;

			const processBatch = async () => {
				if (batch.length === 0) return;
				if (!this.db) return;
				const docs = batch.map((e) => ({
					path: e.path,
					name: e.name,
					pinyin: toPinyinFull(e.name),
					initials: toPinyinInitials(e.name),
					pathText: this.buildPathText(e.path),
					isDirectory: e.isDirectory,
					kind: e.kind,
					ext: e.ext,
					drive: e.drive
				}));
				const ids = await insertMultiple(this.db, docs);
			    for (let i = 0; i < docs.length; i++) {
				    const p = docs[i]?.path;
				    const id = (ids as any)[i];
				    if (typeof p === 'string' && p && typeof id === 'string' && id) this.pathToId.set(p.toLowerCase(), id);
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
				if (raw.startsWith('{')) {
					try {
						const obj = JSON.parse(raw);
						p = typeof obj?.p === 'string' ? obj.p : '';
						isDirectory = obj?.d === 1 || obj?.d === true;
					} catch {}
				} else {
					p = raw;
				}
				p = typeof p === 'string' ? p.trim() : '';
				if (!p) continue;
				if (process.platform === 'win32' && !/^[a-zA-Z]:/.test(p) && !p.startsWith('\\\\')) continue;
				
				const key = p.toLowerCase();
				if (this.pathToId.has(key)) continue;
				if (!isDirectory) {
					const ext = path.extname(p).toLowerCase();
					if (!shouldIndexFile(false, ext)) continue;
				}

				batch.push({
					path: p,
					name: path.basename(p),
					isDirectory,
					ext: path.extname(p).toLowerCase(),
					kind: classifyKind(isDirectory, path.extname(p).toLowerCase()),
					drive: normalizeDrive(p),
				});
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
			if (!this.db) this.db = await create({ schema: SCHEMA });
			return false;
		} finally {
			this.isIndexing = false;
			this.pauseUntil = 0;
		}
	}

	async buildIfEmpty() {
		const db = await this.ensureDB();
		const cnt = await count(db);
		if (cnt > 0) return;
		await this.rebuild();
	}

	/**
	 * 重建索引
	 * 核心逻辑：基于文档的分级策略选择扫描器
	 * 
	 * 策略选择逻辑：
	 * 1. 尝试使用 USN 扫描器 (UsnScanner)
	 *    - 前置条件：hasNativeSupport (必须) + Admin (推荐) + NTFS (必须)
	 *    - 如果检测失败或未集成，UsnScanner 会抛出异常
	 * 2. 降级使用递归扫描器 (RecursiveScanner)
	 *    - 场景：无原生插件、非 NTFS 分区、权限不足
	 *    - 特性：使用并发队列优化 SSD 读取性能
	 */
	async rebuild(explicitRoots?: string[]) {
		if (this.isIndexing) return;
		this.isIndexing = true;
		this.rebuildStartedAt = Date.now();
		this.partialPublished = false;
		this.lastYieldAt = Date.now();

		const existingCount = this.db ? await count(this.db) : 0;
		const publishIncrementally = existingCount <= 0;
		const nextDb = await create({ schema: SCHEMA, components: { tokenizer } as any });
		const nextPathToId = new Map<string, string>();
		const tmpPath = `${this.cachePath}.tmp`;
		await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
		const cacheWs = createWriteStream(tmpPath, { encoding: 'utf-8' });
		
		let entryCount = 0;
		const batch: FileIndexEntry[] = [];
		const BATCH_SIZE = 2000;
        let processedSinceYield = 0;

		const flushBatch = async () => {
			if (batch.length === 0) return;
			const toWrite = batch.slice();
			batch.length = 0; // 立即清空，避免并发添加导致的重复或遗漏

			const docs = toWrite.map((e) => {
				const ext = e.ext || path.extname(e.name).toLowerCase();
				return {
					path: e.path,
					name: e.name,
					pinyin: e.pinyin || toPinyinFull(e.name),
					initials: e.initials || toPinyinInitials(e.name),
					pathText: this.buildPathText(e.path),
					isDirectory: e.isDirectory,
					kind: e.kind || classifyKind(e.isDirectory, ext),
					ext,
					drive: e.drive || normalizeDrive(e.path),
				};
			});
			const ids = await insertMultiple(nextDb, docs);
			for (let i = 0; i < docs.length; i++) {
				const p = docs[i]?.path;
				const id = (ids as any)[i];
				if (typeof p === 'string' && p && typeof id === 'string' && id) nextPathToId.set(p.toLowerCase(), id);
			}

			// 写入缓存时处理背压：大索引构建时避免 write 堆积导致内存抖动
			const lines = toWrite.map((e) => `${JSON.stringify({ p: e.path, d: e.isDirectory ? 1 : 0 })}\n`).join('');
			if (!cacheWs.write(lines)) {
				await new Promise<void>((resolve) => cacheWs.once('drain', () => resolve()));
			}
		};

		const maybePublishPartial = () => {
			if (!publishIncrementally) return;
			if (this.partialPublished) return;
			if (Date.now() - this.rebuildStartedAt < 2500) return;
			if (nextPathToId.size <= 0) return;
			this.db = nextDb;
			this.pathToId = nextPathToId;
			this.partialPublished = true;
		};

		if (publishIncrementally) {
			this.db = nextDb;
			this.pathToId = nextPathToId;
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
			
			batch.push(entry);
			entryCount++;
		};

        // 确定扫描根目录
		let roots = explicitRoots;
        if (!roots || roots.length === 0) {
            try {
                const info = await SystemDetector.getInstance().detect();
                // 优先扫描所有检测到的固定磁盘
                roots = info.drives.map(d => d.mountPoint + '\\');
            } catch {
                // 兜底：仅扫描 C 盘
                roots = ['C:\\'];
            }
        }

        // 策略选择：尝试 USN -> 降级 Recursive
        // 即使是 USN 模式，也可能因为部分盘符不支持而抛出异常，此时降级为全量递归
        
        try {
            // 尝试使用 USN 扫描器
            // UsnScanner 内部会检测 hasNativeSupport，若不支持会抛出异常
            const usnScanner = new UsnScanner(this.isIgnoredPath.bind(this));
            await usnScanner.scan(roots, addNext, () => entryCount >= this.maxEntries);
        } catch (e) {
            // 降级策略：使用递归扫描器
            // 场景：无原生插件、非 NTFS、权限不足、或 USN 扫描失败
            const recursiveScanner = new RecursiveScanner(this.isIgnoredPath.bind(this));
            
            // 包装进度回调以处理协作式让步 (Cooperative Yield)
            // 避免主线程或 Worker 线程长时间阻塞
            const wrappedProgress = async (entry: FileIndexEntry) => {
                addNext(entry);
                processedSinceYield++;
                if (processedSinceYield % 250 === 0) {
                     if (batch.length >= BATCH_SIZE) await flushBatch();
                     await this.cooperativeYield(maybePublishPartial);
                }
            };
            
            await recursiveScanner.scan(roots, wrappedProgress, () => entryCount >= this.maxEntries);
        }

		try {
			// 刷新剩余数据并完成构建
			await flushBatch();
			await new Promise<void>((resolve) => {
				cacheWs.on('finish', () => resolve());
				cacheWs.end();
			});
			await fs.rename(tmpPath, this.cachePath).catch(async () => {
				await fs.copyFile(tmpPath, this.cachePath);
				await fs.unlink(tmpPath);
			});

			this.db = nextDb;
			this.pathToId = nextPathToId;
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
	): Promise<{ results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number }> {
		const db = await this.ensureDB();
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { results: [], isIndexing: this.isIndexing, totalCount: 0 };

		// 允许用户粘贴一整段文本：这里先提取 token 再组合为搜索词
		const tokens = this.extractSearchTokens(queryLower);
		const normalizedTerm = tokens.length > 0 ? tokens.join(' ') : queryLower;

		const doSearch = async (term: string, l: number) => {
			return await search(db, {
				term,
				// 搜索字段：支持“目录 + 文件名 + 扩展名”组合检索
				properties: ['name', 'pinyin', 'initials', 'pathText'],
				limit: l,
				threshold: 1,
				boost: { name: 2, pinyin: 1.4, initials: 1.2, pathText: 1.35 },
				where: options?.where,
			});
		};

		const searchResult = await doSearch(normalizedTerm, limit * 2);

		// 如果“整句搜索”没有命中且 token 较多，则降级为“按 token 合并”
		const hitsRaw = (searchResult as any).hits || [];
		let mergedHits = hitsRaw;
		if (mergedHits.length === 0 && tokens.length >= 2) {
			const merged = new Map<string, { doc: any; scoreSum: number; hitCount: number }>();
			const tokenList = tokens.slice(0, 6);
			for (const t of tokenList) {
				const r = await doSearch(t, Math.max(limit, 120));
				for (const hit of (r as any).hits || []) {
					const p = hit?.document?.path as string;
					if (!p) continue;
					const key = p.toLowerCase();
					const prev = merged.get(key);
					const score = typeof hit?.score === 'number' ? hit.score : 0;
					if (prev) {
						prev.scoreSum += score;
						prev.hitCount += 1;
					} else {
						merged.set(key, { doc: hit.document, scoreSum: score, hitCount: 1 });
					}
				}
			}
			mergedHits = Array.from(merged.values())
				.map((x) => ({
					document: x.doc,
					// 命中多个 token 的结果优先：在累计分数上做轻微加成
					score: x.scoreSum + x.hitCount * 0.15,
				}))
				.sort((a, b) => (b.score || 0) - (a.score || 0))
				.slice(0, limit * 2);
		}

		const results: FileIndexSearchResult[] = [];
		for (const hit of mergedHits || []) {
			const doc = hit.document;
			const score = hit.score;
			const p = doc?.path as string;
			if (!p || this.isIgnoredPath(p)) continue;

			results.push({
				path: p,
				name: (doc?.name as string) || '',
				isDirectory: Boolean(doc?.isDirectory),
				score: (typeof score === 'number' ? score : 0) * 1000,
			});
			if (results.length >= limit) break;
		}

		// totalCount 在“按 token 合并”模式下不再可信，这里以实际结果数量作为兜底
		const totalCount = typeof (searchResult as any).count === 'number' ? (searchResult as any).count : results.length;
		return { results, isIndexing: this.isIndexing, totalCount };
	}

	async countMatches(query: string, options?: { where?: any }) {
		const db = await this.ensureDB();
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { totalCount: 0, isIndexing: this.isIndexing };
		const resp = await search(db, {
			term: queryLower,
			// 计数逻辑与 search 对齐，否则会出现“结果能搜到但 totalCount 不一致”
			properties: ['name', 'pinyin', 'initials', 'pathText'],
			where: options?.where,
			preflight: true,
		});
		return { totalCount: (resp as any).count || 0, isIndexing: this.isIndexing };
	}
}
