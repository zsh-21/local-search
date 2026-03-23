const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prodMode = args.includes("--prod");

// 这里与 electron/constants/storagePaths.ts 的 USER_DATA_FILENAMES 保持一致，避免脚本与应用内清理行为不一致。
const USER_DATA_FILENAMES = {
  windowConfig: "window-config.json",
  settingsWindowConfig: "settings-window-config.json",
  settings: "settings.json",
  deviceId: "device-id.json",
  history: "history.json",
  calcHistory: "calc-history.json",
  historyStats: "history-stats.json",
  installedApps: "installed-apps.json",
  appIconCache: "app-icon-cache.json",
  fileIndex: "file-index.txt",
  fileIndexMeta: "file-index-meta.json",
  indexStats: "file-index-stats.json",
};

const KEY_FILE_PATTERNS = [
  {
    key: "file-index-*.txt",
    // 分片索引文件按模式统计，避免 Worker 数变化后残留旧分片。
    test: (name) => /^file-index-\d+\.txt$/i.test(name),
  },
  {
    key: "file-index-*.txt.tmp",
    // 分片临时文件也按模式统计，防止中断后 tmp 残留影响后续索引。
    test: (name) => /^file-index-\d+\.txt\.tmp$/i.test(name),
  },
  {
    key: "file-index.txt.tmp",
    test: (name) => /^file-index\.txt\.tmp$/i.test(name),
  },
];

function readProjectPackageJson() {
  try {
    const root = path.resolve(__dirname, "..");
    const pkgPath = path.join(root, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeRm(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return { ok: true, removed: false };
    if (dryRun) return { ok: true, removed: true };
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, removed: false, error: e };
  }
}

function listEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function hasLikelyUserDataFiles(targetDir) {
  if (!targetDir || !fs.existsSync(targetDir)) return false;
  const entries = listEntries(targetDir);
  if (!entries.length) return false;

  const entryNames = new Set(entries.map((ent) => ent.name));
  const fixedFiles = [
    USER_DATA_FILENAMES.settings,
    USER_DATA_FILENAMES.windowConfig,
    USER_DATA_FILENAMES.settingsWindowConfig,
    USER_DATA_FILENAMES.fileIndex,
    USER_DATA_FILENAMES.fileIndexMeta,
    USER_DATA_FILENAMES.indexStats,
    USER_DATA_FILENAMES.history,
    USER_DATA_FILENAMES.calcHistory,
    USER_DATA_FILENAMES.historyStats,
    USER_DATA_FILENAMES.installedApps,
    USER_DATA_FILENAMES.appIconCache,
  ];

  if (fixedFiles.some((name) => entryNames.has(name))) return true;

  // 兜底检查分片索引模式，避免只剩分片时误判为“未找到 userData”。
  return entries.some((ent) => KEY_FILE_PATTERNS.some((rule) => rule.test(ent.name)));
}

function pickUserDataBase(appDataDir, pkg) {
  const nameCandidates = [
    typeof pkg?.name === "string" ? pkg.name : "",
    typeof pkg?.build?.productName === "string" ? pkg.build.productName : "",
    typeof app.getName === "function" ? app.getName() : "",
  ]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x);

  const baseCandidates = Array.from(new Set(nameCandidates)).map((n) => path.join(appDataDir, n));
  for (const base of baseCandidates) {
    const devDir = path.join(base, "dev");
    // 通过固定文件 + 分片模式双重判断 userData，避免误清理到无关目录。
    if (hasLikelyUserDataFiles(devDir) || hasLikelyUserDataFiles(base)) return base;
  }

  return baseCandidates[0] || path.join(appDataDir, "file-search");
}

function initPatternStats() {
  return new Map(KEY_FILE_PATTERNS.map((rule) => [rule.key, { found: 0, removed: 0, failed: 0 }]));
}

async function main() {
  const pkg = readProjectPackageJson();
  const appDataDir = app.getPath("appData");

  // 1) 计算目标 userData 目录。
  const baseUserData = pickUserDataBase(appDataDir, pkg);
  const targetUserData = app.isPackaged || prodMode ? baseUserData : path.join(baseUserData, "dev");

  // 2) 将当前 Electron 进程 userData 指向临时目录，避免锁定目标目录。
  const tempUserData = path.join(app.getPath("temp"), `file-search-cleanup-${Date.now()}`);
  app.setPath("userData", tempUserData);

  await app.whenReady();

  const resolvedUserData = targetUserData;
  console.log(`Target userData: ${resolvedUserData}`);

  if (!fs.existsSync(resolvedUserData)) {
    console.log("Target userData does not exist, nothing to clear.");
    app.quit();
    return;
  }

  // clear:cache 语义为“全量清理缓存/索引/配置”，因此默认不保留任何子项。
  const keepNames = new Set([]);

  const entries = listEntries(resolvedUserData);
  const removed = [];
  const failed = [];

  const keyFiles = [
    USER_DATA_FILENAMES.fileIndex,
    USER_DATA_FILENAMES.fileIndexMeta,
    USER_DATA_FILENAMES.indexStats,
    USER_DATA_FILENAMES.history,
    USER_DATA_FILENAMES.calcHistory,
    USER_DATA_FILENAMES.historyStats,
    USER_DATA_FILENAMES.installedApps,
    USER_DATA_FILENAMES.appIconCache,
    USER_DATA_FILENAMES.deviceId,
    USER_DATA_FILENAMES.settings,
    USER_DATA_FILENAMES.windowConfig,
    USER_DATA_FILENAMES.settingsWindowConfig,
  ];
  const keyFilesStatus = {};
  const keyPatternStats = initPatternStats();

  for (const ent of entries) {
    const name = ent.name;
    if (keepNames.has(name)) continue;

    const targetPath = path.join(resolvedUserData, name);
    const isKeyFile = keyFiles.includes(name);
    const matchedPatterns = KEY_FILE_PATTERNS.filter((rule) => rule.test(name));

    for (const rule of matchedPatterns) {
      const stat = keyPatternStats.get(rule.key);
      if (stat) stat.found += 1;
    }

    const r = safeRm(targetPath);
    if (r.ok && r.removed) {
      removed.push(targetPath);
      if (isKeyFile) keyFilesStatus[name] = "Removed";
      for (const rule of matchedPatterns) {
        const stat = keyPatternStats.get(rule.key);
        if (stat) stat.removed += 1;
      }
      continue;
    }

    if (!r.ok) {
      failed.push({ path: targetPath, error: r.error });
      if (isKeyFile) keyFilesStatus[name] = "Failed to remove";
      for (const rule of matchedPatterns) {
        const stat = keyPatternStats.get(rule.key);
        if (stat) stat.failed += 1;
      }
      continue;
    }

    if (isKeyFile) keyFilesStatus[name] = "Not found (already clean)";
  }

  for (const f of keyFiles) {
    if (!keyFilesStatus[f]) keyFilesStatus[f] = "Not found (already clean)";
  }

  // 以模式补充分片索引清理结果，确认 file-index-*.txt 系列是否真正被清空。
  for (const [patternKey, stat] of keyPatternStats.entries()) {
    if (stat.found === 0) {
      keyFilesStatus[patternKey] = "Not found (already clean)";
      continue;
    }
    if (stat.failed > 0) {
      keyFilesStatus[patternKey] = `Failed to remove (${stat.failed}/${stat.found})`;
      continue;
    }
    keyFilesStatus[patternKey] = `Removed (${stat.removed}/${stat.found})`;
  }

  const targetSummary = {
    userData: resolvedUserData,
    dryRun,
    prodMode,
    kept: Array.from(keepNames.values()).map((x) => path.join(resolvedUserData, x)),
    keyFilesStatus,
    removedCount: removed.length,
    failedCount: failed.length,
  };

  process.stdout.write(`${JSON.stringify(targetSummary, null, 2)}\n`);

  if (failed.length > 0) {
    console.log("\nSome files could not be removed (likely locked by running app):");
    for (const f of failed.slice(0, 10)) {
      console.log(`- ${path.basename(f.path)}`);
    }
    if (failed.length > 10) console.log(`... and ${failed.length - 10} more.`);
    console.log("\nIf you want to clear everything, please close the application and run this command again.");
  } else {
    console.log("\nAll cache files cleared successfully.");
  }

  try {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  } catch {}

  app.quit();
}

main().catch(() => {
  try {
    app.quit();
  } catch {}
});
