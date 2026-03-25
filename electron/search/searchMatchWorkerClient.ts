import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  SearchWorkerInstalledApp,
  SearchWorkerRankPayload,
  SearchWorkerRankResult,
  SearchWorkerResponse,
} from "./searchMatchProtocol";

type PendingResolver = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, PendingResolver>();

function getWorkerPath() {
  return path.join(__dirname, "searchMatch.worker.js");
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(getWorkerPath());
  worker.on("message", (resp: SearchWorkerResponse) => {
    const id = typeof resp?.id === "number" ? resp.id : -1;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if ((resp as any)?.ok) {
      waiter.resolve((resp as any).result);
      return;
    }
    waiter.reject(new Error(typeof (resp as any)?.error === "string" ? (resp as any).error : "search worker call failed"));
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

function callWorker<T = any>(op: string, payload: any): Promise<T> {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, op, payload });
    } catch (error: any) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(error?.message || "postMessage failed"));
    }
  });
}

export async function syncSearchWorkerAppsSnapshot(apps: SearchWorkerInstalledApp[]) {
  const safeApps = Array.isArray(apps) ? apps : [];
  await callWorker("syncAppsSnapshot", { apps: safeApps });
}

export async function rankCandidatesFast(payload: SearchWorkerRankPayload) {
  const result = await callWorker<SearchWorkerRankResult>("rankCandidatesFast", payload);
  return result || { items: [], totalCount: 0 };
}

export async function rankCandidatesFull(payload: SearchWorkerRankPayload) {
  const result = await callWorker<SearchWorkerRankResult>("rankCandidatesFull", payload);
  return result || { items: [], totalCount: 0 };
}

export async function cancelSearchWorkerSession(sessionId: string) {
  const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalized) return;
  try {
    await callWorker("cancelSession", { sessionId: normalized });
  } catch {}
}

