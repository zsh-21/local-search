import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 工作区根目录 */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** IPC 通道定义文件路径 */
const IPC_CHANNELS_FILE = path.join(ROOT_DIR, "src", "shared", "ipc", "channels.ts");
/** 默认设置定义文件路径 */
const DEFAULT_SETTINGS_FILE = path.join(ROOT_DIR, "src", "shared", "constants", "initialValues.ts");
/** 契约快照输出路径 */
const BASELINE_FILE = path.join(ROOT_DIR, "scripts", "contracts", "baseline.json");

/** 读取 UTF-8 文本文件 */
function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/** 从通道定义文件提取常量值映射 */
function parseIpcChannels(fileText) {
  const result = {};
  const re = /export const\s+([A-Z0-9_]+)\s*=\s*["']([^"']+)["'];/g;
  let match = re.exec(fileText);
  while (match) {
    const name = match[1];
    const value = match[2];
    result[name] = value;
    match = re.exec(fileText);
  }
  return result;
}

/** 从默认设置对象提取一级键集合 */
function parseDefaultSettingsKeys(fileText) {
  const startMark = "export const DEFAULT_SETTINGS = {";
  const endMark = "} satisfies AppSettings";
  const start = fileText.indexOf(startMark);
  const end = fileText.indexOf(endMark);
  if (start < 0 || end < 0 || end <= start) return [];
  const body = fileText.slice(start + startMark.length, end);
  const keys = new Set();
  const re = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm;
  let match = re.exec(body);
  while (match) {
    keys.add(match[1]);
    match = re.exec(body);
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

/** 生成契约快照对象 */
function buildContractSnapshot() {
  const channelsText = readUtf8(IPC_CHANNELS_FILE);
  const defaultSettingsText = readUtf8(DEFAULT_SETTINGS_FILE);
  return {
    ipcChannels: parseIpcChannels(channelsText),
    defaultSettingsKeys: parseDefaultSettingsKeys(defaultSettingsText),
    criticalFieldChecks: {
      "src/main/ipc/ipcHandlers.ts": ["settings", "history"],
      "src/main/ipc/indexProgress.ts": ["isIndexing", "progress"],
      "src/main/ipc/searchOpenHandlers.ts": ["ok", "message"],
      "src/renderer/settingsStore.ts": ["settings", "history"],
    },
  };
}

/** 持久化契约快照 */
function writeSnapshot(snapshot) {
  fs.mkdirSync(path.dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

const snapshot = buildContractSnapshot();
writeSnapshot(snapshot);
console.log(`[contracts] baseline updated: ${BASELINE_FILE}`);
