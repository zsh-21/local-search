import { hasChineseChar, toPinyinFull, toPinyinInitials } from '../pinyin';

const NON_PATH_SYMBOL_RE = /[^\p{L}\p{N}\\/]+/gu;
const COMPACT_SYMBOL_RE = /[^\p{L}\p{N}]+/gu;
const COMPACT_SYMBOL_KEEP_PATH_RE = /[^\p{L}\p{N}\\/]+/gu;

function normalizeTextForSearch(input: string) {
	// 统一走 NFKC：把全角/半角、兼容字符等先折叠，再做小写比较，减少中英文混输偏差
	return String(input || '')
		.normalize('NFKC')
		.toLowerCase()
		.trim();
}

function tokenizeForScore(input: string) {
	// 除路径语义字符（/、\）外，其他符号都当分隔符，保证“UI-Ux”与“UI Ux”一致可检索
	const normalized = normalizeTextForSearch(input);
	if (!normalized) return [] as string[];
	return normalized
		.replace(NON_PATH_SYMBOL_RE, ' ')
		.split(/[\\/\s]+/)
		.map((x) => x.trim())
		.filter(Boolean);
}

function toCompactKey(input: string, keepPathSeparators: boolean) {
	const normalized = normalizeTextForSearch(input);
	if (!normalized) return '';
	return normalized.replace(keepPathSeparators ? COMPACT_SYMBOL_KEEP_PATH_RE : COMPACT_SYMBOL_RE, '');
}

function compactSubsequenceScore(target: string, query: string) {
	if (!target || !query) return -1;
	let t = 0;
	let q = 0;
	let score = 0;
	let streak = 0;
	while (t < target.length && q < query.length) {
		if (target[t] === query[q]) {
			streak += 1;
			score += 2 + Math.min(streak, 8);
			q += 1;
		} else {
			streak = 0;
			score -= 0.08;
		}
		t += 1;
	}
	if (q !== query.length) return -1;
	return Math.max(1, Math.round(score));
}

export function createNameScorer(query: string) {
	const lowerQuery = normalizeTextForSearch(query);
	const queryParts = tokenizeForScore(lowerQuery);
	const queryKeepPathSeparators = /[\\/]/.test(lowerQuery);
	const queryCompact = toCompactKey(lowerQuery, queryKeepPathSeparators);
	const normalizeForMatchName = (name: string) =>
		normalizeTextForSearch(String(name || '').replace(/\.(exe|lnk)$/i, ''));
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
		// 让归一化查询也能参与拼音候选比较，避免中英混合输入时拼音链路退化
		const hasLatinOrNumberQuery = /[a-z0-9]/.test(queryCompact);
		if (hasLatinOrNumberQuery && hasChineseChar(rawName)) {
			const py = normalizeTextForSearch(toPinyinFull(rawName));
			const ini = normalizeTextForSearch(toPinyinInitials(rawName));
			if (py) candidates.push(py);
			if (ini) candidates.push(ini);
		}

		const scoreOne = (target: string) => {
			let score = 0;
			const targetCompact = toCompactKey(target, queryKeepPathSeparators);
			if (target === lowerQuery) score += 100;
			if (target.startsWith(lowerQuery)) score += 80;
			if (target.endsWith(lowerQuery)) score += 60;
			if (target.includes(lowerQuery)) score += 40;
			if (queryCompact && targetCompact) {
				if (targetCompact === queryCompact) score += 90;
				if (targetCompact.startsWith(queryCompact)) score += 70;
				if (targetCompact.includes(queryCompact)) score += 56;
				const compactSubScore = compactSubsequenceScore(targetCompact, queryCompact);
				if (compactSubScore > 0) score += Math.min(48, compactSubScore);
			}

			const matchedTokens = scoreTokens.filter((t) => t && target.includes(t));
			if (scoreTokens.length > 0 && matchedTokens.length === scoreTokens.length) score += 20;
			else if (matchedTokens.length > 0) score += 10;

			const occFull = countOccurrences(target, lowerQuery);
			let occTokens = 0;
			for (const t of matchedTokens) occTokens += countOccurrences(target, t);
			score += Math.min(40, (occFull + occTokens) * 2);

			const idxFull = target.indexOf(lowerQuery);
			let bestIdx = idxFull >= 0 ? idxFull : 1_000_000;
			const idxCompact = queryCompact ? targetCompact.indexOf(queryCompact) : -1;
			if (idxCompact >= 0) bestIdx = Math.min(bestIdx, idxCompact);
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
		const baseCompact = toCompactKey(base, queryKeepPathSeparators);
		const compactSubScore = compactSubsequenceScore(baseCompact, queryCompact);
		if (queryParts.length > 0 && !queryParts.every((p) => base.includes(p))) {
			const compactHit = queryCompact && baseCompact && baseCompact.includes(queryCompact);
			if (!compactHit && compactSubScore <= 0) return 0;
		}
		let score = 0;
		score += queryParts.length * 500;
		if (base === lowerQuery) score += 2000;
		if (base.startsWith(lowerQuery)) score += 1200;
		if (base.includes(lowerQuery)) score += 900;
		if (queryCompact && baseCompact && baseCompact.includes(queryCompact)) score += 640;
		const subseq = fuzzySubsequenceScore(base, lowerQuery);
		if (subseq > 0) score += subseq;
		if (compactSubScore > 0) score += Math.min(500, compactSubScore * 8);
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

