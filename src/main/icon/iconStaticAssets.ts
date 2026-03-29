import { app } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 图片扩展名集合 */
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);

/** 图片文件转 dataUrl 的最大体积限制 */
const IMAGE_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/** 通用文件兜底 SVG */
const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none"><rect x="12" y="6" width="40" height="52" rx="6" stroke="#94a3b8" stroke-width="4"/><path d="M36 6v16h16" stroke="#94a3b8" stroke-width="4"/></svg>`;

/** 通用文件兜底 dataUrl */
export const FALLBACK_SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(FALLBACK_SVG).toString("base64")}`;

/** 预置图标目录 */
const BUNDLED_ICON_DIR = (() => {
  /** 候选目录列表 */
  const candidates: string[] = [];
  /** 按目录追加候选 */
  const pushAssetDir = (baseDir: string) => {
    if (!baseDir) return;
    candidates.push(path.join(baseDir, "public"));
    candidates.push(path.join(baseDir, "dist"));
    candidates.push(baseDir);
  };
  try {
    /** Vite 公共资源目录 */
    const vitePublic = String(process.env.VITE_PUBLIC || "").trim();
    if (vitePublic) pushAssetDir(vitePublic);
  } catch {}
  try {
    /** 主进程渲染产物目录 */
    const distDir = String(process.env.DIST || "").trim();
    if (distDir) pushAssetDir(distDir);
  } catch {}
  try {
    /** 当前工作目录 */
    const cwd = process.cwd();
    if (cwd) pushAssetDir(cwd);
  } catch {}
  try {
    /** 应用路径 */
    const appPath = app.getAppPath();
    if (appPath) {
      pushAssetDir(appPath);
      pushAssetDir(path.join(appPath, ".."));
    }
  } catch {}
  try {
    /** Electron 资源目录 */
    const resourcesPath = String(process.resourcesPath || "").trim();
    if (resourcesPath) pushAssetDir(resourcesPath);
  } catch {}
  for (const dir of candidates) {
    /** 图标子目录 */
    const iconDir = path.join(dir, "file-icons");
    if (existsSync(iconDir)) return iconDir;
  }
  return "";
})();

/** 预置图标 dataUrl 缓存 */
const bundledIconDataCache = new Map<string, string>();

/** 扩展名到预置图标映射 */
const EXT_ICON_MAP: Record<string, string> = {
  ".doc": "file-text.svg",
  ".docx": "file-text.svg",
  ".xls": "file-spreadsheet.svg",
  ".xlsx": "file-spreadsheet.svg",
  ".ppt": "file-text.svg",
  ".pptx": "file-text.svg",
  ".pdf": "file-text.svg",
  ".txt": "file-text.svg",
  ".md": "file-text.svg",
  ".rtf": "file-text.svg",
  ".jpg": "file-image.svg",
  ".jpeg": "file-image.svg",
  ".png": "file-image.svg",
  ".gif": "file-image.svg",
  ".bmp": "file-image.svg",
  ".webp": "file-image.svg",
  ".svg": "file-image.svg",
  ".ico": "file-image.svg",
  ".mp3": "file.svg",
  ".mp4": "file.svg",
  ".avi": "file.svg",
  ".mkv": "file.svg",
  ".zip": "file-archive.svg",
  ".rar": "file-archive.svg",
  ".7z": "file-archive.svg",
  ".iso": "file-archive.svg",
  ".exe": "binary.svg",
  ".msi": "package.svg",
  ".apk": "package.svg",
  ".dmg": "package.svg",
  ".html": "file-code.svg",
  ".htm": "file-code.svg",
  ".css": "file-code.svg",
  ".js": "file-code.svg",
  ".ts": "file-code.svg",
  ".vue": "file-code.svg",
  ".jsx": "file-code.svg",
  ".tsx": "file-code.svg",
  ".json": "file-code.svg",
  ".py": "file-code.svg",
  ".java": "file-code.svg",
  ".c": "file-code.svg",
  ".cpp": "file-code.svg",
  ".go": "file-code.svg",
  ".php": "file-code.svg",
  ".rb": "file-code.svg",
  ".sh": "file-code.svg",
  ".bat": "file-code.svg",
  ".sql": "file-code.svg",
  ".xml": "file-cog.svg",
  ".yml": "file-cog.svg",
  ".yaml": "file-cog.svg",
  ".ini": "file-cog.svg",
  ".log": "file-text.svg",
  ".dll": "binary.svg",
  ".gitignore": "file-cog.svg",
  ".msc": "file-cog.svg",
};

/** 按图标文件名读取预置图标 dataUrl */
export function getBundledIconDataByName(name: string) {
  if (!name || !BUNDLED_ICON_DIR) return "";
  /** 缓存键 */
  const key = name.toLowerCase();
  /** 缓存值 */
  const cached = bundledIconDataCache.get(key);
  if (cached) return cached;
  /** 图标绝对路径 */
  const fullPath = path.join(BUNDLED_ICON_DIR, name);
  if (!existsSync(fullPath)) return "";
  try {
    /** 文件内容 */
    const buf = readFileSync(fullPath);
    /** 图标 dataUrl */
    const dataUrl = `data:image/svg+xml;base64,${buf.toString("base64")}`;
    bundledIconDataCache.set(key, dataUrl);
    return dataUrl;
  } catch {
    return "";
  }
}

/** 按文件路径选择预置图标 */
export function getBundledIconForPath(filePath: string) {
  if (!filePath) return "";
  try {
    if (existsSync(filePath)) {
      /** 文件状态 */
      const st = statSync(filePath);
      if (st.isDirectory()) return getBundledIconDataByName("folder.svg");
    }
  } catch {}
  /** 文件扩展名 */
  const ext = path.extname(filePath).toLowerCase();
  /** 图标文件名 */
  const iconName = EXT_ICON_MAP[ext] || "file.svg";
  return getBundledIconDataByName(iconName);
}

/** 按扩展名选择预置图标 */
export function getBundledIconForExtension(ext: string) {
  /** 归一化扩展名 */
  const normalizedExt = String(ext || "").toLowerCase();
  /** 图标文件名 */
  const iconName = EXT_ICON_MAP[normalizedExt] || "file.svg";
  return getBundledIconDataByName(iconName);
}

/** 默认目录图标 */
export function getDefaultFolderIconData() {
  return getBundledIconDataByName("folder.svg");
}

/** 默认命令图标 */
export function getDefaultCommandIconData() {
  return getBundledIconDataByName("command.svg") || getBundledIconDataByName("file-cog.svg") || getBundledIconDataByName("file.svg");
}

/** 默认设置图标 */
export function getDefaultSettingsIconData() {
  return getBundledIconDataByName("settings.svg") || getBundledIconDataByName("file-cog.svg") || getBundledIconDataByName("file.svg");
}

/** 根据扩展名获取图片 MIME */
function getImageMimeByExt(ext: string) {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/** 将图片文件构造成 dataUrl（大小受限） */
export function buildImageDataUrl(filePath: string, ext: string) {
  try {
    /** 文件状态 */
    const st = statSync(filePath);
    if (!Number.isFinite(st.size) || st.size <= 0) return "";
    if (st.size > IMAGE_FALLBACK_MAX_BYTES) return "";
    /** 文件内容 */
    const buf = readFileSync(filePath);
    /** MIME 类型 */
    const mime = getImageMimeByExt(ext);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}
