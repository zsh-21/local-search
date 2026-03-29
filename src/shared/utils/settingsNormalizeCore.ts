import type { AppSettings, ResultActionButtonId } from "../types/settingsTypes";
import { BASE_SEARCH_TYPE_IDS, DEFAULT_SETTINGS } from "../constants/initialValues";

/** 归一化选项：用于兼容主进程与渲染进程的历史差异 */
export interface NormalizeSettingsOptions {
  /** 是否允许 dark-win 主题 */
  includeDarkWinTheme?: boolean;
}

/** 归一化未知对象：仅允许对象参与字段读取 */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

/** 归一化数值范围 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 归一化整型范围 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

/** 归一化快捷键字符串 */
function normalizeShortcut(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/CommandOrControl/g, "Ctrl").trim();
}

/** 归一化排序权重与参数 */
export function normalizeSearchRankingConfig(raw: unknown): AppSettings["searchRanking"] {
  const source = asRecord(raw);
  const fallback = DEFAULT_SETTINGS.searchRanking;
  const signalWeightsSource = asRecord(source.signalWeights);
  const frecencySource = asRecord(source.frecency);
  const typePrioritySource = asRecord(source.typePriority);

  const match = clampNumber(signalWeightsSource.match, 0, 1000, fallback.signalWeights.match);
  const frequency = clampNumber(signalWeightsSource.frequency, 0, 1000, fallback.signalWeights.frequency);
  const recency = clampNumber(signalWeightsSource.recency, 0, 1000, fallback.signalWeights.recency);
  const fileMtime = clampNumber(signalWeightsSource.fileMtime, 0, 1000, fallback.signalWeights.fileMtime);
  const sum = match + frequency + recency + fileMtime;

  const signalWeights =
    Number.isFinite(sum) && sum > 0
      ? {
          match: Number(((match / sum) * 100).toFixed(4)),
          frequency: Number(((frequency / sum) * 100).toFixed(4)),
          recency: Number(((recency / sum) * 100).toFixed(4)),
          fileMtime: Number(((fileMtime / sum) * 100).toFixed(4)),
        }
      : { ...fallback.signalWeights };

  const typePriority = {
    app: clampInt(typePrioritySource.app, fallback.typePriority.app, 1, 10),
    command: clampInt(typePrioritySource.command, fallback.typePriority.command, 1, 10),
    settings: clampInt(typePrioritySource.settings, fallback.typePriority.settings, 1, 10),
    file: clampInt(typePrioritySource.file, fallback.typePriority.file, 1, 10),
    folder: clampInt(typePrioritySource.folder, fallback.typePriority.folder, 1, 10),
    image: clampInt(typePrioritySource.image, fallback.typePriority.image, 1, 10),
    video: clampInt(typePrioritySource.video, fallback.typePriority.video, 1, 10),
    web: clampInt(typePrioritySource.web, fallback.typePriority.web, 1, 10),
    plugin: clampInt(typePrioritySource.plugin, fallback.typePriority.plugin, 1, 10),
  };

  return {
    signalWeights,
    frecency: {
      decayFactor: clampNumber(
        frecencySource.decayFactor,
        0.0001,
        1,
        fallback.frecency.decayFactor,
      ),
      frequencyWeight: clampNumber(
        frecencySource.frequencyWeight,
        0,
        10,
        fallback.frecency.frequencyWeight,
      ),
    },
    typePriority,
  };
}

/** 归一化设置数据 */
export function normalizeSettingsCore(
  rawInput: unknown,
  options: NormalizeSettingsOptions = {},
): AppSettings {
  const raw = asRecord(rawInput);
  const includeDarkWinTheme = options.includeDarkWinTheme === true;

  const legacyThemeMap: Record<string, AppSettings["theme"]> = {
    voltage: "oxide",
    chrome: "dark",
    terminal: "dark",
    alloy: "dark",
    signal: "dark",
  };
  const normalizedThemeCandidate =
    typeof raw.theme === "string" ? (legacyThemeMap[raw.theme] ?? raw.theme) : DEFAULT_SETTINGS.theme;
  const allowedThemes: AppSettings["theme"][] = includeDarkWinTheme
    ? ["dark", "dark-win", "vector", "noir", "oxide", "mac", "blueprint", "paper"]
    : ["dark", "vector", "noir", "oxide", "mac", "blueprint", "paper"];
  const theme = allowedThemes.includes(normalizedThemeCandidate as AppSettings["theme"])
    ? (normalizedThemeCandidate as AppSettings["theme"])
    : DEFAULT_SETTINGS.theme;

  const uiFontFamily =
    typeof raw.uiFontFamily === "string" && raw.uiFontFamily.trim()
      ? raw.uiFontFamily.trim().slice(0, 300)
      : DEFAULT_SETTINGS.uiFontFamily;

  const customSearchTypes = Array.isArray(raw.customSearchTypes)
    ? Array.from(
        new Set(
          raw.customSearchTypes
            .map((it) => (typeof it === "string" ? it.trim().toLowerCase() : ""))
            .filter((it) => /^\.[a-z0-9]{1,10}$/i.test(it)),
        ),
      )
    : [];

  const defaultSearchTypeIdRaw =
    typeof raw.defaultSearchTypeId === "string" && raw.defaultSearchTypeId.trim()
      ? raw.defaultSearchTypeId.trim()
      : DEFAULT_SETTINGS.defaultSearchTypeId;
  const defaultSearchTypeId =
    defaultSearchTypeIdRaw === "all" ||
    defaultSearchTypeIdRaw === "app" ||
    defaultSearchTypeIdRaw === "file" ||
    defaultSearchTypeIdRaw === "folder" ||
    defaultSearchTypeIdRaw === "image" ||
    defaultSearchTypeIdRaw === "video" ||
    defaultSearchTypeIdRaw === "settings" ||
    (defaultSearchTypeIdRaw.startsWith("ext:") &&
      /^\.[a-z0-9]{1,10}$/i.test(defaultSearchTypeIdRaw.slice(4)) &&
      customSearchTypes.includes(defaultSearchTypeIdRaw.slice(4).toLowerCase()))
      ? defaultSearchTypeIdRaw
      : DEFAULT_SETTINGS.defaultSearchTypeId;

  const baseTypeIds = [...BASE_SEARCH_TYPE_IDS];
  const customTypeIds = customSearchTypes.map((ext) => `ext:${ext}`);
  const allowedTypeIds = new Set<string>([...baseTypeIds, ...customTypeIds]);

  const rawOrder = Array.isArray(raw.searchTypeOrder)
    ? raw.searchTypeOrder
        .map((it) => (typeof it === "string" ? it.trim() : ""))
        .filter(Boolean)
    : [];
  const searchTypeOrder: string[] = [];
  for (const id of rawOrder) {
    if (!allowedTypeIds.has(id)) continue;
    if (searchTypeOrder.includes(id)) continue;
    searchTypeOrder.push(id);
  }
  for (const id of [...baseTypeIds, ...customTypeIds]) {
    if (!searchTypeOrder.includes(id)) searchTypeOrder.push(id);
  }

  const rawDisabledTypeIds = Array.isArray(raw.disabledSearchTypeIds)
    ? raw.disabledSearchTypeIds
        .map((it) => (typeof it === "string" ? it.trim() : ""))
        .filter(Boolean)
    : [];
  const disabledSearchTypeIds: string[] = [];
  const disabledSeen = new Set<string>();
  for (const id of rawDisabledTypeIds) {
    if (!allowedTypeIds.has(id)) continue;
    if (id === "all") continue;
    if (disabledSeen.has(id)) continue;
    disabledSeen.add(id);
    disabledSearchTypeIds.push(id);
  }
  const safeDefaultSearchTypeId = disabledSearchTypeIds.includes(defaultSearchTypeId) ? "all" : defaultSearchTypeId;

  const normalizeIgnoredPath = (value: string) => value.replace(/\//g, "\\").replace(/\\+/g, "\\").trim().replace(/[\\]+$/g, "");
  const ignoredPathsRaw = Array.isArray(raw.ignoredPaths)
    ? raw.ignoredPaths
        .map((it) => (typeof it === "string" ? it.trim() : ""))
        .filter(Boolean)
    : [];
  const ignoredPaths: string[] = [];
  const ignoredSeen = new Set<string>();
  for (const item of ignoredPathsRaw) {
    const normalized = normalizeIgnoredPath(item).toLowerCase();
    if (!normalized) continue;
    if (ignoredSeen.has(normalized)) continue;
    ignoredSeen.add(normalized);
    ignoredPaths.push(item);
  }

  const rawActionButtons = Array.isArray(raw.resultActionButtons)
    ? raw.resultActionButtons
        .map((it) => (typeof it === "string" ? it.trim() : ""))
        .filter(Boolean)
    : [];
  const allowedActionIds = new Set<ResultActionButtonId>(["openFolder", "copyPath", "deleteHistory", "runAsAdmin"]);
  const resultActionButtons: ResultActionButtonId[] = [];
  for (const id of rawActionButtons) {
    if (!allowedActionIds.has(id as ResultActionButtonId)) continue;
    if (resultActionButtons.includes(id as ResultActionButtonId)) continue;
    resultActionButtons.push(id as ResultActionButtonId);
    if (resultActionButtons.length >= 3) break;
  }
  if (resultActionButtons.length <= 0) {
    resultActionButtons.push(...DEFAULT_SETTINGS.resultActionButtons);
  }

  const rawPreferredExts = Array.isArray(raw.preferredFileExtensions)
    ? raw.preferredFileExtensions
    : DEFAULT_SETTINGS.preferredFileExtensions;
  const preferredFileExtensions: string[] = [];
  const extSeen = new Set<string>();
  for (const item of rawPreferredExts) {
    const rawExt = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!rawExt) continue;
    const ext = rawExt.startsWith(".") ? rawExt : `.${rawExt}`;
    if (ext.length < 2 || ext.length > 12) continue;
    if (extSeen.has(ext)) continue;
    extSeen.add(ext);
    preferredFileExtensions.push(ext);
    if (preferredFileExtensions.length >= 80) break;
  }

  const backgroundImageOpacityRaw =
    typeof raw.backgroundImageOpacity === "number"
      ? raw.backgroundImageOpacity
      : DEFAULT_SETTINGS.backgroundImageOpacity;
  const backgroundImageOpacity = Number.isFinite(backgroundImageOpacityRaw)
    ? Math.min(1, Math.max(0, backgroundImageOpacityRaw))
    : DEFAULT_SETTINGS.backgroundImageOpacity;

  return {
    autoStart: Boolean(raw.autoStart),
    searchShortcut: normalizeShortcut(raw.searchShortcut, DEFAULT_SETTINGS.searchShortcut),
    settingsShortcut: normalizeShortcut(raw.settingsShortcut, DEFAULT_SETTINGS.settingsShortcut),
    acceptSelectedResultShortcut: normalizeShortcut(
      raw.acceptSelectedResultShortcut,
      DEFAULT_SETTINGS.acceptSelectedResultShortcut,
    ),
    theme,
    uiFontFamily,
    historyLimit:
      typeof raw.historyLimit === "number" && Number.isFinite(raw.historyLimit)
        ? Math.min(50, Math.max(0, Math.floor(raw.historyLimit)))
        : DEFAULT_SETTINGS.historyLimit,
    defaultSearchTypeId: safeDefaultSearchTypeId,
    customSearchTypes,
    searchTypeOrder,
    disabledSearchTypeIds,
    ignoredPaths,
    keepStateOnClose: Boolean(raw.keepStateOnClose),
    showResultPath: typeof raw.showResultPath === "boolean" ? raw.showResultPath : DEFAULT_SETTINGS.showResultPath,
    enableHistory: raw.enableHistory !== false,
    backgroundImagePath:
      typeof raw.backgroundImagePath === "string"
        ? raw.backgroundImagePath.trim()
        : DEFAULT_SETTINGS.backgroundImagePath,
    backgroundImageOpacity,
    customAvatarPath:
      typeof raw.customAvatarPath === "string"
        ? raw.customAvatarPath.trim()
        : DEFAULT_SETTINGS.customAvatarPath,
    resultActionButtons,
    searchWindowInitialWidth: clampInt(
      raw.searchWindowInitialWidth,
      DEFAULT_SETTINGS.searchWindowInitialWidth,
      450,
      1000,
    ),
    searchWindowMaxHeight: clampInt(
      raw.searchWindowMaxHeight ?? raw.searchWindowInitialHeight,
      DEFAULT_SETTINGS.searchWindowMaxHeight,
      200,
      10000,
    ),
    searchDisplayLimit: clampInt(raw.searchDisplayLimit, DEFAULT_SETTINGS.searchDisplayLimit, 20, 100),
    searchRanking: normalizeSearchRankingConfig(raw.searchRanking),
    compactMode: raw.compactMode === true,
    preferredFileExtensions:
      preferredFileExtensions.length > 0 ? preferredFileExtensions : DEFAULT_SETTINGS.preferredFileExtensions,
  };
}
