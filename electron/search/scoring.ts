import { hasChineseChar, toPinyinFull, toPinyinInitials } from '../pinyin';

export function createNameScorer(query: string) {
	const lowerQuery = String(query || '').trim().toLowerCase();
	const queryParts = lowerQuery.split(/\s+/).filter(Boolean);
	const normalizeForMatchName = (name: string) => String(name || '').replace(/\.(exe|lnk)$/i, '').toLowerCase();
	const tokenizeForScore = (q: string) => q.split(/[\s._\-+\\/]+/).filter(Boolean);
	const scoreTokens = tokenizeForScore(lowerQuery);

	const countOccurrences = (hay: string, needle: string) => {
		if (!needle) return 0;
		let idx = 0;
		let count = 0;
		while (idx < hay.length) {
			const i = hay.indexOf(needle, idx);
			if (i < 0) break;
			count += 1;
			idx = i + Math.max(1, needle.length);
		}
		return count;
	};

	const fuzzySubsequenceScore = (target: string, q: string) => {
		let t = 0;
		let i = 0;
		let score = 0;
		let streak = 0;
		while (t < target.length && i < q.length) {
			if (target[t] === q[i]) {
				streak += 1;
				score += 3 + Math.min(streak, 10);
				i += 1;
			} else {
				streak = 0;
			}
			t += 1;
		}
		return i === q.length ? score : -1;
	};

	const computeWeightedNameMatch = (rawName: string) => {
		const nameLower = normalizeForMatchName(rawName);
		if (!nameLower) return { weightedScore: 0, matchIndex: 1_000_000, nameLen: 0 };
		const noExt = nameLower.replace(/\.[^./\\]+$/, '');
		const candidates = noExt && noExt !== nameLower ? [nameLower, noExt] : [nameLower];
		const isAsciiQuery = /^[a-z0-9\s._\-+\\/]+$/.test(lowerQuery);
		if (isAsciiQuery && hasChineseChar(rawName)) {
			const py = toPinyinFull(rawName);
			const ini = toPinyinInitials(rawName);
			if (py) candidates.push(py);
			if (ini) candidates.push(ini);
		}

		const scoreOne = (target: string) => {
			let score = 0;
			if (target === lowerQuery) score += 100;
			if (target.startsWith(lowerQuery)) score += 80;
			if (target.endsWith(lowerQuery)) score += 60;
			if (target.includes(lowerQuery)) score += 40;

			const matchedTokens = scoreTokens.filter((t) => t && target.includes(t));
			if (scoreTokens.length > 0 && matchedTokens.length === scoreTokens.length) score += 20;
			else if (matchedTokens.length > 0) score += 10;

			const occFull = countOccurrences(target, lowerQuery);
			let occTokens = 0;
			for (const t of matchedTokens) occTokens += countOccurrences(target, t);
			score += Math.min(40, (occFull + occTokens) * 2);

			const idxFull = target.indexOf(lowerQuery);
			let bestIdx = idxFull >= 0 ? idxFull : 1_000_000;
			for (const t of matchedTokens) {
				const i = target.indexOf(t);
				if (i >= 0 && i < bestIdx) bestIdx = i;
			}

			return { weightedScore: score, matchIndex: bestIdx, nameLen: target.length };
		};

		let best = scoreOne(candidates[0]);
		for (let i = 1; i < candidates.length; i++) {
			const cur = scoreOne(candidates[i]);
			if (cur.weightedScore > best.weightedScore) best = cur;
			else if (cur.weightedScore === best.weightedScore) {
				if (cur.matchIndex < best.matchIndex) best = cur;
				else if (cur.matchIndex === best.matchIndex && cur.nameLen < best.nameLen) best = cur;
			}
		}
		return best;
	};

	const scoreRecentName = (name: string) => {
		const base = normalizeForMatchName(name);
		if (!base) return 0;
		if (queryParts.length > 0 && !queryParts.every((p) => base.includes(p))) return 0;
		let score = 0;
		score += queryParts.length * 500;
		if (base === lowerQuery) score += 2000;
		if (base.startsWith(lowerQuery)) score += 1200;
		if (base.includes(lowerQuery)) score += 900;
		const subseq = fuzzySubsequenceScore(base, lowerQuery);
		if (subseq > 0) score += subseq;
		return score;
	};

	return { lowerQuery, queryParts, computeWeightedNameMatch, scoreRecentName };
}

export function createScoreComputer(input: {
	now: number;
	historyStats: any;
	normalizeHistoryKey: (rawPath: string) => string;
	normalizeExtKey: (rawPath: string) => string;
}) {
	const { now, historyStats, normalizeHistoryKey, normalizeExtKey } = input;

	const getLastUsedMs = (rawPath: string) => {
		const key = normalizeHistoryKey(rawPath);
		if (!key) return 0;
		const it = historyStats.byPath[key];
		const lastUsed = typeof it?.lastUsed === 'number' && it.lastUsed > 0 ? it.lastUsed : 0;
		return lastUsed;
	};

	const getAccessBoost = (rawPath: string) => {
		const key = normalizeHistoryKey(rawPath);
		if (!key) return 0;
		const it = historyStats.byPath[key];
		if (!it) return 0;
		const count = typeof it.count === 'number' && it.count > 0 ? it.count : 0;
		const lastUsed = typeof it.lastUsed === 'number' && it.lastUsed > 0 ? it.lastUsed : 0;
		const countBoost = Math.min(18_000, count * 1_600);
		const ageDays = lastUsed ? (now - lastUsed) / 86_400_000 : 9999;
		const recBoost = ageDays <= 30 ? Math.round(7_000 * (1 - ageDays / 30)) : 0;
		return countBoost + recBoost;
	};

	const getTypeBoost = (type: string, rawPath: string) => {
		if (type === 'file') {
			const ext = normalizeExtKey(rawPath);
			if (!ext) return 0;
			const cnt = typeof historyStats.byExt[ext] === 'number' ? historyStats.byExt[ext] : 0;
			return Math.min(7_000, cnt * 260);
		}
		const cnt = typeof historyStats.byType[type] === 'number' ? historyStats.byType[type] : 0;
		return Math.min(5_000, cnt * 180);
	};

	const getTimeBoost = (timeMs: number) => {
		if (!timeMs || !Number.isFinite(timeMs)) return 0;
		const ageDays = (now - timeMs) / 86_400_000;
		if (ageDays <= 0) return 1_200;
		if (ageDays <= 7) return Math.round(1_200 * (1 - ageDays / 7));
		if (ageDays <= 30) return Math.round(350 * (1 - ageDays / 30));
		return 0;
	};

	const computeCombinedScore = (baseScore: number, type: string, rawPath: string, timeMs: number) => {
		const nameScore = baseScore;
		const accessBoost = getAccessBoost(rawPath);
		const typeBoost = getTypeBoost(type, rawPath);
		const timeBoost = getTimeBoost(timeMs);
		return nameScore * 1_000_000 + accessBoost * 1_000 + typeBoost * 10 + timeBoost;
	};

	return { getLastUsedMs, computeCombinedScore };
}

