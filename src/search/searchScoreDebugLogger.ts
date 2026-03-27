import type { SearchScoreDebugRow } from "../../shared/searchScoreDebug";

// 调试输出的轻量结果结构：仅保留定位所需字段
type SearchResultLite = { id?: string; name?: string; path?: string; type?: string };

// 调试输出快照：用于控制打印节奏与输出内容
type SearchScoreDebugSnapshot = {
  sessionId: string;
  query: string;
  searchTypeId: string;
  isSearching: boolean;
  hasMore: boolean;
  results: SearchResultLite[];
};

// 生成调试用结果 ID：保持与主逻辑的去重规则一致
function toResultId(item: SearchResultLite) {
  const type = typeof item?.type === "string" ? item.type.trim().toLowerCase() : "";
  const targetPath = typeof item?.path === "string" ? item.path.trim().toLowerCase() : "";
  const name = typeof item?.name === "string" ? item.name.trim().toLowerCase() : "";
  const id = typeof item?.id === "string" ? item.id.trim().toLowerCase() : "";
  if (id) return id;
  return `${type}|${targetPath || name}`;
}

// 数值四舍五入：控制调试表输出精度
function round(value: number, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
}

// 时间格式化：便于直接观察历史/文件时间
function formatTime(ts: number) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

// 将评分明细转换为 console.table 的可读行结构
function toConsoleRow(index: number, item: SearchResultLite, row: SearchScoreDebugRow | null) {
  const formatFileMtimeSource = (source: string) => {
    if (source === "itemTime") return "文件时间";
    if (source === "historyLastUsed") return "历史最近使用";
    if (source === "fallback") return "缺失兜底";
    return "";
  };
  if (!row) {
    return {
      "序号": index + 1,
      "名称": item?.name || "",
      "类型": item?.type || "",
      "路径": item?.path || "",
      "评分状态": "缺少评分拆解",
    };
  }
  return {
    "序号": index + 1,
    "名称": row.name,
    "类型": row.type,
    "路径": row.path,
    "来源": row.source || "",
    "总分": row.totalScore,
    "匹配贡献分": row.scoreByMatch,
    "频次贡献分": row.scoreByFrequency,
    "最近使用贡献分": row.scoreByRecency,
    "文件时间贡献分": row.scoreByFileMtime,
    "来源加分": round(row.sourceBonusScore, 2),
    "后缀加分": round(row.extBonusScore, 2),
    "后缀": row.extKey || "",
    "匹配原始分": round(row.staticScore),
    "匹配类型修正后分": round(row.staticWithType),
    "频次原始分": round(row.frequencyScore),
    "最近使用原始分": round(row.recencyScore),
    "文件时间原始分": round(row.fileMtimeScore),
    "匹配权重": round(row.weightMatch),
    "频次权重": round(row.weightFrequency),
    "最近使用权重": round(row.weightRecency),
    "文件时间权重": round(row.weightFileMtime),
    "类型优先级类别": row.priorityType,
    "类型优先级值": row.priorityValue,
    "类型优先级系数": round(row.priorityNorm),
    "历史使用次数": row.historyCount,
    "历史最近使用": formatTime(row.historyLastUsedMs),
    "最近分基准时间": formatTime(row.effectiveRecencyTimeMs),
    "文件时间来源": formatFileMtimeSource(row.fileMtimeSource),
    "文件时间": formatTime(row.itemTimeMs),
  };
}

export class SearchScoreDebugLogger {
  // 防抖时间：避免频繁输出刷屏
  private readonly debounceMs: number;
  // 防抖定时器句柄
  private timer: number | null = null;
  // 当前会话 ID：用于去重打印
  private sessionId = "";
  // 上一次打印的签名：避免重复输出
  private lastPrintedSignature = "";
  // 评分明细缓存：按结果 ID 汇总
  private readonly byId = new Map<string, SearchScoreDebugRow>();
  // 当前索引 Worker 数量：用于调试输出显示并发
  private workerCount: number | null = null;
  // Worker 数量加载中标记：避免重复 IPC
  private workerCountLoading = false;

  // 初始化调试器：传入防抖时间（毫秒）
  constructor(debounceMs = 1000) {
    this.debounceMs = Math.max(0, Math.floor(debounceMs));
  }

  // 清理防抖定时器
  private clearTimer() {
    if (this.timer == null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  // 懒加载 Worker 数量：仅在需要打印时调用
  private async ensureWorkerCountLoaded() {
    if (this.workerCountLoading) return;
    if (Number.isFinite(this.workerCount)) return;
    if (!window.ipcRenderer) return;
    this.workerCountLoading = true;
    try {
      const resp = (await window.ipcRenderer.invoke("get-index-runtime-info")) as
        | {
            workerCount?: number;
          }
        | undefined;
      const value = Number(resp?.workerCount);
      this.workerCount = Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    } catch {
      this.workerCount = null;
    } finally {
      this.workerCountLoading = false;
    }
  }

  // 释放资源：清理定时器与缓存
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

  // 合并评分明细：以结果 ID 为主键覆盖更新
  mergeRows(rows: SearchScoreDebugRow[] | undefined) {
    if (!Array.isArray(rows) || rows.length <= 0) return;
    for (const row of rows) {
      const id = typeof row?.id === "string" ? row.id.trim().toLowerCase() : "";
      if (!id) continue;
      this.byId.set(id, row);
    }
  }

  // 调度打印：根据防抖策略与会话信息输出调试表
  schedule(snapshot: SearchScoreDebugSnapshot) {
    this.resetSession(snapshot.sessionId);
    this.clearTimer();

    const query = typeof snapshot.query === "string" ? snapshot.query.trim() : "";
    if (!query) return;
    if (snapshot.isSearching) return;

    const ids = (snapshot.results || []).map((it) => toResultId(it)).filter(Boolean);
    const signature = `${this.sessionId}|${query}|${snapshot.searchTypeId}|${ids.join(",")}`;
    if (!signature || signature === this.lastPrintedSignature) return;
    void this.ensureWorkerCountLoaded();

    this.timer = window.setTimeout(() => {
      this.timer = null;
      const rows = (snapshot.results || []).map((item, index) => {
        const id = toResultId(item);
        const row = id ? this.byId.get(id) || null : null;
        return toConsoleRow(index, item, row);
      });
      const workerCountLabel = Number.isFinite(this.workerCount) ? String(this.workerCount) : "unknown";
      console.groupCollapsed(
        `[搜索评分明细] 关键词="${query}" 类型="${snapshot.searchTypeId}" 结果数=${rows.length} WORKER_COUNT=${workerCountLabel}`,
      );
      console.table(rows);
      console.groupEnd();
      this.lastPrintedSignature = signature;
    }, this.debounceMs);
  }
}
