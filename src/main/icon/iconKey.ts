import path from "node:path";

export type IconBucketType = "app" | "file" | "folder" | "settings" | "command" | "calc" | "unknown";

export type SearchLikeItem = {
  type?: string;
  path?: string;
  name?: string;
  isDirectory?: boolean;
};

function normalizeType(raw: unknown): IconBucketType {
  const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (t === "app") return "app";
  if (t === "file") return "file";
  if (t === "folder") return "folder";
  if (t === "settings") return "settings";
  if (t === "command") return "command";
  if (t === "calc") return "calc";
  return "unknown";
}

function normalizeExtension(targetPath: string) {
  const ext = path.extname(String(targetPath || "")).toLowerCase();
  return ext || "__file";
}

export function normalizeIconKey(raw: unknown) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return "";
  const text = input.toLowerCase();
  return text.length > 4096 ? text.slice(0, 4096) : text;
}

export function getDefaultIconKeyByType(type: IconBucketType) {
  if (type === "folder") return "folder:default";
  if (type === "settings") return "settings:default";
  if (type === "command") return "command:default";
  if (type === "calc") return "command:calc";
  if (type === "file") return "ext:__file";
  return "ext:__file";
}

export function deriveIconKey(input: SearchLikeItem) {
  const type = normalizeType(input?.type);
  const targetPath = typeof input?.path === "string" ? input.path.trim() : "";
  const name = typeof input?.name === "string" ? input.name.trim() : "";

  if (type === "app") {
    const appId = targetPath || name;
    if (!appId) return "app:unknown";
    const appName = name || "";
    return normalizeIconKey(`app:${appId}|${appName}`) || "app:unknown";
  }
  if (type === "folder" || input?.isDirectory) {
    if (targetPath) return normalizeIconKey(`file:${targetPath}`) || "folder:default";
    return "folder:default";
  }
  if (type === "settings") return "settings:default";
  if (type === "command") {
    const key = targetPath || name || "default";
    return normalizeIconKey(`command:${key}`) || "command:default";
  }
  if (type === "calc") return "command:calc";
  if (type === "file") {
    if (targetPath) return normalizeIconKey(`file:${targetPath}`) || "ext:__file";
    const ext = normalizeExtension(name);
    return normalizeIconKey(`ext:${ext}`) || "ext:__file";
  }
  return getDefaultIconKeyByType(type);
}

export function parseIconKey(raw: unknown) {
  const key = normalizeIconKey(raw);
  if (!key) return { namespace: "", value: "", key: "" };
  const idx = key.indexOf(":");
  if (idx <= 0) return { namespace: "", value: key, key };
  return {
    namespace: key.slice(0, idx),
    value: key.slice(idx + 1),
    key,
  };
}
