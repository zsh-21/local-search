import path from "node:path";
import { getIconCache, setIconCache, warmHotIconLRU } from "./iconCache";
import {
  getAppIconDataStable,
  getBundledIconForExtension,
  getDefaultCommandIconData,
  getDefaultFolderIconData,
  getDefaultSettingsIconData,
  getFileIconData,
} from "./iconService";
import { normalizeIconKey, parseIconKey } from "./iconKey";

function setSharedIconIfNeeded(key: string, value: string) {
  if (!key || !value) return "";
  setIconCache(key, value);
  return value;
}

function getFallbackIconByKey(key: string) {
  const parsed = parseIconKey(key);
  if (parsed.namespace === "folder") {
    return setSharedIconIfNeeded("folder:default", getDefaultFolderIconData());
  }
  if (parsed.namespace === "settings") {
    return setSharedIconIfNeeded("settings:default", getDefaultSettingsIconData());
  }
  if (parsed.namespace === "command") {
    if (parsed.value === "calc") {
      return setSharedIconIfNeeded("command:calc", getDefaultCommandIconData());
    }
    return setSharedIconIfNeeded(key, getDefaultCommandIconData());
  }
  if (parsed.namespace === "ext") {
    const ext = parsed.value && parsed.value !== "__file" ? parsed.value : "";
    const icon = getBundledIconForExtension(ext);
    return setSharedIconIfNeeded(key, icon);
  }
  return "";
}

async function buildIconDataByKey(key: string) {
  const parsed = parseIconKey(key);
  if (!parsed.namespace) return "";
  if (parsed.namespace === "app") {
    const [appIdRaw, appNameRaw] = String(parsed.value || "").split("|");
    const appId = String(appIdRaw || "").trim();
    const appName = String(appNameRaw || "").trim() || appId;
    if (!appId) return "";
    return getAppIconDataStable(appName, appId, 3);
  }
  if (parsed.namespace === "file") {
    const targetPath = parsed.value;
    if (!targetPath) return "";
    try {
      const icon = await getFileIconData(targetPath);
      if (icon) return icon;
    } catch {}
    return setSharedIconIfNeeded(buildFileExtIconKey(targetPath), getBundledIconForExtension(path.extname(targetPath).toLowerCase()));
  }
  if (parsed.namespace === "ext" || parsed.namespace === "folder" || parsed.namespace === "settings" || parsed.namespace === "command") {
    return getFallbackIconByKey(key);
  }
  return "";
}

export async function resolveIconByKey(
  rawKey: string,
  options?: { cacheOnly?: boolean },
): Promise<string> {
  const key = normalizeIconKey(rawKey);
  if (!key) return "";
  warmHotIconLRU([key]);

  const cached = getIconCache(key);
  if (cached) return cached;

  const sharedFallback = getFallbackIconByKey(key);
  if (sharedFallback) return sharedFallback;
  if (options?.cacheOnly) return "";

  const generated = await buildIconDataByKey(key);
  if (generated) setIconCache(key, generated);
  return generated || "";
}

export async function resolveIconsByKeys(
  keys: string[],
  options?: { cacheOnly?: boolean; max?: number },
) {
  const out: Record<string, string> = {};
  if (!Array.isArray(keys) || keys.length <= 0) return out;

  const max = Math.max(0, Math.floor(Number(options?.max) || keys.length));
  const list = keys.slice(0, max);
  for (const key of list) {
    const normalized = normalizeIconKey(key);
    if (!normalized || out[normalized]) continue;
    const icon = await resolveIconByKey(normalized, options);
    if (icon) out[normalized] = icon;
  }
  return out;
}

export async function warmIconKey(rawKey: string) {
  const key = normalizeIconKey(rawKey);
  if (!key) return false;
  const before = getIconCache(key);
  if (before) return false;
  const icon = await resolveIconByKey(key, { cacheOnly: false });
  return Boolean(icon);
}

export async function warmIconKeys(keys: string[]) {
  if (!Array.isArray(keys) || keys.length <= 0) return [] as string[];
  const ready: string[] = [];
  for (const key of keys) {
    const normalized = normalizeIconKey(key);
    if (!normalized) continue;
    const changed = await warmIconKey(normalized);
    if (changed) ready.push(normalized);
  }
  return ready;
}

export function buildFileExtIconKey(targetPath: string) {
  const ext = path.extname(String(targetPath || "")).toLowerCase();
  const key = ext ? `ext:${ext}` : "ext:__file";
  return normalizeIconKey(key) || "ext:__file";
}
