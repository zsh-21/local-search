import { parentPort } from "node:worker_threads";
import { rankCandidatesWithPinyinEngine } from "./pinyinMatchEngine";
import type {
  SearchWorkerInstalledApp,
  SearchWorkerRequest,
  SearchWorkerResponse,
  SearchWorkerRankPayload,
} from "./searchMatchProtocol";

const CANCELLED_SESSION_MAX = 3000;

let appsSnapshot: SearchWorkerInstalledApp[] = [];
const cancelledSessions = new Map<string, number>();

function normalizeSessionId(raw: unknown) {
  return typeof raw === "string" ? raw.trim() : "";
}

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

function markCancelled(sessionId: string) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  cancelledSessions.set(normalized, Date.now());
  trimCancelledSessions();
}

function clearCancelled(sessionId: string) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  cancelledSessions.delete(normalized);
}

function isCancelled(sessionId: string) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return false;
  return cancelledSessions.has(normalized);
}

function reply(resp: SearchWorkerResponse) {
  parentPort?.postMessage(resp);
}

function handleRank(id: number, payload: SearchWorkerRankPayload) {
  const sessionId = normalizeSessionId(payload.sessionId);
  if (sessionId && isCancelled(sessionId)) {
    reply({ id, ok: true, result: { items: [], totalCount: 0, cancelled: true } });
    return;
  }
  const result = rankCandidatesWithPinyinEngine({
    ...payload,
    appsSnapshot,
    shouldCancel: () => Boolean(sessionId && isCancelled(sessionId)),
  });
  if (result.cancelled) {
    reply({ id, ok: true, result: { items: [], totalCount: 0, cancelled: true } });
    return;
  }
  reply({ id, ok: true, result });
}

parentPort?.on("message", (raw: SearchWorkerRequest) => {
  const req: any = raw;
  const id = typeof req?.id === "number" ? req.id : -1;
  try {
    if (req?.op === "syncAppsSnapshot") {
      const apps = Array.isArray(req?.payload?.apps) ? req.payload.apps : [];
      appsSnapshot = apps
        .map((app: SearchWorkerInstalledApp) => ({
          Name: typeof app?.Name === "string" ? app.Name : "",
          AppID: typeof app?.AppID === "string" ? app.AppID : "",
          installTimeMs: Number.isFinite(app?.installTimeMs) ? Number(app.installTimeMs) : 0,
        }))
        .filter((app: SearchWorkerInstalledApp) => app.Name && app.AppID);
      reply({ id, ok: true });
      return;
    }

    if (req?.op === "cancelSession") {
      markCancelled(req?.payload?.sessionId);
      reply({ id, ok: true });
      return;
    }

    if (req?.op === "rankCandidatesFast" || req?.op === "rankCandidatesFull") {
      const payload = req?.payload as SearchWorkerRankPayload;
      clearCancelled(payload?.sessionId);
      handleRank(id, payload);
      return;
    }

    reply({ id, ok: false, error: `Unknown op: ${String(req?.op || "")}` });
  } catch (error: any) {
    reply({ id, ok: false, error: error?.message || "searchMatch worker failed" });
  }
});
