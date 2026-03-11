import { app } from "electron";
import path from "node:path";

// 这里集中维护“主进程运行过程中产生的落盘文件路径”：
// - 主要落在 app.getPath('userData') 下（配置、索引、缓存、历史等）
// - 统一在这里改文件名/路径，避免散落在多个模块里导致改动遗漏
// - 注意：开发环境下 userData 可能会在 ./config/settings.ts 里被重定向到 userData/dev

// userData 下各类文件的文件名（统一入口，便于你做重命名/迁移）
export const USER_DATA_FILENAMES = {
  // 窗口位置/尺寸
  windowConfig: "window-config.json",
  settingsWindowConfig: "settings-window-config.json",

  // 设置
  settings: "settings.json",

  // 设备标识
  deviceId: "device-id.json",

  // 历史记录与统计
  history: "history.json",
  historyStats: "history-stats.json",

  // 已安装应用缓存
  installedApps: "installed-apps.json",

  // 文件索引与元信息
  fileIndex: "file-index.txt",
  fileIndexMeta: "file-index-meta.json",
} as const;

export function getUserDataRoot(): string {
  // userData 目录由 Electron 决定；开发环境可能被重定向到 userData/dev
  return app.getPath("userData");
}

export function getUserDataPath(fileName: string): string {
  // 统一拼接 userData 下的落盘文件路径
  return path.join(getUserDataRoot(), fileName);
}

// =========================
// 配置类路径
// =========================

export function getWindowConfigPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.windowConfig);
}

export function getSettingsPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.settings);
}

export function getSettingsWindowConfigPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.settingsWindowConfig);
}

// =========================
// 缓存/历史类路径
// =========================

export function getDeviceIdPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.deviceId);
}

export function getHistoryPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.history);
}

export function getHistoryStatsPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.historyStats);
}

export function getInstalledAppsCachePath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.installedApps);
}

// =========================
// 索引类路径
// =========================

export function getFileIndexPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.fileIndex);
}

export function getFileIndexTmpPath(): string {
  // 索引落盘采用 .tmp 临时文件写入：用于尽量避免“写到一半被中断”导致索引损坏
  return `${getFileIndexPath()}.tmp`;
}

export function getFileIndexMetaPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.fileIndexMeta);
}

export function getFileIndexShardPath(shardIndex: number): string {
  // 分片索引文件：file-index-0.txt / file-index-1.txt ...
  const base = USER_DATA_FILENAMES.fileIndex.replace(/\.txt$/i, "");
  return getUserDataPath(`${base}-${Math.max(0, Math.floor(shardIndex))}.txt`);
}

export function getFileIndexShardTmpPath(shardIndex: number): string {
  // 分片索引写入的临时文件：用于原子写入/避免写到一半被中断导致索引损坏
  return `${getFileIndexShardPath(shardIndex)}.tmp`;
}
