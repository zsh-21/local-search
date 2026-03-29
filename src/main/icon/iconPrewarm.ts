type PrewarmDeps = {
  iconDataCache: Map<string, string>;
  isTooSmallAppIconDataUrl: (value: string) => boolean;
  getAppIconDataStable: (appName: string, appId: string, maxAttempts?: number) => Promise<string>;
};

export async function prewarmInstalledAppIconsCore(
  items: Array<{ Name: string; AppID: string }>,
  options: { maxCount?: number; concurrency?: number } | undefined,
  deps: PrewarmDeps,
) {
  const maxCount = Math.max(0, Math.min(1200, Number(options?.maxCount) || 360));
  const concurrency = Math.max(1, Math.min(6, Number(options?.concurrency) || 3));
  if (!Array.isArray(items) || items.length === 0 || maxCount <= 0) return;
  const queue = items
    .filter((it) => typeof it?.Name === "string" && typeof it?.AppID === "string")
    .slice(0, maxCount);
  if (queue.length === 0) return;

  const worker = async () => {
    while (queue.length > 0) {
      const it = queue.shift();
      if (!it) return;
      const key = `app:${it.AppID}`;
      const cached = deps.iconDataCache.get(key) || "";
      if (cached && !deps.isTooSmallAppIconDataUrl(cached)) continue;
      try {
        await deps.getAppIconDataStable(it.Name, it.AppID, 2);
      } catch {}
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
