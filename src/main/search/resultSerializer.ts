import { deriveIconKey } from "../icon/iconKey";

type RawSearchResult = {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  description?: unknown;
  source?: unknown;
  isDirectory?: unknown;
  metaFlags?: unknown;
};

type SerializedSearchResult = {
  id: string;
  name: string;
  path: string;
  type: string;
  iconKey: string;
  description?: string;
  source?: string;
  isDirectory?: boolean;
  metaFlags?: Record<string, unknown>;
};

export function createSearchResultId(input: { type?: string; path?: string; name?: string }) {
  const type = typeof input?.type === "string" ? input.type.trim().toLowerCase() : "";
  const path = typeof input?.path === "string" ? input.path.trim().toLowerCase() : "";
  const name = typeof input?.name === "string" ? input.name.trim().toLowerCase() : "";
  return `${type}|${path || name}`;
}

export function serializeSearchResult(input: unknown): SerializedSearchResult {
  const raw = input && typeof input === "object" ? (input as RawSearchResult) : {};
  const name = typeof raw.name === "string" ? raw.name : "";
  const path = typeof raw.path === "string" ? raw.path : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  const id = createSearchResultId({ type, path, name });

  const out: SerializedSearchResult = {
    id,
    name,
    path,
    type,
    iconKey: deriveIconKey({
      type,
      path,
      name,
      isDirectory: Boolean(raw.isDirectory),
    }),
  };

  if (typeof raw.description === "string" && raw.description) out.description = raw.description;
  if (typeof raw.source === "string" && raw.source) out.source = raw.source;
  if (typeof raw.isDirectory === "boolean") out.isDirectory = raw.isDirectory;
  if (raw.metaFlags && typeof raw.metaFlags === "object") out.metaFlags = raw.metaFlags as Record<string, unknown>;

  return out;
}
