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
  const baseUserData = pickUserDataBase(appDataDir, pkg);
  const userData =
    app.isPackaged || prodMode
      ? baseUserData
      : path.join(baseUserData, "dev");
  app.setPath("userData", userData);

  await app.whenReady();

  const resolvedUserData = app.getPath("userData");
  const keepNames = new Set([
    // clear:cache 只保留用户设置与窗口布局：其余内容（索引/历史/统计/Electron 存储）都清空，确保“所有索引都清空”
    "settings.json",
    "window-config.json",
    "settings-window-config.json",
  ]);

  const entries = listEntries(resolvedUserData);
  const removed = [];
  const failed = [];

  for (const ent of entries) {
    const name = ent.name;
    if (keepNames.has(name)) continue;
    const targetPath = path.join(resolvedUserData, name);
    const r = safeRm(targetPath);
    if (r.ok && r.removed) removed.push(targetPath);
    if (!r.ok) failed.push({ path: targetPath, error: r.error });
  }

  const targetSummary = {
    userData: resolvedUserData,
    dryRun,
    prodMode,
    kept: Array.from(keepNames.values()).map((x) => path.join(resolvedUserData, x)),
    removedCount: removed.length,
    failedCount: failed.length,
  };

  process.stdout.write(`${JSON.stringify(targetSummary, null, 2)}\n`);

  if (failed.length > 0) {
    for (const f of failed.slice(0, 10)) {
      process.stderr.write(`Failed: ${f.path}\n`);
    }
  }

  app.quit();
}

main().catch(() => {
  try {
    app.quit();
  } catch {}
});
