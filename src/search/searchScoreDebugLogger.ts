import type { SearchScoreDebugRow } from "../../shared/searchScoreDebug";

type SearchResultLite = { id?: string; name?: string; path?: string; type?: string };

type SearchScoreDebugSnapshot = {
  sessionId: string;
  query: string;
  searchTypeId: string;
  isSearching: boolean;
  hasMore: boolean;
  results: SearchResultLite[];
};

function toResultId(item: SearchResultLite) {
  const type = typeof item?.type === "string" ? item.type.trim().toLowerCase() : "";
  const path = typeof item?.path === "string" ? item.path.trim().toLowerCase() : "";
  const name = typeof item?.name === "string" ? item.name.trim().toLowerCase() : "";
  const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
  if (id) return id;
  return `${type}|${path || name}`;
}

function round(value: number, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
}

function formatTime(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function toConsoleRow(index: number, item: SearchResultLite, row: SearchScoreDebugRow | null) {
  const formatFileMtimeSource = (source: string) => {
    if (source === "itemTime") return "文件时间";
    if (source === "historyLastUsed") return "历史最近使用";
    if (source === "fallback") return "缺失兜底";
    return "";
  };
  if (!row) {
    return {
      序号: index + 1,
      名称: item?.name || "",
      类型: item?.type || "",
      路径: item?.path || "",
      评分状态: "缺少评分拆解",
    };
  }
  return {
    序号: index + 1,
    名称: row.name,
    类型: row.type,
    路径: row.path,
    来源: row.source || "",
    总分: row.totalScore,
    匹配贡献分: row.scoreByMatch,
    频次贡献分: row.scoreByFrequency,
    最近使用贡献分: row.scoreByRecency,
    文件时间贡献分: row.scoreByFileMtime,
    来源加分: round(row.sourceBonusScore, 2),
    后缀加分: round(row.extBonusScore, 2),
    后缀: row.extKey || "",
    匹配原始分: round(row.staticScore),
    匹配类型修正后分: round(row.staticWithType),
    频次原始分: round(row.frequencyScore),
    最近使用原始分: round(row.recencyScore),
    文件时间原始分: round(row.fileMtimeScore),
    匹配权重: round(row.weightMatch),
    频次权重: round(row.weightFrequency),
    最近使用权重: round(row.weightRecency),
    文件时间权重: round(row.weightFileMtime),
    类型优先级类别: row.priorityType,
    类型优先级值: row.priorityValue,
    类型优先级系数: round(row.priorityNorm),
    历史使用次数: row.historyCount,
    历史最近使用: formatTime(row.historyLastUsedMs),
    最近分基准时间: formatTime(row.effectiveRecencyTimeMs),
    文件时间来源: formatFileMtimeSource(row.fileMtimeSource),
    文件时间: formatTime(row.itemTimeMs),
  };
}

export class SearchScoreDebugLogger {
  private readonly debounceMs: number;
  private timer: number | null = null;
  private sessionId = "";
  private lastPrintedSignature = "";
  private readonly byId = new Map<string, SearchScoreDebugRow>();

  constructor(debounceMs = 1000) {
    this.debounceMs = Math.max(0, Math.floor(debounceMs));
  }

  private clearTimer() {
    if (this.timer == null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() {
    this.clearTimer();
    this.byId.clear();
    this.lastPrintedSignature = "";
    this.sessionId = "";
  }

  resetSession(nextSessionId: string) {
    const normalized = typeof nextSessionId === "string" ? nextSessionId.trim() : "";
    if (normalized === this.sessionId) return;
    this.clearTimer();
    this.byId.clear();
    this.lastPrintedSignature = "";
    this.sessionId = normalized;
  }

  mergeRows(rows: SearchScoreDebugRow[] | undefined) {
    if (!Array.isArray(rows) || rows.length <= 0) return;
    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id.trim().toLowerCase() : "";
      if (!id) continue;
      this.byId.set(id, row);
    }
  }

  schedule(snapshot: SearchScoreDebugSnapshot) {
    this.resetSession(snapshot.sessionId);
    this.clearTimer();

    const query = typeof snapshot.query === "string" ? snapshot.query.trim() : "";
    if (!query) return;
    if (snapshot.isSearching) return;

    const ids = (snapshot.results || []).map((it) => toResultId(it)).filter(Boolean);
    const signature = `${this.sessionId}|${query}|${snapshot.searchTypeId}|${ids.join(",")}`;
    if (!signature || signature === this.lastPrintedSignature) return;

    this.timer = window.setTimeout(() => {
      this.timer = null;
      const rows = (snapshot.results || []).map((item, index) => {
        const id = toResultId(item);
        const row = id ? this.byId.get(id) || null : null;
        return toConsoleRow(index, item, row);
      });
      console.groupCollapsed(
        `[搜索评分明细] 关键词="${query}" 类型="${snapshot.searchTypeId}" 结果数=${rows.length}`,
      );
      console.table(rows);
      console.groupEnd();
      this.lastPrintedSignature = signature;
    }, this.debounceMs);
  }
}
