const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const prodMode = args.includes("--prod");

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
      existsFile(path.join(devDir, "settings.json")) ||
      existsFile(path.join(devDir, "window-config.json")) ||
      existsFile(path.join(devDir, "settings-window-config.json"))
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
  const keepNames = new Set([
    // clear:cache 只保留用户设置与窗口布局：其余内容（索引/历史/统计/Electron 存储）都清空，确保“所有索引都清空”
    "settings.json",
    "window-config.json",
    "settings-window-config.json",
  ]);

  const entries = listEntries(resolvedUserData);
  const removed = [];
  const failed = [];
  
  // 关键文件列表，用于向用户报告状态
  const keyFiles = [
    "file-index.txt",
    "file-index-meta.json", 
    "history.json",
    "history-stats.json"
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
