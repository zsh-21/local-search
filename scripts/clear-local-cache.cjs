const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prodMode = args.includes("--prod");

// userData 下的关键落盘文件名：
// 这里需要与 electron/constants/storagePaths.ts 的 USER_DATA_FILENAMES 保持一致，避免出现“脚本清理”和“应用内清理”不一致
const USER_DATA_FILENAMES = {
  windowConfig: "window-config.json",
  settingsWindowConfig: "settings-window-config.json",
  settings: "settings.json",
  deviceId: "device-id.json",
  history: "history.json",
  historyStats: "history-stats.json",
  installedApps: "installed-apps.json",
  fileIndex: "file-index.txt",
  fileIndexMeta: "file-index-meta.json",
};

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

function existsFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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
    if (
      // 通过关键落盘文件“猜测”正确的 userData 目录：避免误删其他应用的数据
      existsFile(path.join(devDir, USER_DATA_FILENAMES.settings)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.windowConfig)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.settingsWindowConfig)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.fileIndex)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.fileIndexMeta)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.history)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.historyStats)) ||
      existsFile(path.join(devDir, USER_DATA_FILENAMES.installedApps))
    ) {
      return base;
    }
  }

  return baseCandidates[0] || path.join(appDataDir, "file-search");
}

async function main() {
  const pkg = readProjectPackageJson();
  const appDataDir = app.getPath("appData");
  
  // 1. 计算真实的目标 userData 目录
  const baseUserData = pickUserDataBase(appDataDir, pkg);
  const targetUserData =
    app.isPackaged || prodMode
      ? baseUserData
      : path.join(baseUserData, "dev");

  // 2. 将当前 Electron 进程的 userData 指向一个临时目录，避免锁定目标目录
  const tempUserData = path.join(app.getPath("temp"), `file-search-cleanup-${Date.now()}`);
  app.setPath("userData", tempUserData);

  await app.whenReady();

  // 3. 执行清理逻辑
  const resolvedUserData = targetUserData; // 使用计算出的目标路径，而不是 app.getPath("userData")
  console.log(`Target userData: ${resolvedUserData}`);

  if (!fs.existsSync(resolvedUserData)) {
    console.log("Target userData does not exist, nothing to clear.");
    app.quit();
    return;
  }
  // clear:cache 清空所有配置/索引/缓存：用于一键恢复到“全新安装”的状态
  const keepNames = new Set([]);

  const entries = listEntries(resolvedUserData);
  const removed = [];
  const failed = [];
  
  // 关键文件列表，用于向用户报告状态
  const keyFiles = [
    USER_DATA_FILENAMES.fileIndex,
    USER_DATA_FILENAMES.fileIndexMeta,
    USER_DATA_FILENAMES.history,
    USER_DATA_FILENAMES.historyStats,
    USER_DATA_FILENAMES.installedApps,
    USER_DATA_FILENAMES.deviceId,
    USER_DATA_FILENAMES.settings,
    USER_DATA_FILENAMES.windowConfig,
    USER_DATA_FILENAMES.settingsWindowConfig,
  ];
  const keyFilesStatus = {};

  for (const ent of entries) {
    const name = ent.name;
    if (keepNames.has(name)) continue;
    
    const targetPath = path.join(resolvedUserData, name);
    const isKeyFile = keyFiles.includes(name);
    
    const r = safeRm(targetPath);
    if (r.ok && r.removed) {
      removed.push(targetPath);
      if (isKeyFile) keyFilesStatus[name] = "Removed";
    } else if (!r.ok) {
      failed.push({ path: targetPath, error: r.error });
      if (isKeyFile) keyFilesStatus[name] = "Failed to remove";
    } else {
      // 文件不存在
      if (isKeyFile) keyFilesStatus[name] = "Not found (already clean)";
    }
  }

  // 补全未找到的关键文件状态
  for (const f of keyFiles) {
    if (!keyFilesStatus[f]) keyFilesStatus[f] = "Not found (already clean)";
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

  // 清理临时目录
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
