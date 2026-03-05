import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { create, insert, insertMultiple, search, count, remove, type Orama } from '@orama/orama';
import { toPinyinFull, toPinyinInitials } from './pinyin';

export interface FileIndexEntry {
	path: string;
	name: string;
	isDirectory: boolean;
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
		const MAX_TOKENS = 12;
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
			if (seg.length <= 4) {
				for (let i = 0; i < seg.length; i++) push(seg[i]);
			}
		}

		return out;
	},
};

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v']);
const SHORTCUT_EXTENSIONS = new Set(['.lnk', '.url']);

function classifyKind(isDirectory: boolean, ext: string) {
	if (isDirectory) return 'folder';
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (VIDEO_EXTENSIONS.has(ext)) return 'video';
	return 'file';
}

function shouldIndexFile(isDirectory: boolean, ext: string) {
	// 快捷方式不参与索引与搜索结果：避免出现 .lnk/.url，且避免“快捷方式与真实文件”重复指向同一路径
	if (isDirectory) return true;
	return !SHORTCUT_EXTENSIONS.has(ext);
}

function normalizeDrive(p: string) {
	const raw = typeof p === 'string' ? p.trim() : '';
	const m = raw.match(/^([a-zA-Z]):/);
	return m ? m[1].toLowerCase() : '';
}

function shouldSkipDirName(name: string) {
	const lower = name.toLowerCase();
	if (lower === 'node_modules') return true;
	if (lower === '.git') return true;
	if (lower === '.svn') return true;
	if (lower === '.idea') return true;
	if (lower === '$recycle.bin') return true;
	if (lower === 'system volume information') return true;
	// Allow Program Files and ProgramData as users might want to search for apps/files there
	return false;
}

async function getWindowsFileSystemRoots(): Promise<string[]> {
	return new Promise((resolve) => {
		const ps = spawn('powershell', [
			'-NoProfile',
			'-Command',
			'Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root',
		]);
		let out = '';
		ps.stdout.on('data', (d) => (out += d.toString()));
		ps.on('close', () => {
			const roots = out
				.split(/\r?\n/g)
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => (s.endsWith('\\') ? s : `${s}\\`));
			resolve(Array.from(new Set(roots)));
		});
		ps.on('error', () => resolve(['C:\\']));
	});
}

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
		// clear:cache 等“强制清理”场景必须彻底复位索引状态：
		// 否则 isIndexing 可能保持为 true，导致后续 buildIfEmpty()/rebuild() 直接 return，表现为“面板一直没有结果”
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
		// 搜索窗口可见时降低索引优先级：让索引构建“默默”在后台进行，避免用户操作时感知卡顿
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

	async ingestPath(entryPath: string, isDirectory: boolean) {
		if (!entryPath) return;
		const db = await this.ensureDB();
		if (this.pathToId.has(entryPath)) return;
		// Check ignore path
		if (this.isIgnoredPath(entryPath)) return;

		const name = path.basename(entryPath);
		const ext = path.extname(name).toLowerCase();
		if (!shouldIndexFile(isDirectory, ext)) return;
		const kind = classifyKind(isDirectory, ext);
		const drive = normalizeDrive(entryPath);
		const pinyinFull = toPinyinFull(name);
		const initials = toPinyinInitials(name);
		const id = await insert(db, {
			path: entryPath,
			name,
			pinyin: pinyinFull,
			initials,
			isDirectory,
			kind,
			ext,
			drive,
		});
		if (typeof id === 'string' && id) this.pathToId.set(entryPath, id);
	}

	async removePath(entryPath: string) {
		if (!entryPath) return;
		const id = this.pathToId.get(entryPath);
		if (!id) return;
		const db = await this.ensureDB();
		try {
			await remove(db, id);
		} catch {}
		this.pathToId.delete(entryPath);
	}

	async loadCache(): Promise<boolean> {
		if (!existsSync(this.cachePath)) return false;

		// Initialize DB
		// 读取缓存期间也视为“索引进行中”：这样搜索时的 pauseIndexingFor() 能让加载任务让出时间片
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
					isDirectory: e.isDirectory,
					kind: e.kind,
					ext: e.ext,
				}));
				const ids = await insertMultiple(this.db, docs);
				for (let i = 0; i < docs.length; i++) {
					const p = docs[i]?.path;
					const id = (ids as any)[i];
					if (typeof p === 'string' && p && typeof id === 'string' && id) this.pathToId.set(p, id);
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
				if (this.pathToId.has(p)) continue;
				// 快捷方式不参与索引与搜索：加载历史缓存时也过滤掉，避免旧缓存导致仍出现 .lnk/.url
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
			// If load fails, ensure we have a valid empty db
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

	async rebuild() {
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

		const flushBatch = async () => {
			if (batch.length === 0) return;
			const toWrite = batch.slice();
			const docs = batch.map((e) => {
				const ext = path.extname(e.name).toLowerCase();
				return {
					path: e.path,
					name: e.name,
					pinyin: toPinyinFull(e.name),
					initials: toPinyinInitials(e.name),
					isDirectory: e.isDirectory,
					kind: classifyKind(e.isDirectory, ext),
					ext,
					drive: normalizeDrive(e.path),
				};
			});
			const ids = await insertMultiple(nextDb, docs);
			for (let i = 0; i < docs.length; i++) {
				const p = docs[i]?.path;
				const id = (ids as any)[i];
				if (typeof p === 'string' && p && typeof id === 'string' && id) nextPathToId.set(p, id);
			}
			for (const e of toWrite) {
				cacheWs.write(`${JSON.stringify({ p: e.path, d: e.isDirectory ? 1 : 0 })}\n`);
			}
			batch.length = 0;
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
			if (nextPathToId.has(entry.path)) return;
			// 快捷方式不参与索引：避免 .lnk/.url 出现在搜索结果里
			if (!entry.isDirectory) {
				const ext = path.extname(entry.name).toLowerCase();
				if (!shouldIndexFile(false, ext)) return;
			}
			
			batch.push(entry);
			entryCount++;
		};

		const roots = await getWindowsFileSystemRoots();

		try {
			for (const root of roots) {
				const queue: string[] = [root];
				let q = 0;
				while (q < queue.length && entryCount < this.maxEntries) {
					const current = queue[q++];
					if (!current) break;
					if (this.isIgnoredPath(current)) continue;

					let dir;
					try {
						dir = await fs.opendir(current);
					} catch {
						continue;
					}

					let processedInDir = 0;
					for await (const dirent of dir) {
						if (entryCount >= this.maxEntries) break;
						if (dirent.isSymbolicLink()) continue;

						const fullPath = path.join(current, dirent.name);
						if (this.isIgnoredPath(fullPath)) continue;
						if (dirent.isDirectory()) {
							if (shouldSkipDirName(dirent.name)) continue;
							addNext({ path: fullPath, name: dirent.name, isDirectory: true });
							queue.push(fullPath);
						} else {
							addNext({ path: fullPath, name: dirent.name, isDirectory: false });
						}

						processedInDir += 1;
						if (processedInDir % 250 === 0) {
							if (batch.length >= BATCH_SIZE) await flushBatch();
							await this.cooperativeYield(maybePublishPartial);
						}
					}
                    
                    if (batch.length >= BATCH_SIZE) await flushBatch();
					await this.cooperativeYield(maybePublishPartial);
				}
			}

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

		const searchResult = await search(db, {
			term: queryLower,
			properties: ['name', 'pinyin', 'initials'],
			limit: limit * 2,
			threshold: 1,
			boost: { name: 2, pinyin: 1.4, initials: 1.2 },
			where: options?.where,
		});

		const results: FileIndexSearchResult[] = [];
		for (const hit of (searchResult as any).hits || []) {
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

		return { results, isIndexing: this.isIndexing, totalCount: (searchResult as any).count || 0 };
	}

	async countMatches(query: string, options?: { where?: any }) {
		const db = await this.ensureDB();
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { totalCount: 0, isIndexing: this.isIndexing };
		const resp = await search(db, {
			term: queryLower,
			properties: ['name'],
			where: options?.where,
			preflight: true,
		});
		return { totalCount: (resp as any).count || 0, isIndexing: this.isIndexing };
	}
}
