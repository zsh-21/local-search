import type { WatcherAction } from "./watcherEventReducer";

type WatcherActionHandlers = {
  ingestPath: (targetPath: string) => Promise<void>;
  removePath: (targetPath: string) => Promise<void>;
  rescanParent: (targetPath: string) => Promise<void>;
};

function normalizeActionKey(action: WatcherAction) {
  return `${action.kind}:${String(action.path || "").trim().toLowerCase()}`;
}

export class WatcherActionQueue {
  private readonly maxInFlight: number;
  private readonly handlers: WatcherActionHandlers;
  private readonly backlog: WatcherAction[] = [];
  private readonly backlogSet = new Set<string>();
  private inFlight = 0;

  constructor(maxInFlight: number, handlers: WatcherActionHandlers) {
    this.maxInFlight = Math.max(1, Math.floor(Number(maxInFlight) || 1));
    this.handlers = handlers;
  }

  enqueueMany(actions: WatcherAction[]) {
    for (const action of actions) {
      this.enqueue(action);
    }
    this.drain();
  }

  getBacklogSize() {
    return this.backlog.length;
  }

  clear() {
    this.backlog.length = 0;
    this.backlogSet.clear();
  }

  private enqueue(action: WatcherAction) {
    if (!action?.path) return;
    const key = normalizeActionKey(action);
    if (!key || this.backlogSet.has(key)) return;
    this.backlogSet.add(key);
    this.backlog.push(action);
  }

  private drain() {
    while (this.inFlight < this.maxInFlight && this.backlog.length > 0) {
      const action = this.backlog.shift();
      if (!action) break;

      const key = normalizeActionKey(action);
      this.backlogSet.delete(key);
      this.inFlight += 1;
      void this.execute(action).finally(() => {
        this.inFlight -= 1;
        this.drain();
      });
    }
  }

  private async execute(action: WatcherAction) {
    try {
      if (action.kind === "ingestPath") {
        await this.handlers.ingestPath(action.path);
        return;
      }
      if (action.kind === "removePath") {
        await this.handlers.removePath(action.path);
        return;
      }
      if (action.kind === "rescanParent") {
        await this.handlers.rescanParent(action.path);
      }
    } catch {
    }
  }
}

