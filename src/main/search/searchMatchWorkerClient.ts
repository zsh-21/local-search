import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  SearchWorkerInstalledApp,
  SearchWorkerRankPayload,
  SearchWorkerRankResult,
  SearchWorkerResponse,
} from "./searchMatchProtocol";

/** 待完成请求的回调包装，统一保存 resolve 与 reject。 */
type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** 当前 worker 实例，采用懒创建方式管理。 */
let worker: Worker | null = null;

/** 请求序号，用于把响应和调用方一一对应起来。 */
let seq = 0;

/** 待完成请求表，键为请求 ID，值为对应回调。 */
const pending = new Map<number, PendingResolver>();

/** 统一拼接 worker 文件路径，避免散落魔法字符串。 */
function getWorkerPath() {
  return path.join(__dirname, "searchMatch.worker.js");
}

/** 确保 worker 只在需要时创建一次。 */
function ensureWorker() {
  if (worker) return worker;

  worker = new Worker(getWorkerPath());
  worker.on("message", (resp: SearchWorkerResponse) => {
    const id = typeof resp?.id === "number" ? resp.id : -1;
    const waiter = pending.get(id);
    if (!waiter) return;

    pending.delete(id);
    if (resp.ok) {
      waiter.resolve(resp.result);
      return;
    }

    waiter.reject(new Error(resp.error || "search worker call failed"));
  });

  worker.on("error", (error) => {
    for (const [, waiter] of pending) waiter.reject(error);
    pending.clear();
    worker = null;
  });

  worker.on("exit", () => {
    for (const [, waiter] of pending) waiter.reject(new Error("search worker exited"));
    pending.clear();
    worker = null;
  });

  return worker;
}

/** 发送消息到 worker，并将结果以泛型方式返回给调用方。 */
function callWorker<T = unknown>(op: string, payload: unknown): Promise<T> {
  const w = ensureWorker();
  const id = ++seq;

  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });

    try {
      w.postMessage({ id, op, payload });
    } catch (error: unknown) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error("postMessage failed"));
    }
  });
}

/** 同步安装应用快照，保持 worker 侧缓存与主线程一致。 */
export async function syncSearchWorkerAppsSnapshot(apps: SearchWorkerInstalledApp[]) {
  const safeApps = Array.isArray(apps) ? apps : [];
  await callWorker("syncAppsSnapshot", { apps: safeApps });
}

/** 执行快速分支的候选排序。 */
export async function rankCandidatesFast(payload: SearchWorkerRankPayload) {
  const result = await callWorker<SearchWorkerRankResult>("rankCandidatesFast", payload);
  return result || { items: [], totalCount: 0 };
}

/** 执行完整分支的候选排序。 */
export async function rankCandidatesFull(payload: SearchWorkerRankPayload) {
  const result = await callWorker<SearchWorkerRankResult>("rankCandidatesFull", payload);
  return result || { items: [], totalCount: 0 };
}

/** 取消指定会话在 worker 内的未完成任务。 */
export async function cancelSearchWorkerSession(sessionId: string) {
  const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalized) return;

  try {
    await callWorker("cancelSession", { sessionId: normalized });
  } catch {}
}
