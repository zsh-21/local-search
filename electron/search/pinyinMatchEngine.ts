import path from "node:path";
import { createNameScorer, createScoreComputer } from "./scoring";
import { getWindowsSettingsItems } from "./settingsSearch";
import type { SearchWorkerCandidate, SearchWorkerInstalledApp, SearchWorkerRankPayload } from "./searchMatchProtocol";
import type { SearchScoreDebugRow } from "../../shared/searchScoreDebug";
import { hasChineseChar, toPinyinFull, toPinyinInitials } from "../pinyin";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
const APP_SOURCE_SCORE = 100;
const SETTINGS_SOURCE_SCORE = 90;
const COMMAND_SOURCE_SCORE = 80;
const FAST_COMMAND_LIMIT = 5;
const FULL_COMMAND_LIMIT = 12;
const FAST_SETTINGS_LIMIT = 10;
const FULL_SETTINGS_LIMIT = 20;
const FAST_APPS_LIMIT = 12;
const FULL_APPS_LIMIT = 50;
const APP_ONLY_LIMIT = 100;
const SETTINGS_ONLY_LIMIT = 100;
// 涓ユ牸鍖归厤鐨勫垎璇嶅垎闅旂锛氫粎淇濈暀瀛楁瘝/鏁板瓧
const STRICT_TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/gu;

type RankedCandidate = SearchWorkerCandidate & {
  score: number;
  staticScore: number;
  weightedScore: number;
  matchIndex: number;
  nameLen: number;
  scoreDetail: any;
};

type RankInput = SearchWorkerRankPayload & {
  appsSnapshot: SearchWorkerInstalledApp[];
  shouldCancel?: () => boolean;
};

type RankOutput = {
  items: RankedCandidate[];
  totalCount: number;
  scoreDebugRows: SearchScoreDebugRow[];
  cancelled?: boolean;
};

const COMMAND_ITEMS: Array<{
  name: string;
  path: string;
  description: string;
  aliases: string[];
}> = [
  {
    name: "\u5173\u673a",
    path: "system:shutdown",
    description: "Shut down the computer",
    aliases: ["shutdown", "poweroff", "\u5173\u673a"],
  },
  {
    name: "\u91cd\u542f\u7535\u8111",
    path: "system:restart",
    description: "Restart the computer",
    aliases: ["restart", "reboot", "\u91cd\u542f", "\u91cd\u542f\u7535\u8111"],
  },
];

function normalizeKey(input: string) {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

function createCandidateKey(item: { type?: string; path?: string; name?: string }) {
  const type = normalizeKey(item.type || "");
  const target = normalizeKey(item.path || item.name || "");
  return `${type}|${target}`;
}

function normalizeHistoryKey(rawPath: string) {
  return normalizeKey(rawPath);
}

function normalizeStrictText(input: string) {
  return String(input || "").normalize("NFKC").toLowerCase().trim();
}

// 涓ユ牸鍖归厤鐨勭揣鍑戜覆锛氬幓鎺夊垎闅旂锛屼究浜庡鐞嗙┖鏍?绗﹀彿宸紓
function toCompactStrictText(input: string) {
  return normalizeStrictText(input).replace(STRICT_TOKEN_SPLIT_RE, "");
}

// 涓ユ牸鍖归厤鐨勬煡璇㈠垎璇嶏細鐢ㄤ簬鈥滃叏閮?token 蹇呴』鍛戒腑鈥濈殑鏍￠獙
function tokenizeStrictQuery(input: string) {
  const normalized = normalizeStrictText(input);
  if (!normalized) return [] as string[];
  return normalized.replace(STRICT_TOKEN_SPLIT_RE, " ").split(/\s+/).map((x) => x.trim()).filter(Boolean);
}
function shouldUseStrictAppOrSettingsMatch(itemType: string, isPathQuery: boolean) {
  if (isPathQuery) return false;
  return itemType === "app" || itemType === "settings";
}
type StrictCandidate = { text: string; mode: "prefix" | "initials" };
function isAsciiToken(token: string) {
  return /^[a-z0-9]+$/i.test(token);
}
function isSubsequence(target: string, query: string) {
  let i = 0;
  for (let j = 0; j < target.length && i < query.length; j++) {
    if (target[j] === query[i]) i += 1;
  }
  return i === query.length;
}

// 鏋勫缓涓ユ牸鍖归厤鍊欓€夋枃鏈細鍚嶇О/鍒悕鎸夊墠缂€鍖归厤锛岄瀛楁瘝涓叉寜搴忓垪鍖归厤
function buildStrictTexts(item: SearchWorkerCandidate) {
  const out: StrictCandidate[] = [];
  const seen = new Set<string>(); // key = `${mode}:${text}`
  const push = (value: string, mode: StrictCandidate["mode"]) => {
    const normalized = normalizeStrictText(value);
    if (!normalized) return;
    const key = `${mode}:${normalized}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: normalized, mode });
  };

  push(String(item.name || ""), "prefix");
  const aliases = Array.isArray(item.aliases) ? item.aliases : [];
  for (const alias of aliases) {
    if (typeof alias !== "string") continue;
    push(alias, "prefix");
  }

  // 中文名称补充拼音全拼与首字母，支持拼音输入。
  const baseTexts = out.map((it) => it.text);
  for (const text of baseTexts) {
    if (!hasChineseChar(text)) continue;
    push(String(toPinyinFull(text) || ""), "prefix");
    push(String(toPinyinInitials(text) || ""), "initials");
  }
  return out;
}

function isStrictAppOrSettingsMatch(query: string, item: SearchWorkerCandidate) {
  const tokens = tokenizeStrictQuery(query);
  if (tokens.length <= 0) return false;
  const candidates = buildStrictTexts(item);
  if (candidates.length <= 0) return false;

  return candidates.some((candidate) => {
    const compactCandidate = toCompactStrictText(candidate.text);
    return tokens.every((token) => {
      if (!isAsciiToken(token)) return candidate.text.includes(token);
      if (candidate.mode === "initials") return isSubsequence(compactCandidate, token);
      if (candidate.text.startsWith(token)) return true;
      const compactToken = toCompactStrictText(token);
      return Boolean(compactToken) && compactCandidate.startsWith(compactToken);
    });
  });
}

function normalizeExtKey(rawPath: string) {
  const raw = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!raw) return "";
  const ext = path.extname(raw).toLowerCase();
  if (!ext || ext.length > 12) return "";
  return ext;
}

function isFileLikeType(type: string) {
  return type === "file" || type === "folder" || type === "image" || type === "video";
}

function compareCandidates(a: RankedCandidate, b: RankedCandidate) {
  const nonFileA = !isFileLikeType(String(a.type || ""));
  const nonFileB = !isFileLikeType(String(b.type || ""));
  if (nonFileA !== nonFileB) return nonFileA ? -1 : 1;

  const sa = Number.isFinite(a.score) ? a.score : 0;
  const sb = Number.isFinite(b.score) ? b.score : 0;
  if (sa > sb) return -1;
  if (sa < sb) return 1;

  const ia = Number.isFinite(a.matchIndex) ? a.matchIndex : 1_000_000;
  const ib = Number.isFinite(b.matchIndex) ? b.matchIndex : 1_000_000;
  if (ia < ib) return -1;
  if (ia > ib) return 1;

  const na = Number.isFinite(a.nameLen) ? a.nameLen : 1_000_000;
  const nb = Number.isFinite(b.nameLen) ? b.nameLen : 1_000_000;
  if (na < nb) return -1;
  if (na > nb) return 1;

  return 0;
}

function matchesTypeFilter(item: SearchWorkerCandidate, searchTypeId: string) {
  const type = typeof item.type === "string" ? item.type : "";
  if (searchTypeId === "all") return true;
  if (searchTypeId === "app") return type === "app";
  if (searchTypeId === "settings") return type === "settings";
  if (searchTypeId === "folder") return type === "folder";
  if (searchTypeId === "file") return type === "file";
  if (searchTypeId === "image") return type === "file" || type === "image";
  if (searchTypeId === "video") return type === "file" || type === "video";
  if (searchTypeId.startsWith("ext:")) {
    const ext = searchTypeId.slice(4).toLowerCase();
    return type === "file" && String(item.path || "").toLowerCase().endsWith(ext);
  }
  return true;
}

function inferFileLikeType(item: SearchWorkerCandidate) {
  const type = String(item.type || "");
  if (type !== "file") return type;
  const ext = normalizeExtKey(item.path || "");
  if (ext && IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext && VIDEO_EXTENSIONS.has(ext)) return "video";
  return "file";
}

function getLaneSourceLimits(lane: "fast" | "full") {
  if (lane === "fast") {
    return {
      command: FAST_COMMAND_LIMIT,
      settings: FAST_SETTINGS_LIMIT,
      app: FAST_APPS_LIMIT,
    };
  }
  return {
    command: FULL_COMMAND_LIMIT,
    settings: FULL_SETTINGS_LIMIT,
    app: FULL_APPS_LIMIT,
  };
}

function buildBuiltInCommandCandidates(input: { searchTypeId: string; isPathQuery: boolean }) {
  if (input.isPathQuery) return [] as SearchWorkerCandidate[];
  if (input.searchTypeId !== "all") return [] as SearchWorkerCandidate[];
  return COMMAND_ITEMS.map((item) => ({
    name: item.name,
    path: item.path,
    type: "command",
    description: item.description,
    aliases: item.aliases.slice(),
    sourceScore: COMMAND_SOURCE_SCORE,
    source: "command",
    rawSource: "command",
    metaFlags: { command: true },
  }));
}

function buildBuiltInSettingsCandidates(searchTypeId: string) {
  if (searchTypeId !== "all" && searchTypeId !== "settings") return [] as SearchWorkerCandidate[];
  const settingsItems = getWindowsSettingsItems();
  return settingsItems.map((item) => ({
    name: item.name,
    path: item.uri,
    type: "settings",
    sourceScore: SETTINGS_SOURCE_SCORE,
    source: "settings",
    rawSource: "settings",
  }));
}

function buildAppCandidates(input: { searchTypeId: string; appsSnapshot: SearchWorkerInstalledApp[] }) {
  if (input.searchTypeId !== "all" && input.searchTypeId !== "app") return [] as SearchWorkerCandidate[];
  const out: SearchWorkerCandidate[] = [];
  for (const app of input.appsSnapshot || []) {
    const appId = typeof app?.AppID === "string" ? app.AppID.trim() : "";
    const appName = typeof app?.Name === "string" ? app.Name.trim() : "";
    if (!appId || !appName) continue;
    const lowerAppId = appId.toLowerCase();
    if (lowerAppId.endsWith(".lnk") || lowerAppId.endsWith(".url")) continue;
    const installTimeMs = Number(app?.installTimeMs || 0);
    out.push({
      name: appName,
      path: appId,
      type: "app",
      timeMs: Number.isFinite(installTimeMs) && installTimeMs > 0 ? Math.round(installTimeMs) : 0,
      sourceScore: APP_SOURCE_SCORE,
      source: "apps",
      rawSource: "apps",
    });
  }
  return out;
}

function pickBestMatchAcrossTexts(input: {
  item: SearchWorkerCandidate;
  isPathQuery: boolean;
  computeWeightedNameMatch: (name: string) => { weightedScore: number; staticScore: number; matchIndex: number; nameLen: number };
}) {
  const baseTarget = input.isPathQuery ? String(input.item.path || "") : String(input.item.name || "");
  const aliases = Array.isArray(input.item.aliases) ? input.item.aliases.filter((x) => typeof x === "string" && x.trim()) : [];
  const targets = [baseTarget, ...aliases];
  let best = { weightedScore: 0, staticScore: 0, matchIndex: 1_000_000, nameLen: 1_000_000 };
  for (const text of targets) {
    const cur = input.computeWeightedNameMatch(String(text || ""));
    if (cur.weightedScore > best.weightedScore) {
      best = cur;
      continue;
    }
    if (cur.weightedScore === best.weightedScore) {
      if (cur.matchIndex < best.matchIndex) best = cur;
      else if (cur.matchIndex === best.matchIndex && cur.nameLen < best.nameLen) best = cur;
    }
  }
  return best;
}

function scoreCandidates(input: {
  query: string;
  matchMode: "short" | "medium" | "full";
  isPathQuery: boolean;
  now: number;
  historyStats: any;
  searchRanking?: any;
  candidates: SearchWorkerCandidate[];
  shouldCancel?: () => boolean;
}) {
  const nameScorer = createNameScorer(input.query, { mode: input.matchMode });
  const strictNameScorer = createNameScorer(input.query, {
    mode: input.matchMode,
    // 搴旂敤/璁剧疆绂佺敤妯＄硦鍏滃簳锛氶伩鍏?鈥渃hromes/chrs鈥?杩欑被璇嶈鍛戒腑 鈥渃hrome鈥濄€?    disableFuzzyFallback: true,
  });
  const scoreComputer = createScoreComputer({
    now: input.now,
    historyStats: input.historyStats,
    normalizeHistoryKey,
    normalizeExtKey,
    searchRanking: input.searchRanking,
  });
  const out: RankedCandidate[] = [];
  const rawList = Array.isArray(input.candidates) ? input.candidates : [];
  for (let i = 0; i < rawList.length; i++) {
    if (i > 0 && i % 64 === 0 && input.shouldCancel?.()) {
      return { items: [] as RankedCandidate[], cancelled: true };
    }
    const item = rawList[i];
    if (!item || typeof item !== "object") continue;
    if (!item.name && !item.path) continue;
    const strictAppOrSettingsMatch = shouldUseStrictAppOrSettingsMatch(String(item.type || ""), input.isPathQuery);
    if (strictAppOrSettingsMatch && !isStrictAppOrSettingsMatch(input.query, item)) continue;
    const best = pickBestMatchAcrossTexts({
      item,
      isPathQuery: input.isPathQuery,
      computeWeightedNameMatch: strictAppOrSettingsMatch
        ? strictNameScorer.computeWeightedNameMatch
        : nameScorer.computeWeightedNameMatch,
    });
    if (best.staticScore <= 0) continue;
    const type = inferFileLikeType(item);
    const scoreDetail = scoreComputer.computeCombinedScoreDetail({
      staticScore: best.staticScore,
      type,
      rawPath: String(item.path || ""),
      timeMs: Number(item.timeMs || 0),
      sourceScore: Number.isFinite(item.sourceScore as number) ? Number(item.sourceScore) : 0,
    });
    const score = scoreDetail.totalScore;
    out.push({
      ...item,
      type,
      score,
      staticScore: best.staticScore,
      weightedScore: best.weightedScore,
      matchIndex: best.matchIndex,
      nameLen: best.nameLen,
      scoreDetail,
    });
  }
  return { items: out, cancelled: false };
}

function limitByTopScore(items: RankedCandidate[], limit: number) {
  if (!Array.isArray(items) || items.length <= 0) return [] as RankedCandidate[];
  if (!Number.isFinite(limit) || limit <= 0) return [] as RankedCandidate[];
  const sorted = items.slice().sort(compareCandidates);
  return sorted.slice(0, Math.floor(limit));
}

function dedupeRankedItems(items: RankedCandidate[]) {
  const out: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = createCandidateKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function toScoreDebugRow(item: RankedCandidate): SearchScoreDebugRow {
  const d = item.scoreDetail || {};
  return {
    id: createCandidateKey(item),
    name: typeof item.name === "string" ? item.name : "",
    path: typeof item.path === "string" ? item.path : "",
    type: typeof item.type === "string" ? item.type : "",
    source: typeof item.source === "string" ? item.source : "",
    totalScore: Number.isFinite(item.score) ? Number(item.score) : 0,
    sourceBonusScore: Number.isFinite(d.sourceBonusScore) ? Number(d.sourceBonusScore) : 0,
    extBonusScore: Number.isFinite(d.extBonusScore) ? Number(d.extBonusScore) : 0,
    extKey: typeof d.extKey === "string" ? d.extKey : "",
    scoreByMatch: Number.isFinite(d.scoreByMatch) ? Number(d.scoreByMatch) : 0,
    scoreByFrequency: Number.isFinite(d.scoreByFrequency) ? Number(d.scoreByFrequency) : 0,
    scoreByRecency: Number.isFinite(d.scoreByRecency) ? Number(d.scoreByRecency) : 0,
    scoreByFileMtime: Number.isFinite(d.scoreByFileMtime) ? Number(d.scoreByFileMtime) : 0,
    staticScore: Number.isFinite(d.staticScore) ? Number(d.staticScore) : 0,
    staticWithType: Number.isFinite(d.staticWithType) ? Number(d.staticWithType) : 0,
    frequencyScore: Number.isFinite(d.frequencyScore) ? Number(d.frequencyScore) : 0,
    recencyScore: Number.isFinite(d.recencyScore) ? Number(d.recencyScore) : 0,
    fileMtimeScore: Number.isFinite(d.fileMtimeScore) ? Number(d.fileMtimeScore) : 0,
    weightMatch: Number.isFinite(d.weightMatch) ? Number(d.weightMatch) : 0,
    weightFrequency: Number.isFinite(d.weightFrequency) ? Number(d.weightFrequency) : 0,
    weightRecency: Number.isFinite(d.weightRecency) ? Number(d.weightRecency) : 0,
    weightFileMtime: Number.isFinite(d.weightFileMtime) ? Number(d.weightFileMtime) : 0,
    priorityType: typeof d.priorityType === "string" ? d.priorityType : "",
    priorityValue: Number.isFinite(d.priorityValue) ? Number(d.priorityValue) : 0,
    priorityNorm: Number.isFinite(d.priorityNorm) ? Number(d.priorityNorm) : 0,
    historyCount: Number.isFinite(d.historyCount) ? Number(d.historyCount) : 0,
    historyLastUsedMs: Number.isFinite(d.historyLastUsedMs) ? Number(d.historyLastUsedMs) : 0,
    itemTimeMs: Number.isFinite(d.itemTimeMs) ? Number(d.itemTimeMs) : 0,
    effectiveRecencyTimeMs: Number.isFinite(d.effectiveRecencyTimeMs) ? Number(d.effectiveRecencyTimeMs) : 0,
    fileMtimeSource: typeof d.fileMtimeSource === "string" ? d.fileMtimeSource : "",
  };
}

export function rankCandidatesWithPinyinEngine(input: RankInput): RankOutput {
  const shouldCancel = () => Boolean(input.shouldCancel?.());
  if (shouldCancel()) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };

  const sourceLimits = getLaneSourceLimits(input.lane);
  const builtInCommands = buildBuiltInCommandCandidates({
    searchTypeId: input.searchTypeId,
    isPathQuery: input.isPathQuery,
  });
  const builtInSettings = buildBuiltInSettingsCandidates(input.searchTypeId);
  const appCandidates = buildAppCandidates({
    searchTypeId: input.searchTypeId,
    appsSnapshot: input.appsSnapshot,
  });

  const directItems = (Array.isArray(input.directItems) ? input.directItems : []).filter((item) =>
    matchesTypeFilter(item, input.searchTypeId),
  );
  const fileItems = (Array.isArray(input.fileItems) ? input.fileItems : []).filter((item) =>
    matchesTypeFilter(item, input.searchTypeId),
  );
  const recentItems = (Array.isArray(input.recentItems) ? input.recentItems : []).filter((item) =>
    matchesTypeFilter(item, input.searchTypeId),
  );
  const commandItems = builtInCommands.filter((item) => matchesTypeFilter(item, input.searchTypeId));
  const settingsItems = builtInSettings.filter((item) => matchesTypeFilter(item, input.searchTypeId));
  const appsItems = appCandidates.filter((item) => matchesTypeFilter(item, input.searchTypeId));

  const scoreInputBase = {
    query: input.query,
    matchMode: input.matchMode,
    isPathQuery: input.isPathQuery,
    now: input.now,
    historyStats: input.historyStats,
    searchRanking: input.searchRanking,
    shouldCancel,
  };

  const directScored = scoreCandidates({ ...scoreInputBase, candidates: directItems });
  if (directScored.cancelled) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };
  const fileScored = scoreCandidates({ ...scoreInputBase, candidates: fileItems });
  if (fileScored.cancelled) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };
  const recentScored = scoreCandidates({ ...scoreInputBase, candidates: recentItems });
  if (recentScored.cancelled) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };
  const commandScored = scoreCandidates({ ...scoreInputBase, candidates: commandItems });
  if (commandScored.cancelled) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };
  const settingsScored = scoreCandidates({ ...scoreInputBase, candidates: settingsItems });
  if (settingsScored.cancelled) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };
  const appsScored = scoreCandidates({ ...scoreInputBase, candidates: appsItems });
  if (appsScored.cancelled) return { items: [], totalCount: 0, scoreDebugRows: [], cancelled: true };

  const commandSelected = limitByTopScore(commandScored.items, sourceLimits.command);
  const settingsSelected = limitByTopScore(
    settingsScored.items,
    input.searchTypeId === "settings" ? SETTINGS_ONLY_LIMIT : sourceLimits.settings,
  );
  const appsSelected = limitByTopScore(appsScored.items, input.searchTypeId === "app" ? APP_ONLY_LIMIT : sourceLimits.app);

  const merged = [
    ...directScored.items,
    ...commandSelected,
    ...settingsSelected,
    ...appsSelected,
    ...fileScored.items,
    ...recentScored.items,
  ];
  const sorted = merged.sort(compareCandidates);
  const deduped = dedupeRankedItems(sorted);
  const totalCount = deduped.length;
  const limit = Number.isFinite(input.displayLimit) ? Math.max(0, Math.floor(input.displayLimit)) : 0;
  const items = limit > 0 ? deduped.slice(0, limit) : [];
  const scoreDebugRows = items.map((it) => toScoreDebugRow(it));
  return { items, totalCount, scoreDebugRows };
}
