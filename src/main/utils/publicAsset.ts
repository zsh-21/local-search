import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

/** 解析公共资源文件路径，兼容开发态和打包态 */
export function resolvePublicAssetPath(fileName: string) {
  /** 目标文件名 */
  const targetName = String(fileName || "").trim();
  if (!targetName) return "";

  /** 候选绝对路径列表 */
  const candidates: string[] = [];

  /** 追加一个基础目录的候选路径 */
  const pushBaseDir = (baseDir: string) => {
    if (!baseDir) return;
    candidates.push(path.join(baseDir, targetName));
    candidates.push(path.join(baseDir, "public", targetName));
    candidates.push(path.join(baseDir, "dist", targetName));
  };

  try {
    const vitePublic = String(process.env.VITE_PUBLIC || "").trim();
    if (vitePublic) pushBaseDir(vitePublic);
  } catch {}
  try {
    const distDir = String(process.env.DIST || "").trim();
    if (distDir) pushBaseDir(distDir);
  } catch {}
  try {
    const cwd = process.cwd();
    if (cwd) pushBaseDir(cwd);
  } catch {}
  try {
    const appPath = app.getAppPath();
    if (appPath) {
      pushBaseDir(appPath);
      pushBaseDir(path.join(appPath, ".."));
    }
  } catch {}
  try {
    const resourcesPath = String(process.resourcesPath || "").trim();
    if (resourcesPath) pushBaseDir(resourcesPath);
  } catch {}

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  /** 兜底保持旧逻辑 */
  return path.join(process.env.VITE_PUBLIC || "", targetName);
}
