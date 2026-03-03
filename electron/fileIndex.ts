import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { create, insert, insertMultiple, search, count, type Orama, type Results } from '@orama/orama';

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
	path: 'string',
	isDirectory: 'boolean',
	ext: 'string',
} as const;

type FileDB = Orama<typeof SCHEMA>;

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

	async getStatus(): Promise<FileIndexStatus> {
		return {
			isIndexing: this.isIndexing,
			indexedCount: this.db ? await count(this.db) : 0,
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

	private async ensureDB() {
		if (!this.db) {
			this.db = await create({ schema: SCHEMA });
		}
		return this.db;
	}

	async ingestPath(entryPath: string, isDirectory: boolean) {
		if (!entryPath) return;
		const db = await this.ensureDB();
		if (this.pathSet.has(entryPath)) return;
		// Check ignore path
		if (this.isIgnoredPath(entryPath)) return;

		this.pathSet.add(entryPath);
		const name = path.basename(entryPath);
		const ext = path.extname(name).toLowerCase();
		await insert(db, {
			path: entryPath,
			name,
			isDirectory,
			ext,
		});
	}

	async loadCache(): Promise<boolean> {
		if (!existsSync(this.cachePath)) return false;

		// Initialize DB
		this.db = await create({ schema: SCHEMA });
		this.pathSet.clear();

		try {
			const stream = createReadStream(this.cachePath, { encoding: 'utf-8' });
			const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
			
			const batch: FileIndexEntry[] = [];
			const BATCH_SIZE = 5000;

			const processBatch = async () => {
				if (batch.length === 0) return;
				if (!this.db) return;
				await insertMultiple(this.db, batch.map(e => ({
					path: e.path,
					name: e.name,
					isDirectory: e.isDirectory,
					ext: path.extname(e.name).toLowerCase()
				})));
				batch.length = 0;
			};

			let count = 0;
			for await (const line of rl) {
				const p = line.trim();
				if (!p) continue;
				
				// Optimization: Don't check ignore path on loadCache, assume cache is clean or will be filtered on search
				// But we should check maxEntries
				if (count >= this.maxEntries) break;

				this.pathSet.add(p);
				batch.push({
					path: p,
					name: path.basename(p),
					isDirectory: false, // Cache currently doesn't store isDirectory, default to false. 
                    // Wait, old code defaulted to false too. 
                    // "isDirectory: false" in old loadCache (line 258)
				});
				count++;

				if (batch.length >= BATCH_SIZE) {
					await processBatch();
				}
			}
			await processBatch();
			
			return count > 0;
		} catch {
			// If load fails, ensure we have a valid empty db
			if (!this.db) this.db = await create({ schema: SCHEMA });
			return false;
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

		const nextDb = await create({ schema: SCHEMA });
		const nextPathSet = new Set<string>();
		
		let entryCount = 0;
		const batch: FileIndexEntry[] = [];
		const BATCH_SIZE = 2000;

		const flushBatch = async () => {
			if (batch.length === 0) return;
			await insertMultiple(nextDb, batch.map(e => ({
				path: e.path,
				name: e.name,
				isDirectory: e.isDirectory,
				ext: path.extname(e.name).toLowerCase()
			})));
			batch.length = 0;
		};

		const maybePublishPartial = () => {
			// We can't easily publish partial results with Orama by swapping DBs mid-stream without losing data or complexity.
			// So we skip partial publishing for now, or we could just update the live DB if we were doing incremental.
			// But rebuild implies fresh start. 
			// Users will see old results until rebuild finishes.
			// If this is acceptable, we just ignore partial publishing logic.
			// If we want partial updates, we could insert into `this.db` if it exists, but we are building `nextDb`.
			
			// If we want to support "search while indexing", we could potentially expose nextDb?
			// For simplicity and performance, let's just wait until finish or maybe swap in chunks?
			// Swapping in chunks is hard because Orama is a single instance.
			
			// Let's stick to "swap at the end" for atomic update.
			// But the UI shows "Indexing..." status.
			this.partialPublished = true;
		};

		const addNext = (entry: FileIndexEntry) => {
			if (entryCount >= this.maxEntries) return;
			if (this.isIgnoredPath(entry.path)) return;
			if (nextPathSet.has(entry.path)) return;
			nextPathSet.add(entry.path);
			
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

			// Save cache to disk
			const tmpPath = `${this.cachePath}.tmp`;
			await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
			
            // To save cache, we need to iterate all docs.
            // Orama search with limit: 0 doesn't return all docs easily without pagination.
            // But we have `nextPathSet`. We can just write that!
            // `nextPathSet` contains all paths we indexed.
            
			await new Promise<void>((resolve, reject) => {
				const ws = createWriteStream(tmpPath, { encoding: 'utf-8' });
				ws.on('error', reject);
				ws.on('finish', () => resolve());
				for (const p of nextPathSet) {
					ws.write(`${p}\n`);
				}
				ws.end();
			});
			await fs.rename(tmpPath, this.cachePath).catch(async () => {
				await fs.copyFile(tmpPath, this.cachePath);
				await fs.unlink(tmpPath);
			});

			this.db = nextDb;
			this.pathSet = nextPathSet;
		} finally {
			this.isIndexing = false;
			this.pauseUntil = 0;
		}
	}

	async search(
		query: string,
		limit = 100
	): Promise<{ results: FileIndexSearchResult[]; isIndexing: boolean; totalCount: number }> {
		const db = await this.ensureDB();
		const queryLower = query.trim().toLowerCase();
		if (!queryLower) return { results: [], isIndexing: this.isIndexing, totalCount: 0 };

        // Orama search
        // We use 'name' property for search
        const searchResult = await search(db, {
            term: queryLower,
            properties: ['name'], // Boost name matches
            limit: limit * 2, // Request more to allow for post-filtering
            threshold: 0.2, // Fuzzy threshold
            boost: {
                name: 2, // Boost name matches
            }
        });

        // Map results
        const results: FileIndexSearchResult[] = [];
        
        for (const hit of searchResult.hits) {
            const doc = hit.document;
            const score = hit.score;
            // Filter ignored paths
            if (this.isIgnoredPath(doc.path as string)) continue;

            results.push({
                path: doc.path as string,
                name: doc.name as string,
                isDirectory: doc.isDirectory as boolean,
                score: score * 1000 // Scale up score to match old range roughly (0-10 -> 0-10000)
            });
            
            if (results.length >= limit) break;
        }

		return { results, isIndexing: this.isIndexing, totalCount: searchResult.count };
	}
}
