import path from "node:path";
import { existsSync } from "node:fs";

export type WatcherAction =
  | { kind: "ingestPath"; path: string }
  | { kind: "removePath"; path: string }
  | { kind: "rescanParent"; path: string };

type ReducerState = {
  path: string;
  parent: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  sawRename: boolean;
  sawChange: boolean;
  lastEventType: string;
};

export type WatcherReducerOptions = {
  windowMs?: number;
  parentStormThreshold?: number;
};

export type WatcherReducerFlushResult = {
  rawEventCount: number;
  reducedActionCount: number;
  actions: WatcherAction[];
};

function normalizePath(input: string) {
  if (typeof input !== "string") return "";
  const normalized = input.trim().replace(/\//g, "\\").replace(/\\+/g, "\\");
  return normalized;
}

function actionKey(action: WatcherAction) {
  return `${action.kind}:${action.path.trim().toLowerCase()}`;
}

export function createWatcherEventReducer(options?: WatcherReducerOptions) {
  const windowMs = Math.max(80, Math.floor(Number(options?.windowMs) || 250));
  const parentStormThreshold = Math.max(8, Math.floor(Number(options?.parentStormThreshold) || 40));
  const states = new Map<string, ReducerState>();
  let rawEventCount = 0;

  const enqueue = (eventType: string, fullPath: string) => {
    const normalized = normalizePath(fullPath);
    if (!normalized) return;

    const now = Date.now();
    rawEventCount += 1;
    const key = normalized.toLowerCase();
    const parent = path.dirname(normalized);
    const existing = states.get(key);
    if (!existing) {
      states.set(key, {
        path: normalized,
        parent,
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
        sawRename: eventType === "rename",
        sawChange: eventType === "change",
        lastEventType: eventType,
      });
      return;
    }

    existing.lastSeenAt = now;
    existing.count += 1;
    existing.lastEventType = eventType;
    if (eventType === "rename") existing.sawRename = true;
    if (eventType === "change") existing.sawChange = true;
  };

  const flush = (): WatcherReducerFlushResult => {
    if (states.size <= 0 && rawEventCount <= 0) {
      return { rawEventCount: 0, reducedActionCount: 0, actions: [] };
    }

    const parentEventCounts = new Map<string, number>();
    for (const state of states.values()) {
      parentEventCounts.set(state.parent, (parentEventCounts.get(state.parent) || 0) + state.count);
    }

    const actionSet = new Set<string>();
    const actions: WatcherAction[] = [];
    const pushAction = (action: WatcherAction) => {
      if (!action.path) return;
      const key = actionKey(action);
      if (actionSet.has(key)) return;
      actionSet.add(key);
      actions.push(action);
    };

    for (const state of states.values()) {
      const parentEvents = parentEventCounts.get(state.parent) || 0;
      const shouldRescanParent = parentEvents >= parentStormThreshold || state.count >= parentStormThreshold;
      if (shouldRescanParent) {
        pushAction({ kind: "rescanParent", path: state.parent });
        continue;
      }

      const targetExists = existsSync(state.path);
      if (targetExists) {
        pushAction({ kind: "ingestPath", path: state.path });
        continue;
      }
      if (state.sawRename || state.lastEventType === "rename") {
        pushAction({ kind: "removePath", path: state.path });
      } else {
        pushAction({ kind: "ingestPath", path: state.path });
      }
    }

    const result = {
      rawEventCount,
      reducedActionCount: actions.length,
      actions,
    };

    states.clear();
    rawEventCount = 0;
    return result;
  };

  return {
    windowMs,
    enqueue,
    flush,
    hasPending: () => states.size > 0,
  };
}

