export async function searchApps(input: {
  searchTypeId: string;
  getInstalledApps: () => Array<{ Name: string; AppID: string; installTimeMs?: number }>;
}) {
  const { searchTypeId, getInstalledApps } = input;
  if (searchTypeId !== "all" && searchTypeId !== "app") return [];

  const out: Array<{
    name: string;
    path: string;
    type: string;
    timeMs: number;
    source: string;
    rawSource: string;
    sourceScore: number;
  }> = [];

  const apps = getInstalledApps();
  for (const app of apps) {
    const appId = typeof app?.AppID === "string" ? app.AppID.trim() : "";
    const appName = typeof app?.Name === "string" ? app.Name.trim() : "";
    if (!appId || !appName) continue;
    const lower = appId.toLowerCase();
    if (lower.endsWith(".lnk") || lower.endsWith(".url")) continue;

    const installTimeMs = Number(app?.installTimeMs || 0);
    out.push({
      name: appName,
      path: appId,
      type: "app",
      timeMs: Number.isFinite(installTimeMs) && installTimeMs > 0 ? Math.round(installTimeMs) : 0,
      source: "apps",
      rawSource: "apps",
      sourceScore: 100,
    });
  }

  return out;
}
