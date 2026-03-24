import { warmIconKeys } from "../icon/iconKeyService";

type SearchLikePayload = {
  id?: string;
  name?: string;
  path?: string;
  type?: string;
  iconKey?: string;
};

function normalizeIconKey(raw: unknown) {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return key || "";
}

export function prefetchIconsInBackground(input: {
  event: Electron.IpcMainInvokeEvent;
  query: string;
  searchTypeId: string;
  searchSessionId: string;
  items: SearchLikePayload[];
  getCurrentIconPrefetchToken: () => number;
  iconPrefetchToken: number;
  shouldCancel?: () => boolean;
}) {
  const {
    event,
    query,
    searchTypeId,
    searchSessionId,
    items,
    getCurrentIconPrefetchToken,
    iconPrefetchToken,
  } = input;

  const shouldCancel = () => Boolean(input.shouldCancel?.());

  (async () => {
    const keys = Array.from(
      new Set(
        (items || [])
          .map((it) => normalizeIconKey(it?.iconKey))
          .filter((k) => Boolean(k)),
      ),
    );
    if (keys.length <= 0) return;

    const batchSize = 24;
    for (let i = 0; i < keys.length; i += batchSize) {
      if (shouldCancel()) return;
      if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;

      const batch = keys.slice(i, i + batchSize);
      const readyKeys = await warmIconKeys(batch);
      if (shouldCancel()) return;
      if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;
      if (readyKeys.length > 0) {
        event.sender.send("icons-updated", {
          query,
          searchTypeId,
          searchSessionId,
          keys: readyKeys,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 0 : 10));
    }
  })();
}

