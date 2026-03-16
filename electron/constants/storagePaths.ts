import { app } from "electron";
import path from "node:path";

// 这里集中维护“主进程运行过程中产生的落盘文件路径”：
// - 主要落在 app.getPath('userData') 下（配置、索引、缓存、历史等）
// - 统一在这里改文件名/路径，避免散落在多个模块里导致改动遗漏
// - 注意：开发环境下 userData 可能会在 ./config/settings.ts 里被重定向到 userData/dev

// userData 下各类文件的文件名（统一入口，便于你做重命名/迁移）
export const USER_DATA_FILENAMES = {
  // 搜索窗口位置/尺寸：用于记住上次拖动后的窗口坐标
  windowConfig: "window-config.json",
  // 设置窗口位置/尺寸：用于记住设置面板窗口的坐标与大小
  settingsWindowConfig: "settings-window-config.json",

  // 用户设置：主进程读取后下发给渲染进程；渲染进程修改后通过 IPC 写回
  settings: "settings.json",

  // 设备标识：用于会员/账号相关的设备识别（注意：存储的是哈希/随机 ID，而非裸硬件信息）
  deviceId: "device-id.json",

  // 历史记录：用于“空输入时展示最近使用”等能力
  history: "history.json",
  // 历史统计：用于综合排序（频次/最近使用/类型偏好/扩展名偏好）
  historyStats: "history-stats.json",

  // 已安装应用缓存：启动时先读缓存提升速度，随后后台刷新并覆盖落盘
  installedApps: "installed-apps.json",

  // 文件索引：主进程 Worker 落盘的“全局索引”，用于本地快速搜索
  fileIndex: "file-index.txt",
  // 索引元信息：记录索引版本等，用于判断是否需要 reset/rebuild
  fileIndexMeta: "file-index-meta.json",
  indexStats: "file-index-stats.json",
} as const;

export function getUserDataRoot(): string {
  // userData 目录由 Electron 决定：
  // - 生产环境一般为 %AppData%/<AppName>
  // - 开发环境可能被 ./config/settings.ts 重定向到 userData/dev，避免污染真实数据
  return app.getPath("userData");
}

export function getUserDataPath(fileName: string): string {
  // 统一拼接 userData 下的落盘文件路径：
  // - 约束所有落盘文件都通过这一入口构造路径，便于统一迁移/改名/分目录
  return path.join(getUserDataRoot(), fileName);
}

// =========================
// 配置类路径
// =========================

export function getWindowConfigPath(): string {
  // 搜索窗口配置文件路径（窗口位置/尺寸）
  return getUserDataPath(USER_DATA_FILENAMES.windowConfig);
}

export function getSettingsPath(): string {
  // 设置文件路径（settings.json）
  return getUserDataPath(USER_DATA_FILENAMES.settings);
}

export function getSettingsWindowConfigPath(): string {
  // 设置窗口配置文件路径（窗口位置/尺寸）
  return getUserDataPath(USER_DATA_FILENAMES.settingsWindowConfig);
}

// =========================
// 缓存/历史类路径
// =========================

export function getDeviceIdPath(): string {
  // 设备标识文件路径（device-id.json）
  return getUserDataPath(USER_DATA_FILENAMES.deviceId);
}

export function getHistoryPath(): string {
  // 历史记录文件路径（history.json）
  return getUserDataPath(USER_DATA_FILENAMES.history);
}

export function getHistoryStatsPath(): string {
  // 历史统计文件路径（history-stats.json）
  return getUserDataPath(USER_DATA_FILENAMES.historyStats);
}

export function getInstalledAppsCachePath(): string {
  // 已安装应用缓存文件路径（installed-apps.json）
  return getUserDataPath(USER_DATA_FILENAMES.installedApps);
}

// =========================
// 索引类路径
// =========================

export function getFileIndexPath(): string {
  // 全局索引文件路径（file-index.txt）
  return getUserDataPath(USER_DATA_FILENAMES.fileIndex);
}

export function getFileIndexTmpPath(): string {
  // 索引落盘采用 .tmp 临时文件写入：用于尽量避免“写到一半被中断”导致索引损坏
  // - 通常写入流程：先写 .tmp，再 rename/覆盖正式文件
  // - clear:cache / 清理逻辑需要同步删除该临时文件，避免残留
  return `${getFileIndexPath()}.tmp`;
}

export function getFileIndexMetaPath(): string {
  // 索引元信息路径（file-index-meta.json）
  return getUserDataPath(USER_DATA_FILENAMES.fileIndexMeta);
}

export function getFileIndexStatsPath(): string {
  return getUserDataPath(USER_DATA_FILENAMES.indexStats);
}

export function getFileIndexShardPath(shardIndex: number): string {
  // 分片索引文件路径：
  // - 形如 file-index-0.txt / file-index-1.txt ...
  // - shardIndex 会做非负整数兜底，避免传入异常值导致路径不可控
  const base = USER_DATA_FILENAMES.fileIndex.replace(/\.txt$/i, "");
  return getUserDataPath(`${base}-${Math.max(0, Math.floor(shardIndex))}.txt`);
}

export function getFileIndexShardTmpPath(shardIndex: number): string {
  // 分片索引写入的临时文件：用于原子写入/避免写到一半被中断导致索引损坏
  // - 清理时建议同时删除分片的 .tmp，避免旧临时文件干扰后续重建
  return `${getFileIndexShardPath(shardIndex)}.tmp`;
}
