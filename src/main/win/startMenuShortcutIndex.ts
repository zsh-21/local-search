import { app } from 'electron';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';

const startMenuShortcutIndex = new Map<string, string>();
let startMenuShortcutIndexReady = false;
let startMenuShortcutIndexInitPromise: Promise<void> | null = null;

function buildStartMenuShortcutIndex() {
	if (process.platform !== 'win32') return;
	const roots = [
		process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
		process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
		app.getPath('desktop'),
		process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : '',
	].filter((p) => p && existsSync(p));

	const walk = (dir: string) => {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
				continue;
			}
			if (!ent.isFile()) continue;
			if (!ent.name.toLowerCase().endsWith('.lnk')) continue;
			const key = path.basename(ent.name, '.lnk').toLowerCase();
			if (!startMenuShortcutIndex.has(key)) startMenuShortcutIndex.set(key, full);
		}
	};

	for (const r of roots) walk(r);
	startMenuShortcutIndexReady = true;
}

export function ensureStartMenuShortcutIndex() {
	if (process.platform !== 'win32') return Promise.resolve();
	if (startMenuShortcutIndexReady) return Promise.resolve();
	if (startMenuShortcutIndexInitPromise) return startMenuShortcutIndexInitPromise;
	startMenuShortcutIndexInitPromise = Promise.resolve()
		.then(() => {
			if (!startMenuShortcutIndexReady) buildStartMenuShortcutIndex();
		})
		.finally(() => {
			startMenuShortcutIndexInitPromise = null;
		});
	return startMenuShortcutIndexInitPromise;
}

export function findStartMenuShortcutByName(name: string) {
	const n = (name || '').trim().toLowerCase();
	if (!n) return '';
	const exact = startMenuShortcutIndex.get(n);
	if (exact) return exact;
	const normalize = (s: string) => s.replace(/（.*?）|\(.*?\)|【.*?】|\[.*?\]/g, ' ').replace(/[\s._\-+\\/]+/g, '').trim();
	const nn = normalize(n);
	let best = '';
	let bestScore = -1;
	for (const [k, v] of startMenuShortcutIndex.entries()) {
		const kk = normalize(k);
		let score = -1;
		if (k === n) score = 1000;
		else if (kk && nn && kk === nn) score = 950;
		else if (k.startsWith(n) || kk.startsWith(nn)) score = 800;
		else if (k.includes(n) || n.includes(k) || (kk && nn && (kk.includes(nn) || nn.includes(kk)))) score = 600;
		else {
			const parts = n.split(/\s+/).filter(Boolean);
			if (parts.length > 0 && parts.every((p) => k.includes(p))) score = 420 + parts.length * 20;
		}
		if (score > bestScore) {
			bestScore = score;
			best = v;
		}
	}
	return bestScore > 0 ? best : '';
}

