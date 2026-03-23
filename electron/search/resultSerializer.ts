export function createSearchResultId(input: { type?: string; path?: string; name?: string }) {
  const type = typeof input?.type === "string" ? input.type.trim().toLowerCase() : "";
  const path = typeof input?.path === "string" ? input.path.trim().toLowerCase() : "";
  const name = typeof input?.name === "string" ? input.name.trim().toLowerCase() : "";
  return `${type}|${path || name}`;
}

export function serializeSearchResult(input: any) {
  const name = typeof input?.name === "string" ? input.name : "";
  const path = typeof input?.path === "string" ? input.path : "";
  const type = typeof input?.type === "string" ? input.type : "";
  const id = createSearchResultId({ type, path, name });

  const out: any = {
    id,
    name,
    path,
    type,
  };

  if (typeof input?.description === "string" && input.description) out.description = input.description;
  if (typeof input?.icon === "string" && input.icon) out.icon = input.icon;
  if (typeof input?.source === "string" && input.source) out.source = input.source;
  if (typeof input?.isDirectory === "boolean") out.isDirectory = input.isDirectory;
  if (input?.metaFlags && typeof input.metaFlags === "object") out.metaFlags = input.metaFlags;

  return out;
}

