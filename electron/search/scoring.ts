import { hasChineseChar, toPinyinFull, toPinyinInitials } from '../pinyin';

export function createNameScorer(query: string) {
	const lowerQuery = String(query || '').trim().toLowerCase();
	const queryParts = lowerQuery.split(/[\s._\-+\\/]+/).filter(Boolean);
	const normalizeForMatchName = (name: string) => String(name || '').replace(/\.(exe|lnk)$/i, '').toLowerCase();
	const normalizeCompact = (name: string) => String(name || '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
	const tokenizeForScore = (q: string) => q.split(/[\s._\-+\\/]+/).filter(Boolean);
	const scoreTokens = tokenizeForScore(lowerQuery);
	const compactQuery = normalizeCompact(lowerQuery);

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
		const candidates: Array<{ text: string; source: 'direct' | 'pinyin' | 'initials' }> =
			noExt && noExt !== nameLower
				? [{ text: nameLower, source: 'direct' }, { text: noExt, source: 'direct' }]
				: [{ text: nameLower, source: 'direct' }];
		const isAsciiQuery = /^[a-z0-9\s._\-+\\/]+$/.test(lowerQuery);
		if (isAsciiQuery && hasChineseChar(rawName)) {
			const py = toPinyinFull(rawName);
			const ini = toPinyinInitials(rawName);
			if (py) candidates.push({ text: py, source: 'pinyin' });
			if (ini) candidates.push({ text: ini, source: 'initials' });
		}

		const scoreOne = (target: string, source: 'direct' | 'pinyin' | 'initials') => {
			if (!target) return { weightedScore: 0, matchIndex: 1_000_000, nameLen: 0 };
			const compactTarget = normalizeCompact(target);
			const rawExact = target === lowerQuery;
			const compactExact = !!compactQuery && compactTarget === compactQuery;
			const rawStarts = !!lowerQuery && target.startsWith(lowerQuery);
			const compactStarts = !!compactQuery && compactTarget.startsWith(compactQuery);
			const rawContains = !!lowerQuery && target.includes(lowerQuery);
			const compactContains = !!compactQuery && compactTarget.includes(compactQuery);
			const sourcePenalty = source === 'direct' ? 0 : source === 'initials' ? 80 : 130;
			let matchTier = 9;
			if (rawExact) matchTier = source === 'direct' ? 0 : 1;
			else if (compactExact) matchTier = source === 'direct' ? 1 : 2;
			else if (rawStarts || compactStarts) matchTier = source === 'direct' ? 2 : 3;
			else if (rawContains || compactContains) matchTier = source === 'direct' ? 4 : 5;
			else {
				const subseq = fuzzySubsequenceScore(compactTarget || target, compactQuery || lowerQuery);
				if (subseq > 0) matchTier = 6;
			}
			if (matchTier >= 9) return { weightedScore: 0, matchIndex: 1_000_000, nameLen: target.length };

			let score = 12_000 - matchTier * 1_700 - sourcePenalty;
			if (rawExact) score += 700;
			if (compactExact) score += 520;
			if (rawStarts || compactStarts) score += 360;
			if (rawContains || compactContains) score += 180;
			const matchedTokens = scoreTokens.filter((t) => t && target.includes(t));
			if (scoreTokens.length > 0 && matchedTokens.length === scoreTokens.length) score += 80;
			else if (matchedTokens.length > 0) score += 35;

			const occFull = countOccurrences(target, lowerQuery);
			let occTokens = 0;
			for (const t of matchedTokens) occTokens += countOccurrences(target, t);
			const occCompact = compactQuery ? countOccurrences(compactTarget, compactQuery) : 0;
			score += Math.min(180, (occFull + occTokens + occCompact) * 7);

			const idxFull = target.indexOf(lowerQuery);
			let bestIdx = idxFull >= 0 ? idxFull : 1_000_000;
			for (const t of matchedTokens) {
				const i = target.indexOf(t);
				if (i >= 0 && i < bestIdx) bestIdx = i;
			}
			if (bestIdx >= 1_000_000 && compactQuery) {
				const ci = compactTarget.indexOf(compactQuery);
				if (ci >= 0) bestIdx = ci * 2;
			}

			return { weightedScore: score, matchIndex: bestIdx, nameLen: target.length };
		};

		let best = scoreOne(candidates[0].text, candidates[0].source);
		for (let i = 1; i < candidates.length; i++) {
			const cur = scoreOne(candidates[i].text, candidates[i].source);
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
		const compactBase = normalizeCompact(base);
		if (queryParts.length > 0 && !queryParts.every((p) => base.includes(p) || compactBase.includes(normalizeCompact(p)))) return 0;
		let score = 0;
		score += queryParts.length * 500;
		if (base === lowerQuery) score += 2400;
		if (compactQuery && compactBase === compactQuery) score += 2100;
		if (base.startsWith(lowerQuery)) score += 1300;
		if (compactQuery && compactBase.startsWith(compactQuery)) score += 1050;
		if (base.includes(lowerQuery)) score += 920;
		if (compactQuery && compactBase.includes(compactQuery)) score += 760;
		const subseq = fuzzySubsequenceScore(compactBase || base, compactQuery || lowerQuery);
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

