import { fileIndex, isIgnoredPathByCache } from "../file/indexService";
import { recentIndex, normalizeRecentKey } from "../file/watcher";
import { loadSettings } from "../config/settings";
import { loadHistoryStats, normalizeHistoryKey, normalizeExtKey } from "../history/history";
import { getInstalledAppsCache } from "../apps/installedApps";
import { normalizeAppGroupKey } from "../utils/normalize";
import { iconDataCache, isTooSmallAppIconDataUrl } from "../icon/iconCache";
import { getAppIconDataStable, getFileIconData } from "../icon/iconService";
import { handleSearchFiles, type SearchFilesDeps } from "./searchFilesHandler";

type SearchFilesOptions = { searchTypeId?: string; searchSessionId?: string; drive?: string };

const searchFilesDeps: SearchFilesDeps = {
  fileIndex,
  loadSettings,
  loadHistoryStats,
  normalizeHistoryKey,
  normalizeExtKey,
  getInstalledApps: () => getInstalledAppsCache(),
  normalizeAppGroupKey,
  iconDataCache,
  isTooSmallAppIconDataUrl,
  getAppIconDataStable,
  getFileIconData,
  isIgnoredPathByCache,
  normalizeRecentKey,
  recentIndex,
};

export function searchFilesViaService(
  event: Electron.IpcMainInvokeEvent,
  query: string,
  options?: SearchFilesOptions,
) {
  return handleSearchFiles(event, query, options, searchFilesDeps);
}
