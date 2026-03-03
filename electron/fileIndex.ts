import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

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

function normalizeForMatch(name: string) {
	return name.replace(/\.(exe|lnk)$/i, '').toLowerCase();
}

function bucketKey2(s: string) {
	const norm = normalizeForMatch(s);
	return norm.length >= 2 ? norm.slice(0, 2) : norm;
}

function fuzzySubsequenceScore(target: string, query: string) {
	let t = 0;
	let q = 0;
	let score = 0;
	let streak = 0;

	while (t < target.length && q < query.length) {
		if (target[t] === query[q]) {
			streak += 1;
			score += 3 + Math.min(streak, 10);
			q += 1;
		} else {
			streak = 0;
		}
		t += 1;
	}

	return q === query.length ? score : -1;
}

function scoreEntry(entry: FileIndexEntry, queryLower: string, queryParts: string[]) {
	const base = normalizeForMatch(entry.name);

	let score = 0;

	const allPartsMatch = queryParts.every((part) => base.includes(part));
	if (!allPartsMatch) return 0;

	// Higher score for matches in the name
	const namePartsMatchCount = queryParts.filter(part => base.includes(part)).length;
	score += namePartsMatchCount * 500;

	if (base === queryLower) score += 2000;
	if (base.startsWith(queryLower)) score += 1200;
	if (base.includes(queryLower)) score += 900;
	
	const subseq = fuzzySubsequenceScore(base, queryLower);
	if (subseq > 0) score += subseq;

	const ext = path.extname(entry.name).toLowerCase();
	if (ext === '.exe' || ext === '.lnk') score += 120;
	if (entry.isDirectory) score -= 20;

	return score;
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
	private entries: FileIndexEntry[] = [];
	private buckets = new Map<string, number[]>();
	private pathSet = new Set<string>();
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

	getStatus(): FileIndexStatus {
		return {
			isIndexing: this.isIndexing,
			indexedCount: this.entries.length,
		};
	}

	setSearchWindowVisible(visible: boolean) {
		this.lowPriority = !visible;
		if (!visible) this.pauseUntil = 0;
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

	private addEntry(entry: FileIndexEntry) {
		if (this.entries.length >= this.maxEntries) return;
		if (this.isIgnoredPath(entry.path)) return;
		if (this.pathSet.has(entry.path)) return;
		const index = this.entries.length;
		this.entries.push(entry);
		this.pathSet.add(entry.path);
		const key = bucketKey2(entry.name);
		if (!key) return;
		const arr = this.buckets.get(key);
		if (arr) arr.push(index);
		else this.buckets.set(key, [index]);
	}

	ingestPath(entryPath: string, isDirectory: boolean) {
		if (!entryPath) return;
		this.addEntry({ path: entryPath, name: path.basename(entryPath), isDirectory });
	}

	async loadCache(): Promise<boolean> {
		if (!existsSync(this.cachePath)) return false;

		try {
			const stream = createReadStream(this.cachePath, { encoding: 'utf-8' });
			const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
			for await (const line of rl) {
				const p = line.trim();
				if (!p) continue;
				this.addEntry({
					path: p,
					name: path.basename(p),
					isDirectory: false,
				});
				if (this.entries.length >= this.maxEntries) break;
			}
			return this.entries.length > 0;
		} catch {
			return false;
		}
	}

	async buildIfEmpty() {
		if (this.entries.length > 0) return;
		await this.rebuild();
	}

	async rebuild() {
		if (this.isIndexing) return;
		this.isIndexing = true;
		this.rebuildStartedAt = Date.now();
		this.partialPublished = false;
		this.lastYieldAt = Date.now();

		const nextEntries: FileIndexEntry[] = [];
		const nextBuckets = new Map<string, number[]>();
		const nextPathSet = new Set<string>();
		const maybePublishPartial = () => {
			if (this.partialPublished) return;
			if (Date.now() - this.rebuildStartedAt < 3000) return;
			if (nextEntries.length <= 0) return;
			this.entries = nextEntries;
			this.buckets = nextBuckets;
			this.pathSet = nextPathSet;
			this.partialPublished = true;
		};
		const addNext = (entry: FileIndexEntry) => {
			if (nextEntries.length >= this.maxEntries) return;
			if (this.isIgnoredPath(entry.path)) return;
			if (nextPathSet.has(entry.path)) return;
			nextPathSet.add(entry.path);
			const idx = nextEntries.length;
			nextEntries.push(entry);
			const key = bucketKey2(entry.name);
			if (!key) return;
			const arr = nextBuckets.get(key);
			if (arr) arr.push(idx);
			else nextBuckets.set(key, [idx]);
		};

		const roots = await getWindowsFileSystemRoots();

		try {
			for (const root of roots) {
				const queue: string[] = [root];
				let q = 0;
				while (q < queue.length && nextEntries.length < this.maxEntries) {
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
						if (nextEntries.length >= this.maxEntries) break;
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
							await this.cooperativeYield(maybePublishPartial);
						}
					}

					await this.cooperativeYield(maybePublishPartial);
				}
			}

			const tmpPath = `${this.cachePath}.tmp`;
			await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
			await new Promise<void>((resolve, reject) => {
				const ws = createWriteStream(tmpPath, { encoding: 'utf-8' });
				ws.on('error', reject);
				ws.on('finish', () => resolve());
				for (const e of nextEntries) {
					ws.write(`${e.path}\n`);
				}
				ws.end();
			});
			await fs.rename(tmpPath, this.cachePath).catch(async () => {
				await fs.copyFile(tmpPath, this.cachePath);
				await fs.unlink(tmpPath);
			});

			this.entries = nextEntries;
			this.buckets = nextBuckets;
			this.pathSet = nextPathSet;
		} finally {
			this.isIndexing = false;
			this.pauseUntil = 0;
		}
	}

	search(query: string, limit = 100): { results: FileIndexSearchResult[]; isIndexing: boolean } {
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { results: [], isIndexing: this.isIndexing };

		const queryParts = queryLower.split(/\s+/).filter(Boolean);
		const heap: FileIndexSearchResult[] = [];

		const siftUp = (idx: number) => {
			while (idx > 0) {
				const p = Math.floor((idx - 1) / 2);
				if (heap[p].score <= heap[idx].score) break;
				[heap[p], heap[idx]] = [heap[idx], heap[p]];
				idx = p;
			}
		};
		const siftDown = (idx: number) => {
			for (;;) {
				const l = idx * 2 + 1;
				const r = l + 1;
				let s = idx;
				if (l < heap.length && heap[l].score < heap[s].score) s = l;
				if (r < heap.length && heap[r].score < heap[s].score) s = r;
				if (s === idx) break;
				[heap[s], heap[idx]] = [heap[idx], heap[s]];
				idx = s;
			}
		};
		const pushTop = (item: FileIndexSearchResult) => {
			if (limit <= 0) return;
			if (heap.length < limit) {
				heap.push(item);
				siftUp(heap.length - 1);
				return;
			}
			if (heap[0].score >= item.score) return;
			heap[0] = item;
			siftDown(0);
		};

		// Full scan for better partial matching support
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (this.isIgnoredPath(entry.path)) continue;
			const score = scoreEntry(entry, queryLower, queryParts);
			if (score <= 0) continue;
			pushTop({ ...entry, score });
		}

		heap.sort((a, b) => b.score - a.score);
		return { results: heap, isIndexing: this.isIndexing };
	}
}
