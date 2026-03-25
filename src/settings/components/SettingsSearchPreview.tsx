import { useMemo } from "react";
import type { AppSettings } from "../../appTypes";
import {
  IconCommand,
  IconClear,
  IconCopyPath,
  IconFolder,
  IconFile,
  IconOpenFolder,
  IconPinOff,
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

const SEARCH_PREVIEW_FREQUENCY_CAP = 80;
const SEARCH_PREVIEW_APP_SOURCE_BONUS = 10_000;
const SEARCH_PREVIEW_CONFIG_EXT_BONUS = 3_000;
const SEARCH_PREVIEW_TMP_EXT_BONUS = -5_000;
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

export function SettingsSearchPreview({ draft, currentDefaultTypeLabel }: SettingsSearchPreviewProps) {
  const ranking = draft.searchRanking;

  const previewRows = useMemo(() => {
    const extBonusByPath = (targetPath: string, type: SearchPreviewType) => {
      if (type !== "file") return 0;
      const extMatch = String(targetPath || "").toLowerCase().match(/(\.[^./\\]+)$/);
      const ext = extMatch?.[1] || "";
      if (!ext) return 0;
      if (ext === ".tmp") return SEARCH_PREVIEW_TMP_EXT_BONUS;
      if (SEARCH_PREVIEW_CONFIG_EXTS.has(ext)) return SEARCH_PREVIEW_CONFIG_EXT_BONUS;
      return 0;
    };

    const weightSum =
      Math.max(0, Number(ranking.signalWeights.match) || 0) +
      Math.max(0, Number(ranking.signalWeights.frequency) || 0) +
      Math.max(0, Number(ranking.signalWeights.recency) || 0) +
      Math.max(0, Number(ranking.signalWeights.fileMtime) || 0);
    const normalizedWeights =
      weightSum > 0
        ? {
            match: (Math.max(0, Number(ranking.signalWeights.match) || 0) / weightSum) * 100,
            frequency: (Math.max(0, Number(ranking.signalWeights.frequency) || 0) / weightSum) * 100,
            recency: (Math.max(0, Number(ranking.signalWeights.recency) || 0) / weightSum) * 100,
            fileMtime: (Math.max(0, Number(ranking.signalWeights.fileMtime) || 0) / weightSum) * 100,
          }
        : { match: 38, frequency: 27, recency: 17, fileMtime: 18 };

    const decayFactor = Math.min(1, Math.max(0.0001, Number(ranking.frecency.decayFactor) || 0.01));
    const frequencyWeight = Math.min(10, Math.max(0, Number(ranking.frecency.frequencyWeight) || 0));

    return SEARCH_PREVIEW_SAMPLES.map((item) => {
      const typePriorityFactor = Math.min(1, Math.max(0.1, (Number(ranking.typePriority[item.type]) || 1) / 10));
      const staticScore = Math.min(1, Math.max(0, item.staticScore * typePriorityFactor));
      const frequencyRaw = Math.log(item.count + 1) / Math.log(SEARCH_PREVIEW_FREQUENCY_CAP + 1);
      const frequencyScore = Math.min(1, Math.max(0, frequencyWeight * frequencyRaw));
      const recencyScore = Math.exp(-decayFactor * Math.max(0, item.lastUsedHours));
      const fileMtimeScore =
        item.type === "file" || item.type === "folder" || item.type === "image" || item.type === "video"
          ? Math.exp(-decayFactor * Math.max(0, item.fileMtimeHours ?? 0))
          : 0;

      const normalizedScore =
        (normalizedWeights.match / 100) * staticScore +
        (normalizedWeights.frequency / 100) * frequencyScore +
        (normalizedWeights.recency / 100) * recencyScore +
        (normalizedWeights.fileMtime / 100) * fileMtimeScore;
      const sourceBonus = item.type === "app" ? SEARCH_PREVIEW_APP_SOURCE_BONUS : 0;
      const extBonus = extBonusByPath(item.path || "", item.type);
      const finalScore = normalizedScore * 1_000_000 + sourceBonus + extBonus;

      return {
        ...item,
        finalScore,
      };
    })
      .sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        if (b.staticScore !== a.staticScore) return b.staticScore - a.staticScore;
        if (a.name.length !== b.name.length) return a.name.length - b.name.length;
        return a.name.localeCompare(b.name);
      })
      .map((row, index) => ({
        ...row,
        rank: index + 1,
      }));
  }, [ranking]);

  const visibleRows = previewRows.slice(
    0,
    Math.min(Math.max(1, Number(draft.searchDisplayLimit) || previewRows.length), previewRows.length),
  );

  const getVisibleActionIdsForItem = (item: SearchPreviewSample) => {
    const raw = Array.isArray(draft.resultActionButtons) ? draft.resultActionButtons : [];
    const out: string[] = [];
    for (const id of raw) {
      if (id === "runAsAdmin" && item.type !== "app") continue;
      if (!["openFolder", "copyPath", "deleteHistory", "runAsAdmin"].includes(id as any)) continue;
      if (out.includes(id)) continue;
      out.push(id);
      if (out.length >= 3) break;
    }
    return out;
  };

  const renderResultIcon = (item: SearchPreviewSample) => {
    if (item.type === "folder") return <IconFolder size={40} className="result-icon" />;
    if (item.type === "settings") return <IconSettings size={40} className="result-icon" />;
    if (item.type === "file" || item.type === "image" || item.type === "video") return <IconFile size={40} className="result-icon" />;
    if (item.type === "command") return <IconCommand size={40} className="result-icon" />;
    return <IconFile size={40} className="result-icon" />;
  };

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
          <button type="button" className="pin-btn" tabIndex={-1} aria-label="固定搜索面板" title="固定 (Alt+T)">
            <IconPinOff size={20} />
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
