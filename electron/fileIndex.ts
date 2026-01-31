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
	const fullPathLower = entry.path.toLowerCase();

	let score = 0;

	// Check if all query parts are present in the name or path
	const allPartsMatch = queryParts.every(part => base.includes(part) || fullPathLower.includes(part));
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
	if (lower === 'windows') return true;
	if (lower === 'program files') return true;
	if (lower === 'program files (x86)') return true;
	if (lower === 'programdata') return true;
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

	private addEntry(entry: FileIndexEntry) {
		if (this.entries.length >= this.maxEntries) return;
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

		const nextEntries: FileIndexEntry[] = [];
		const nextBuckets = new Map<string, number[]>();
		const addNext = (entry: FileIndexEntry) => {
			if (nextEntries.length >= this.maxEntries) return;
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
				while (queue.length > 0 && nextEntries.length < this.maxEntries) {
					const current = queue.shift();
					if (!current) break;

					let dir;
					try {
						dir = await fs.opendir(current);
					} catch {
						continue;
					}

					for await (const dirent of dir) {
						if (nextEntries.length >= this.maxEntries) break;
						if (dirent.isSymbolicLink()) continue;

						const fullPath = path.join(current, dirent.name);
						if (dirent.isDirectory()) {
							if (shouldSkipDirName(dirent.name)) continue;
							addNext({ path: fullPath, name: dirent.name, isDirectory: true });
							queue.push(fullPath);
						} else {
							addNext({ path: fullPath, name: dirent.name, isDirectory: false });
						}
					}
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
			this.pathSet = new Set(nextEntries.map((e) => e.path));
		} finally {
			this.isIndexing = false;
		}
	}

	search(query: string, limit = 20): { results: FileIndexSearchResult[]; isIndexing: boolean } {
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { results: [], isIndexing: this.isIndexing };

		const queryParts = queryLower.split(/\s+/).filter(Boolean);
		const scored: FileIndexSearchResult[] = [];

		// Full scan for better partial matching support
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			const score = scoreEntry(entry, queryLower, queryParts);
			if (score <= 0) continue;
			scored.push({ ...entry, score });
			
			// If we have too many candidates, we might want to stop early or just keep going
			// For 750k entries, a full scan is usually < 50ms
		}

		scored.sort((a, b) => b.score - a.score);
		return { results: scored.slice(0, limit), isIndexing: this.isIndexing };
	}
}
