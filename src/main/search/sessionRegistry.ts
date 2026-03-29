const activeSessionByWindow = new Map<number, string>();
const cancelledSessions = new Map<string, number>();
const cleanupBoundWindowIds = new Set<number>();
const CANCELLED_SESSION_MAX = 2000;

function normalizeSessionId(raw: string) {
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

export function beginSearchSession(input: {
  event: Electron.IpcMainInvokeEvent;
  sessionId: string;
  cancelSearchSession?: (sessionId: string) => void;
}) {
  const webContentsId = input.event.sender.id;
  if (!cleanupBoundWindowIds.has(webContentsId)) {
    cleanupBoundWindowIds.add(webContentsId);
    input.event.sender.once("destroyed", () => {
      activeSessionByWindow.delete(webContentsId);
      cleanupBoundWindowIds.delete(webContentsId);
    });
  }

  const sessionId = normalizeSessionId(input.sessionId);
  if (!sessionId) {
    return {
      sessionId,
      webContentsId,
      previousSessionId: "",
      isCancelled: () => true,
      finish: () => {},
    };
  }

  cancelledSessions.delete(sessionId);
  const previousSessionId = activeSessionByWindow.get(webContentsId) || "";
  if (previousSessionId && previousSessionId !== sessionId) {
    markCancelled(previousSessionId);
    input.cancelSearchSession?.(previousSessionId);
  }
  activeSessionByWindow.set(webContentsId, sessionId);

  const isCancelled = () => {
    if (!sessionId) return true;
    if (cancelledSessions.has(sessionId)) return true;
    if (input.event.sender.isDestroyed()) return true;
    return activeSessionByWindow.get(webContentsId) !== sessionId;
  };

  const finish = () => {
    if (activeSessionByWindow.get(webContentsId) === sessionId) {
      activeSessionByWindow.delete(webContentsId);
    }
  };

  return {
    sessionId,
    webContentsId,
    previousSessionId,
    isCancelled,
    finish,
  };
}

export function cancelSessionById(sessionId: string, cancelSearchSession?: (sessionId: string) => void) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return;
  markCancelled(normalized);
  cancelSearchSession?.(normalized);
}
