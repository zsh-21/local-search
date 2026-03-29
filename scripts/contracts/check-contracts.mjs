import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 工作区根目录 */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 契约快照路径 */
const BASELINE_FILE = path.join(ROOT_DIR, "scripts", "contracts", "baseline.json");
/** IPC 通道定义文件路径 */
const IPC_CHANNELS_FILE = path.join(ROOT_DIR, "src", "shared", "ipc", "channels.ts");
/** 默认设置定义文件路径 */
const DEFAULT_SETTINGS_FILE = path.join(ROOT_DIR, "src", "shared", "constants", "initialValues.ts");

/** 读取 UTF-8 文件 */
function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/** 从通道定义文件提取常量值映射 */
function parseIpcChannels(fileText) {
  const result = {};
  const re = /export const\s+([A-Z0-9_]+)\s*=\s*["']([^"']+)["'];/g;
  let match = re.exec(fileText);
  while (match) {
    result[match[1]] = match[2];
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

/** 比较对象键值是否完全一致 */
function compareObjectEqual(expected, actual) {
  const expectedKeys = Object.keys(expected).sort((a, b) => a.localeCompare(b));
  const actualKeys = Object.keys(actual).sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    return {
      ok: false,
      reason: `键集合不一致，expected=${expectedKeys.length} actual=${actualKeys.length}`,
    };
  }
  for (const key of expectedKeys) {
    if (expected[key] !== actual[key]) {
      return {
        ok: false,
        reason: `键 ${key} 的值变化，expected=${expected[key]} actual=${actual[key]}`,
      };
    }
  }
  return { ok: true, reason: "" };
}

/** 比较数组值是否完全一致 */
function compareArrayEqual(expected, actual) {
  if (expected.length !== actual.length) {
    return { ok: false, reason: `长度不一致，expected=${expected.length} actual=${actual.length}` };
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i] !== actual[i]) {
      return { ok: false, reason: `索引 ${i} 不一致，expected=${expected[i]} actual=${actual[i]}` };
    }
  }
  return { ok: true, reason: "" };
}

/** 检查关键字段在目标文件中是否存在 */
function checkCriticalFields(criticalFieldChecks) {
  const errors = [];
  for (const [relativePath, requiredFields] of Object.entries(criticalFieldChecks || {})) {
    const filePath = path.join(ROOT_DIR, relativePath);
    if (!fs.existsSync(filePath)) {
      errors.push(`关键字段检查文件不存在：${relativePath}`);
      continue;
    }
    const text = readUtf8(filePath);
    for (const field of requiredFields) {
      if (!text.includes(field)) {
        errors.push(`关键字段缺失：${relativePath} -> ${field}`);
      }
    }
  }
  return errors;
}

/** 运行契约校验 */
function run() {
  if (!fs.existsSync(BASELINE_FILE)) {
    throw new Error(`未找到契约快照：${BASELINE_FILE}`);
  }
  const baseline = JSON.parse(readUtf8(BASELINE_FILE));
  const currentChannels = parseIpcChannels(readUtf8(IPC_CHANNELS_FILE));
  const currentSettingsKeys = parseDefaultSettingsKeys(readUtf8(DEFAULT_SETTINGS_FILE));

  const channelCompare = compareObjectEqual(baseline.ipcChannels || {}, currentChannels);
  if (!channelCompare.ok) {
    throw new Error(`[contracts] IPC 通道契约变更：${channelCompare.reason}`);
  }

  const settingsKeyCompare = compareArrayEqual(
    baseline.defaultSettingsKeys || [],
    currentSettingsKeys,
  );
  if (!settingsKeyCompare.ok) {
    throw new Error(`[contracts] 默认设置键契约变更：${settingsKeyCompare.reason}`);
  }

  const criticalFieldErrors = checkCriticalFields(baseline.criticalFieldChecks || {});
  if (criticalFieldErrors.length > 0) {
    throw new Error(`[contracts] 关键字段检查失败：\n${criticalFieldErrors.join("\n")}`);
  }
}

run();
console.log("[contracts] check passed");
