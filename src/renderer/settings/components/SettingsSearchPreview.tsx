import { useMemo } from "react";
import type { AppSettings } from "../../appTypes";
import { DEFAULT_SETTINGS } from "../../constants/initialValues";
import {
  IconCommand,
  IconClear,
  IconCopyPath,
  IconFolder,
  IconFile,
  IconOpenFolder,
  IconPin,
  IconRunAsAdmin,
  IconSearch,
  IconSettings,
} from "../../components/icons/SettingsIcons";

type SearchPreviewType = "app" | "command" | "settings" | "file" | "folder" | "image" | "video";

type SearchPreviewSample = {
  id: string;
  name: string;
  type: SearchPreviewType;
  staticScore: number;
  count: number;
  lastUsedHours: number;
  fileMtimeHours?: number;
  path?: string;
};

// 频次归一化的上限：与运行时评分保持一致
const SEARCH_PREVIEW_FREQUENCY_CAP = 80;
// 预览评分的归一化基数：将 0~1 评分映射到整数区间
const SEARCH_PREVIEW_SCORE_NORMALIZED_BASE = 1_000_000;
// 来源加分系数：与运行时 sourceScore 的量级保持一致
const SEARCH_PREVIEW_SOURCE_SCORE_FACTOR = 100;
// 配置文件后缀加分
const SEARCH_PREVIEW_CONFIG_EXT_BONUS = 3_000;
// 临时文件后缀扣分
const SEARCH_PREVIEW_TMP_EXT_BONUS = -5_000;
// 缺失文件时间时的兜底评分
const SEARCH_PREVIEW_MISSING_FILE_TIME_FALLBACK_SCORE = 0.04;

// 预览中用于识别图片/视频的扩展名集合
const SEARCH_PREVIEW_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"]);
const SEARCH_PREVIEW_VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"]);
const SEARCH_PREVIEW_CONFIG_EXTS = new Set([
  ".ini",
  ".conf",
  ".config",
  ".cfg",
  ".cnf",
  ".yaml",
  ".yml",
  ".toml",
  ".env",
  ".json",
  ".xml",
  ".properties",
  ".reg",
]);

// 来源基础分：与运行时 sourceScore 的相对关系保持一致
const SEARCH_PREVIEW_SOURCE_SCORE: Record<SearchPreviewType, number> = {
  app: 100,
  settings: 90,
  command: 80,
  file: 0,
  folder: 0,
  image: 0,
  video: 0,
};

const SEARCH_PREVIEW_SAMPLES: SearchPreviewSample[] = [
  {
    id: "app-vscode",
    name: "Visual Studio Code",
    type: "app",
    staticScore: 0.96,
    count: 48,
    lastUsedHours: 1,
    path: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
  },
  {
    id: "settings-theme",
    name: "主题与字体设置",
    type: "settings",
    staticScore: 0.93,
    count: 30,
    lastUsedHours: 2,
  },
  {
    id: "file-spec",
    name: "产品需求说明.docx",
    type: "file",
    staticScore: 0.9,
    count: 22,
    lastUsedHours: 3,
    fileMtimeHours: 4,
    path: "C:\\Users\\21\\Documents\\产品需求说明.docx",
  },
  {
    id: "folder-assets",
    name: "DesignAssets",
    type: "folder",
    staticScore: 0.88,
    count: 18,
    lastUsedHours: 4,
    fileMtimeHours: 6,
    path: "C:\\Users\\21\\Documents\\DesignAssets",
  },
  {
    id: "image-hero",
    name: "brand-hero.png",
    type: "image",
    staticScore: 0.84,
    count: 16,
    lastUsedHours: 6,
    fileMtimeHours: 2,
    path: "C:\\Users\\21\\Pictures\\brand-hero.png",
  },
  {
    id: "video-demo",
    name: "demo-walkthrough.mp4",
    type: "video",
    staticScore: 0.82,
    count: 9,
    lastUsedHours: 10,
    fileMtimeHours: 8,
    path: "C:\\Users\\21\\Videos\\demo-walkthrough.mp4",
  },
  {
    id: "command-dev",
    name: "npm run dev",
    type: "command",
    staticScore: 0.79,
    count: 12,
    lastUsedHours: 2,
  },
];

type SettingsSearchPreviewProps = {
  draft: AppSettings;
  currentDefaultTypeLabel: string;
};
const PREVIEW_ALLOWED_ACTION_IDS: readonly AppSettings["resultActionButtons"][number][] = [
  "openFolder",
  "copyPath",
  "deleteHistory",
  "runAsAdmin",
];

// 评分夹取：保证预览计算落在 0~1
function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

// 归一化预览用的评分配置：对齐运行时评分逻辑，避免预览与实际差异过大
function normalizePreviewRanking(raw: AppSettings["searchRanking"]): AppSettings["searchRanking"] {
  const fallback = DEFAULT_SETTINGS.searchRanking;
  const clamp = (v: unknown, min: number, max: number, fallbackValue: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
    if (!Number.isFinite(n)) return fallbackValue;
    return Math.min(max, Math.max(min, n));
  };

  const signalWeightsRaw = {
    match: clamp(raw?.signalWeights?.match, 0, 1000, fallback.signalWeights.match),
    frequency: clamp(raw?.signalWeights?.frequency, 0, 1000, fallback.signalWeights.frequency),
    recency: clamp(raw?.signalWeights?.recency, 0, 1000, fallback.signalWeights.recency),
    fileMtime: clamp(raw?.signalWeights?.fileMtime, 0, 1000, fallback.signalWeights.fileMtime),
  };

  const weightSum =
    signalWeightsRaw.match + signalWeightsRaw.frequency + signalWeightsRaw.recency + signalWeightsRaw.fileMtime;
  const safeWeightSum =
    weightSum > 0
      ? weightSum
      : fallback.signalWeights.match +
        fallback.signalWeights.frequency +
        fallback.signalWeights.recency +
        fallback.signalWeights.fileMtime;

  const typePriority = {
    app: Math.round(clamp(raw?.typePriority?.app, 1, 10, fallback.typePriority.app)),
    command: Math.round(clamp(raw?.typePriority?.command, 1, 10, fallback.typePriority.command)),
    settings: Math.round(clamp(raw?.typePriority?.settings, 1, 10, fallback.typePriority.settings)),
    file: Math.round(clamp(raw?.typePriority?.file, 1, 10, fallback.typePriority.file)),
    folder: Math.round(clamp(raw?.typePriority?.folder, 1, 10, fallback.typePriority.folder)),
    image: Math.round(clamp(raw?.typePriority?.image, 1, 10, fallback.typePriority.image)),
    video: Math.round(clamp(raw?.typePriority?.video, 1, 10, fallback.typePriority.video)),
    web: Math.round(clamp(raw?.typePriority?.web, 1, 10, fallback.typePriority.web)),
    plugin: Math.round(clamp(raw?.typePriority?.plugin, 1, 10, fallback.typePriority.plugin)),
  };

  return {
    signalWeights: {
      match: signalWeightsRaw.match / safeWeightSum,
      frequency: signalWeightsRaw.frequency / safeWeightSum,
      recency: signalWeightsRaw.recency / safeWeightSum,
      fileMtime: signalWeightsRaw.fileMtime / safeWeightSum,
    },
    frecency: {
      decayFactor: clamp(raw?.frecency?.decayFactor, 0.0001, 1, fallback.frecency.decayFactor),
      frequencyWeight: clamp(raw?.frecency?.frequencyWeight, 0, 10, fallback.frecency.frequencyWeight),
    },
    typePriority,
  };
}

// 提取路径后缀：用于后缀加分与类型识别
function normalizePathExt(targetPath: string) {
  const m = String(targetPath || "").toLowerCase().match(/(\.[^./\\]+)$/);
  return m?.[1] || "";
}

export function SettingsSearchPreview({ draft, currentDefaultTypeLabel }: SettingsSearchPreviewProps) {
  const ranking = draft.searchRanking;

  // 预览列表：基于当前配置计算排序与分数
  const previewRows = useMemo(() => {
    const runtimeRanking = normalizePreviewRanking(ranking);

    const inferPriorityType = (item: SearchPreviewSample): keyof typeof runtimeRanking.typePriority => {
      if (item.type === "file") {
        const ext = normalizePathExt(item.path || "");
        if (SEARCH_PREVIEW_IMAGE_EXTENSIONS.has(ext)) return "image";
        if (SEARCH_PREVIEW_VIDEO_EXTENSIONS.has(ext)) return "video";
      }
      return item.type;
    };

    const extBonusByPath = (targetPath: string, type: SearchPreviewType) => {
      if (type !== "file") return 0;
      const ext = normalizePathExt(targetPath);
      if (!ext) return 0;
      if (ext === ".tmp") return SEARCH_PREVIEW_TMP_EXT_BONUS;
      if (SEARCH_PREVIEW_CONFIG_EXTS.has(ext)) return SEARCH_PREVIEW_CONFIG_EXT_BONUS;
      return 0;
    };

    const getRecencyScoreByHours = (hours: number) => {
      if (!Number.isFinite(hours)) return 0;
      return clamp01(Math.exp(-runtimeRanking.frecency.decayFactor * Math.max(0, hours)));
    };

    return SEARCH_PREVIEW_SAMPLES.map((item) => {
      const priorityType = inferPriorityType(item);
      const typePriorityNorm = clamp01((runtimeRanking.typePriority[priorityType] || 1) / 10);
      const staticWithType = clamp01(clamp01(item.staticScore) * (0.72 + 0.28 * typePriorityNorm));

      const frequencyRaw = Math.log(item.count + 1) / Math.log(SEARCH_PREVIEW_FREQUENCY_CAP + 1);
      const frequencyScore = clamp01(frequencyRaw * runtimeRanking.frecency.frequencyWeight);
      const recencyScore = getRecencyScoreByHours(item.lastUsedHours);

      const isFileLike = priorityType === "file" || priorityType === "folder" || priorityType === "image" || priorityType === "video";
      const hasFileMtimeHours = Number.isFinite(item.fileMtimeHours);
      const hasLastUsedHours = Number.isFinite(item.lastUsedHours);
      const fileMtimeScore = (() => {
        if (!isFileLike) return 0;
        if (hasFileMtimeHours) return getRecencyScoreByHours(item.fileMtimeHours as number);
        if (hasLastUsedHours) return getRecencyScoreByHours(item.lastUsedHours);
        return SEARCH_PREVIEW_MISSING_FILE_TIME_FALLBACK_SCORE;
      })();

      const scoreByMatch = runtimeRanking.signalWeights.match * staticWithType;
      const scoreByFrequency = runtimeRanking.signalWeights.frequency * frequencyScore;
      const scoreByRecency = runtimeRanking.signalWeights.recency * recencyScore;
      const scoreByFileMtime = runtimeRanking.signalWeights.fileMtime * fileMtimeScore;
      const normalizedFinalScore = scoreByMatch + scoreByFrequency + scoreByRecency + scoreByFileMtime;

      const sourceBonusScore = (SEARCH_PREVIEW_SOURCE_SCORE[item.type] || 0) * SEARCH_PREVIEW_SOURCE_SCORE_FACTOR;
      const extBonusScore = extBonusByPath(item.path || "", item.type);

      const finalScore = Math.round(
        normalizedFinalScore * SEARCH_PREVIEW_SCORE_NORMALIZED_BASE + sourceBonusScore + extBonusScore
      );

      return {
        ...item,
        finalScore,
        staticWithType,
      };
    })
      .sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        if (b.staticWithType !== a.staticWithType) return b.staticWithType - a.staticWithType;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return a.name.localeCompare(b.name);
      })
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));
  }, [ranking]);

  // 受显示上限限制的可见行
  const visibleRows = previewRows.slice(
    0,
    Math.min(Math.max(1, Number(draft.searchDisplayLimit) || previewRows.length), previewRows.length),
  );

  // 计算每行应显示的右侧操作按钮（最多 3 个）
  const getVisibleActionIdsForItem = (item: SearchPreviewSample) => {
    const raw = Array.isArray(draft.resultActionButtons) ? draft.resultActionButtons : [];
    const out: string[] = [];
    for (const id of raw) {
      if (id === "runAsAdmin" && item.type !== "app") continue;
      if (!PREVIEW_ALLOWED_ACTION_IDS.includes(id)) continue;
      if (out.includes(id)) continue;
      out.push(id);
      if (out.length >= 3) break;
    }
    return out;
  };

  // 渲染预览区图标：仅用于展示类型差异
  const renderResultIcon = (item: SearchPreviewSample) => {
    if (item.type === "folder") return <IconFolder size={40} className="result-icon" />;
    if (item.type === "settings") return <IconSettings size={40} className="result-icon" />;
    if (item.type === "file" || item.type === "image" || item.type === "video") return <IconFile size={40} className="result-icon" />;
    if (item.type === "command") return <IconCommand size={40} className="result-icon" />;
    return <IconFile size={40} className="result-icon" />;
  };

  // 是否被显示上限截断：用于底部提示
  const isLimitedByDisplayCount = (Number(draft.searchDisplayLimit) || 0) < previewRows.length;

  return (
    <div className="settings-search-preview" aria-hidden="true">
      <div className={`container search-container ${draft.compactMode ? "compact" : ""}`}>
        <div className="search-box">
          <div className="search-icon-wrapper">
            <IconSearch size={18} className="search-icon-svg" variant="mono" />
          </div>
          <div className="search-input-wrap">
            <input type="text" readOnly tabIndex={-1} value="ui-ux-pro-max" aria-label="搜索预览输入框" />
          </div>
          <div className="search-box-right">
            <button type="button" className="clear-btn" tabIndex={-1} aria-label="清空输入" title="清空 (Ctrl+L)">
              <IconClear size={14} variant="mono" />
            </button>
            <div className="type-select">
              <span className="type-select-text">{currentDefaultTypeLabel}</span>
            </div>
          </div>
          <button className="settings-btn" type="button" tabIndex={-1} title="打开设置面板">
            <IconSettings size={20} />
          </button>
          <button type="button" className="pin-btn inactive" tabIndex={-1} aria-label="固定搜索面板" title="固定 (Alt+T)">
            {/* 预览区展示未固定态：同图标、无背景、颜色更暗。 */}
            <IconPin size={17} />
          </button>
        </div>

        <div className="results">
          <div className="settings-preview-results-scroll">
            {visibleRows.map((item, index) => {
              const isSelected = index === 0;
              const showPathLine = draft.showResultPath && typeof item.path === "string" && /^[a-zA-Z]:\\/.test(item.path);
              const actionIds = getVisibleActionIdsForItem(item);
              return (
                <div key={item.id} className={`result-item-wrapper ${isSelected ? "selected" : ""}`}>
                  <li className={isSelected ? "selected" : ""}>
                    <span className="result-index">{item.rank}</span>
                    {renderResultIcon(item)}
                    <div className="result-meta">
                      <div className="result-name-row">
                        <span className="app-name">{item.name}</span>
                      </div>
                      {showPathLine ? <span className="app-path">{item.path}</span> : null}
                    </div>
                    <div className="action-group">
                      {actionIds.includes("openFolder") ? (
                        <button type="button" className="action-btn" data-action-id="openFolder" tabIndex={-1}>
                          <IconOpenFolder size={18} />
                        </button>
                      ) : null}
                      {actionIds.includes("copyPath") ? (
                        <button type="button" className="action-btn" data-action-id="copyPath" tabIndex={-1}>
                          <IconCopyPath size={18} />
                        </button>
                      ) : null}
                      {actionIds.includes("runAsAdmin") ? (
                        <button type="button" className="action-btn" data-action-id="runAsAdmin" tabIndex={-1}>
                          <IconRunAsAdmin size={18} />
                        </button>
                      ) : null}
                    </div>
                  </li>
                </div>
              );
            })}
          </div>
          <div className="list-bottom-info">
            {isLimitedByDisplayCount ? (
              <div className="no-more-results">{`由于内容太多，展示最匹配的前${draft.searchDisplayLimit}`}</div>
            ) : (
              <div className="no-more-results">{`共 ${previewRows.length} 个结果`}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
