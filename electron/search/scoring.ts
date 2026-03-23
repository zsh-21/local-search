import { hasChineseChar, toPinyinFull, toPinyinInitials } from '../pinyin';
import { DEFAULT_SETTINGS } from '../constants/initialValues';

const NON_PATH_SYMBOL_RE = /[^\p{L}\p{N}\\/]+/gu;
const COMPACT_SYMBOL_RE = /[^\p{L}\p{N}]+/gu;
const COMPACT_SYMBOL_KEEP_PATH_RE = /[^\p{L}\p{N}\\/]+/gu;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v']);
const FREQUENCY_CAP = 80;

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function normalizeTextForSearch(input: string) {
  // 统一做 NFKC 与小写，减少全角/半角和大小写差异导致的匹配噪声
  return String(input || '').normalize('NFKC').toLowerCase().trim();
}

function tokenizeForScore(input: string) {
  // 除路径符号外其余符号视作分隔符，保证“UI-UX / UI UX / ui_ux”语义一致
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

function buildInitialsKey(input: string) {
  const normalized = normalizeTextForSearch(input);
  if (!normalized) return '';
  const words = normalized.replace(COMPACT_SYMBOL_RE, ' ').split(/\s+/).filter(Boolean);
  if (words.length <= 1) return '';
  return words.map((w) => w[0]).join('');
}

function isTokenOrderConsistent(target: string, tokens: string[]) {
  let cursor = -1;
  for (const token of tokens) {
    const idx = target.indexOf(token, cursor + 1);
    if (idx < 0) return false;
    cursor = idx;
  }
  return true;
}

function levenshteinDistance(a: string, b: string, maxDistance = 24) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > maxDistance) return -1;

  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDistance) return -1;
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }

  return prev[lb] > maxDistance ? -1 : prev[lb];
}

export function createNameScorer(query: string, options?: { mode?: "short" | "medium" | "full" }) {
  const lowerQuery = normalizeTextForSearch(query);
  const queryParts = tokenizeForScore(lowerQuery);
  const queryKeepPathSeparators = /[\\/]/.test(lowerQuery);
  const queryCompact = toCompactKey(lowerQuery, queryKeepPathSeparators);
  const matchMode = options?.mode || "full";
  const allowLevenshtein = matchMode === "full";
  const allowSubsequence = matchMode !== "short";
  const normalizeForMatchName = (name: string) => normalizeTextForSearch(String(name || '').replace(/\.(exe|lnk)$/i, ''));
  const scoreTokens = tokenizeForScore(lowerQuery);

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

  const evaluateTarget = (target: string) => {
    if (!target) return { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };

    const targetCompact = toCompactKey(target, queryKeepPathSeparators);
    let score = 0;
    let tier = 0;
    let matchIndex = 1_000_000;

    if (lowerQuery) {
      const fullIndex = target.indexOf(lowerQuery);
      if (fullIndex === 0 && target.length === lowerQuery.length) {
        // 完全匹配：最高优先级
        score += 120;
        tier = Math.max(tier, 5);
        matchIndex = 0;
      } else if (fullIndex === 0) {
        // 开头匹配：高于中间/末尾
        score += 96;
        tier = Math.max(tier, 4);
        matchIndex = 0;
      } else if (fullIndex > 0) {
        const atSuffix = fullIndex + lowerQuery.length === target.length;
        score += atSuffix ? 62 : 74;
        tier = Math.max(tier, atSuffix ? 2 : 3);
        matchIndex = Math.min(matchIndex, fullIndex);
      }
    }

    if (queryCompact && targetCompact) {
      const compactIndex = targetCompact.indexOf(queryCompact);
      if (compactIndex === 0 && targetCompact.length === queryCompact.length) {
        score += 92;
        tier = Math.max(tier, 4);
        matchIndex = Math.min(matchIndex, 0);
      } else if (compactIndex === 0) {
        score += 76;
        tier = Math.max(tier, 3);
        matchIndex = Math.min(matchIndex, 0);
      } else if (compactIndex > 0) {
        score += 58;
        tier = Math.max(tier, 2);
        matchIndex = Math.min(matchIndex, compactIndex);
      }
    }

    // 缩写匹配：如“vs -> Visual Studio”，优先于一般模糊匹配
    const initials = buildInitialsKey(target);
    if (queryCompact && initials) {
      const abbrIndex = initials.indexOf(queryCompact);
      if (abbrIndex === 0 && initials.length === queryCompact.length) {
        score += 84;
        tier = Math.max(tier, 3);
        matchIndex = Math.min(matchIndex, 0);
      } else if (abbrIndex === 0) {
        score += 72;
        tier = Math.max(tier, 2);
        matchIndex = Math.min(matchIndex, 0);
      } else if (abbrIndex > 0) {
        score += 60;
        tier = Math.max(tier, 1);
        matchIndex = Math.min(matchIndex, abbrIndex);
      }
    }

    const matchedTokens = scoreTokens.filter((t) => t && target.includes(t));
    const tokenCount = scoreTokens.length;
    const matchedTokenCount = matchedTokens.length;

    if (tokenCount > 0 && matchedTokenCount === tokenCount) {
      // 关键词全覆盖：强加分
      score += 24;
      if (isTokenOrderConsistent(target, scoreTokens)) {
        // 词序一致：进一步提升排序稳定性
        score += 10;
      }
    } else if (matchedTokenCount > 0 && tokenCount > 0) {
      score += (matchedTokenCount / tokenCount) * 12;
    }

    // Levenshtein 仅在高阶命中不足时参与，避免误抬升低质量模糊结果
    if (allowLevenshtein && tier < 4 && queryCompact && targetCompact) {
      const maxLen = Math.max(queryCompact.length, targetCompact.length);
      if (maxLen > 0 && Math.abs(queryCompact.length - targetCompact.length) <= Math.max(8, queryCompact.length)) {
        const dist = levenshteinDistance(queryCompact, targetCompact, 12);
        if (dist >= 0) {
          const similarity = 1 - dist / maxLen;
          if (similarity > 0) {
            score += 52 * similarity;
            if (similarity > 0.86) tier = Math.max(tier, 2);
          }
        }
      }
    }

    if (allowSubsequence && tier < 3 && queryCompact && targetCompact) {
      const compactSubScore = compactSubsequenceScore(targetCompact, queryCompact);
      if (compactSubScore > 0) score += Math.min(30, compactSubScore * 0.9);
      const subseq = fuzzySubsequenceScore(target, lowerQuery);
      if (subseq > 0) score += Math.min(24, subseq * 0.5);
    }

    if (matchIndex >= 1_000_000) {
      matchIndex = tier > 0 ? 999_999 : 1_000_000;
    }

    const staticScore = clamp01(score / 180);
    return {
      weightedScore: Math.max(0, Math.round(score * 10)),
      staticScore,
      matchIndex,
      nameLen: target.length,
      matchedTokenCount,
      tokenCount,
    };
  };

  const computeWeightedNameMatch = (rawName: string) => {
    const nameLower = normalizeForMatchName(rawName);
    if (!nameLower) return { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 0 };

    const noExt = nameLower.replace(/\.[^./\\]+$/, '');
    const candidates = noExt && noExt !== nameLower ? [nameLower, noExt] : [nameLower];

    // 查询包含英数且目标有中文时，额外引入全拼与首字母候选，提升中英文混输命中
    const hasLatinOrNumberQuery = /[a-z0-9]/.test(queryCompact);
    if (hasLatinOrNumberQuery && hasChineseChar(rawName)) {
      const py = normalizeTextForSearch(toPinyinFull(rawName));
      const ini = normalizeTextForSearch(toPinyinInitials(rawName));
      if (py) candidates.push(py);
      if (ini) candidates.push(ini);
    }

    let best = evaluateTarget(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      const cur = evaluateTarget(candidates[i]);
      if (cur.weightedScore > best.weightedScore) best = cur;
      else if (cur.weightedScore === best.weightedScore) {
        if (cur.matchIndex < best.matchIndex) best = cur;
        else if (cur.matchIndex === best.matchIndex && cur.nameLen < best.nameLen) best = cur;
      }
    }

    return {
      weightedScore: best.weightedScore,
      staticScore: best.staticScore,
      matchIndex: best.matchIndex,
      nameLen: best.nameLen,
    };
  };

  // 兼容旧调用：返回加权分，避免策略层在迁移期出现签名断裂
  const scoreRecentName = (name: string) => computeWeightedNameMatch(name).weightedScore;

  return { lowerQuery, queryParts, computeWeightedNameMatch, scoreRecentName };
}

export function createScoreComputer(input: {
  now: number;
  historyStats: any;
  normalizeHistoryKey: (rawPath: string) => string;
  normalizeExtKey: (rawPath: string) => string;
  searchRanking?: any;
}) {
  const { now, historyStats, normalizeHistoryKey, normalizeExtKey } = input;

  const normalizeRankingForRuntime = (raw: any) => {
    const fallback = DEFAULT_SETTINGS.searchRanking;
    const clamp = (v: any, min: number, max: number, fallbackValue: number) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return fallbackValue;
      return Math.min(max, Math.max(min, n));
    };

    const signalWeightsRaw = {
      match: clamp(raw?.signalWeights?.match, 0, 1000, fallback.signalWeights.match),
      frequency: clamp(raw?.signalWeights?.frequency, 0, 1000, fallback.signalWeights.frequency),
      recency: clamp(raw?.signalWeights?.recency, 0, 1000, fallback.signalWeights.recency),
      fileMtime: clamp(raw?.signalWeights?.fileMtime, 0, 1000, fallback.signalWeights.fileMtime),
    };
    const sum = signalWeightsRaw.match + signalWeightsRaw.frequency + signalWeightsRaw.recency + signalWeightsRaw.fileMtime;
    const safe = sum > 0 ? sum : fallback.signalWeights.match + fallback.signalWeights.frequency + fallback.signalWeights.recency + fallback.signalWeights.fileMtime;

    const typePriority = {
      app: Math.round(clamp(raw?.typePriority?.app, 1, 10, fallback.typePriority.app)),
      command: Math.round(clamp(raw?.typePriority?.command, 1, 10, fallback.typePriority.command)),
      settings: Math.round(clamp(raw?.typePriority?.settings, 1, 10, fallback.typePriority.settings)),
      file: Math.round(clamp(raw?.typePriority?.file, 1, 10, fallback.typePriority.file)),
      folder: Math.round(clamp(raw?.typePriority?.folder, 1, 10, fallback.typePriority.folder)),
      image: Math.round(clamp(raw?.typePriority?.image, 1, 10, fallback.typePriority.image)),
      video: Math.round(clamp(raw?.typePriority?.video, 1, 10, fallback.typePriority.video)),
      web: Math.round(clamp(raw?.typePriority?.web, 1, 10, fallback.typePriority.web)),
      plugin: Math.round(clamp(raw?.typePriority?.plugin, 1, 10, fallback.typePriority.plugin)),
    };

    return {
      signalWeights: {
        match: signalWeightsRaw.match / safe,
        frequency: signalWeightsRaw.frequency / safe,
        recency: signalWeightsRaw.recency / safe,
        fileMtime: signalWeightsRaw.fileMtime / safe,
      },
      frecency: {
        decayFactor: clamp(raw?.frecency?.decayFactor, 0.0001, 1, fallback.frecency.decayFactor),
        frequencyWeight: clamp(raw?.frecency?.frequencyWeight, 0, 10, fallback.frecency.frequencyWeight),
      },
      typePriority,
    };
  };

  const ranking = normalizeRankingForRuntime(input.searchRanking);

  const getHistoryUsage = (rawPath: string) => {
    const key = normalizeHistoryKey(rawPath);
    if (!key) return { count: 0, lastUsed: 0 };
    const it = historyStats?.byPath?.[key];
    const count = typeof it?.count === 'number' && it.count > 0 ? it.count : 0;
    const lastUsed = typeof it?.lastUsed === 'number' && it.lastUsed > 0 ? it.lastUsed : 0;
    return { count, lastUsed };
  };

  const getLastUsedMs = (rawPath: string) => getHistoryUsage(rawPath).lastUsed;

  const toHoursDiff = (timeMs: number) => {
    if (!Number.isFinite(timeMs) || timeMs <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, (now - timeMs) / 3_600_000);
  };

  const getRecencyScore = (timeMs: number) => {
    const hoursDiff = toHoursDiff(timeMs);
    if (!Number.isFinite(hoursDiff)) return 0;
    return clamp01(Math.exp(-ranking.frecency.decayFactor * hoursDiff));
  };

  const getFrequencyScore = (count: number) => {
    if (!Number.isFinite(count) || count <= 0) return 0;
    const normalizedLog = Math.log(count + 1) / Math.log(FREQUENCY_CAP + 1);
    return clamp01(normalizedLog * ranking.frecency.frequencyWeight);
  };

  const inferPriorityType = (type: string, rawPath: string): keyof typeof ranking.typePriority => {
    if (type === 'app' || type === 'command' || type === 'settings' || type === 'folder' || type === 'web' || type === 'plugin') {
      return type;
    }
    if (type === 'image' || type === 'video') return type;
    if (type === 'file') {
      const ext = normalizeExtKey(rawPath);
      if (ext && IMAGE_EXTENSIONS.has(ext)) return 'image';
      if (ext && VIDEO_EXTENSIONS.has(ext)) return 'video';
      return 'file';
    }
    return 'file';
  };

  const isFileLike = (priorityType: keyof typeof ranking.typePriority) =>
    priorityType === 'file' || priorityType === 'folder' || priorityType === 'image' || priorityType === 'video';

  const computeCombinedScore = (params: {
    staticScore: number;
    type: string;
    rawPath: string;
    timeMs?: number;
    sourceScore?: number;
  }) => {
    const priorityType = inferPriorityType(params.type, params.rawPath);
    const usage = getHistoryUsage(params.rawPath);

    const frequencyScore = getFrequencyScore(usage.count);
    const recencyScore = getRecencyScore(usage.lastUsed);
    const fileMtimeScore = isFileLike(priorityType) ? getRecencyScore(Number(params.timeMs || 0)) : 0;

    const typePriorityNorm = clamp01((ranking.typePriority[priorityType] || 1) / 10);
    // 类型优先级通过调制静态分参与总分，避免与行为分互相吞噬
    const staticWithType = clamp01(clamp01(params.staticScore) * (0.72 + 0.28 * typePriorityNorm));

    const finalScoreNormalized =
      ranking.signalWeights.match * staticWithType +
      ranking.signalWeights.frequency * frequencyScore +
      ranking.signalWeights.recency * recencyScore +
      ranking.signalWeights.fileMtime * fileMtimeScore;

    // 预留 sourceScore：插件侧可通过大分差固定插件内部顺序
    const sourceScore = Number.isFinite(params.sourceScore as number) ? Number(params.sourceScore) : 0;
    return Math.round(finalScoreNormalized * 1_000_000 + sourceScore * 100);
  };

  return { getLastUsedMs, computeCombinedScore };
}
