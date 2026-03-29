import { parentPort } from "node:worker_threads";
import { rankCandidatesWithPinyinEngine } from "./pinyinMatchEngine";
import type {
  SearchWorkerInstalledApp,
  SearchWorkerRankPayload,
  SearchWorkerResponse,
} from "./searchMatchProtocol";

/** 取消会话的最大保留数量，用于控制 worker 内部缓存规模。 */
const CANCELLED_SESSION_MAX = 3000;

/** 当前快照中的已安装应用，供排序阶段直接读取。 */
let appsSnapshot: SearchWorkerInstalledApp[] = [];

/** 已取消会话的记录表，键为会话 ID，值为取消时间戳。 */
const cancelledSessions = new Map<string, number>();

/** worker 消息外壳，只保留当前文件需要读取的字段。 */
type SearchWorkerMessage = {
  id?: unknown;
  op?: unknown;
  payload?: unknown;
};

/** 判断未知值是否为普通对象，便于安全读取字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 判断未知值是否为数组，避免退回到不受控的数组类型。 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** 将原始会话 ID 规整为可比较的字符串。 */
function normalizeSessionId(raw: unknown) {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 在取消表过大时清理最旧的会话，控制内存占用。 */
function trimCancelledSessions() {
  if (cancelledSessions.size <= CANCELLED_SESSION_MAX) return;
  const sorted = Array.from(cancelledSessions.entries()).sort((a, b) => a[1] - b[1]);
  const removeCount = cancelledSessions.size - CANCELLED_SESSION_MAX;
  for (let i = 0; i < removeCount; i++) {
    const key = sorted[i]?.[0];
    if (!key) continue;
    cancelledSessions.delete(key);
  }
}

/** 标记某个会话已取消。 */
function markCancelled(sessionId: string) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  cancelledSessions.set(normalized, Date.now());
  trimCancelledSessions();
}

/** 清理某个会话的取消状态。 */
function clearCancelled(sessionId: string) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  cancelledSessions.delete(normalized);
}

/** 判断某个会话当前是否处于取消状态。 */
function isCancelled(sessionId: string) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return false;
  return cancelledSessions.has(normalized);
}

/** 向主线程回传 worker 响应。 */
function reply(resp: SearchWorkerResponse) {
  parentPort?.postMessage(resp);
}

/** 执行候选排序，并在取消时返回统一的空结果。 */
function handleRank(id: number, payload: SearchWorkerRankPayload | undefined) {
  const sessionId = normalizeSessionId(payload?.sessionId);
  if (sessionId && isCancelled(sessionId)) {
    reply({ id, ok: true, result: { items: [], totalCount: 0, cancelled: true } });
    return;
  }

  /** 这里保留原始展开语义，只是把类型显式收窄给编译器。 */
  const rankInput = {
    ...(payload ?? {}),
    appsSnapshot,
    shouldCancel: () => Boolean(sessionId && isCancelled(sessionId)),
  } as SearchWorkerRankPayload & {
    appsSnapshot: SearchWorkerInstalledApp[];
    shouldCancel?: () => boolean;
  };

  const result = rankCandidatesWithPinyinEngine(rankInput);

  if (result.cancelled) {
    reply({ id, ok: true, result: { items: [], totalCount: 0, cancelled: true } });
    return;
  }

  reply({ id, ok: true, result });
}

/** 接收主线程消息时只做最小类型收窄，不改变既有协议分支。 */
parentPort?.on("message", (raw: unknown) => {
  const req: SearchWorkerMessage | null = isRecord(raw) ? raw : null;
  const id = typeof req?.id === "number" ? req.id : -1;

  try {
    if (req?.op === "syncAppsSnapshot") {
      /** 这里仅同步应用快照，保持 worker 侧缓存与主线程一致。 */
      const payload = isRecord(req.payload) ? req.payload : null;
      const apps = isUnknownArray(payload?.apps) ? payload.apps : [];
      appsSnapshot = apps
        .map((app) => {
          const appRecord = isRecord(app) ? app : null;
          const installTimeMs =
            typeof appRecord?.installTimeMs === "number" && Number.isFinite(appRecord.installTimeMs)
              ? Number(appRecord.installTimeMs)
              : 0;
          return {
            Name: typeof appRecord?.Name === "string" ? appRecord.Name : "",
            AppID: typeof appRecord?.AppID === "string" ? appRecord.AppID : "",
            installTimeMs,
          };
        })
        .filter((app) => app.Name && app.AppID);
      reply({ id, ok: true });
      return;
    }

    if (req?.op === "cancelSession") {
      /** 取消会话只记录会话 ID，不改变既有 IPC 协议。 */
      const payload = isRecord(req.payload) ? req.payload : null;
      markCancelled(typeof payload?.sessionId === "string" ? payload.sessionId : "");
      reply({ id, ok: true });
      return;
    }

    if (req?.op === "rankCandidatesFast" || req?.op === "rankCandidatesFull") {
      /** 快速和完整两条排序分支保持同一处理路径。 */
      const payload = isRecord(req.payload) ? (req.payload as SearchWorkerRankPayload) : undefined;
      clearCancelled(typeof payload?.sessionId === "string" ? payload.sessionId : "");
      handleRank(id, payload);
      return;
    }

    reply({ id, ok: false, error: `Unknown op: ${String(req?.op || "")}` });
  } catch (error: unknown) {
    reply({ id, ok: false, error: error instanceof Error ? error.message : "searchMatch worker failed" });
  }
});
