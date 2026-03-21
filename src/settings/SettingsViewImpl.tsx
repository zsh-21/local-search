import { useEffect, useMemo, useRef, useState } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import { ParticleBackground } from "../components/ParticleBackground";
import { useSettingsController, SettingsTabKey } from "./useSettingsController";
import { GeneralSection } from "./sections/GeneralSection";
import { SearchSection } from "./sections/SearchSection";
import { AccountSection } from "./sections/AccountSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { IconAppearance, IconGeneral, IconPinOff, IconSearch, IconShortcuts } from "../components/icons/SettingsIcons";
import type { AppSettings } from "../appTypes";

// 设置页渲染层：负责整体布局与导航，具体逻辑集中在 useSettingsController，分区 UI 下沉到 sections
const NAV_ITEMS: { key: Exclude<SettingsTabKey, "account">; label: string; icon: JSX.Element }[] = [
  // 设置侧栏图标统一复用组件，避免在业务组件中继续堆叠内联 SVG。
  { key: "general", label: "通用", icon: <IconGeneral size={17} /> },
  { key: "search", label: "搜索", icon: <IconSearch size={17} /> },
  { key: "shortcuts", label: "快捷键", icon: <IconShortcuts size={17} /> },
  { key: "appearance", label: "外观", icon: <IconAppearance size={17} /> },
];

const SECTION_META: Record<SettingsTabKey, { title: string; desc: string }> = {
  general: { title: "通用", desc: "启动、状态与历史记录" },
  search: { title: "搜索", desc: "默认类型、窗口参数与结果行为" },
  shortcuts: { title: "快捷键", desc: "呼出搜索与面板内快捷操作" },
  appearance: { title: "外观", desc: "主题、字体、背景图与视觉效果" },
  account: { title: "账号", desc: "登录状态与订阅信息" },
};

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

// 预览频率上限：用于归一化常用次数的影响
const SEARCH_PREVIEW_FREQUENCY_CAP = 80;

// 顶部搜索预览样本：用于静态展示排序与样式变化，不参与真实搜索逻辑
const SEARCH_PREVIEW_SAMPLES: SearchPreviewSample[] = [
  {
    id: "zip-skill",
    name: "ui-ux-pro-max-skill.zip",
    type: "file",
    staticScore: 0.96,
    count: 42,
    lastUsedHours: 1,
    fileMtimeHours: 1,
    path: "C:\\Users\\21\\AppData\\Local\\Temp\\ui-ux-pro-max-skill.zip",
  },
  {
    id: "folder-skill",
    name: "ui-ux-pro-max-skill",
    type: "folder",
    staticScore: 0.91,
    count: 26,
    lastUsedHours: 2,
    fileMtimeHours: 2,
    path: "C:\\Users\\21\\AppData\\Local\\Temp\\ui-ux-pro-max-skill",
  },
  {
    id: "folder-main",
    name: "ui-ux-pro-max-skill-main",
    type: "folder",
    staticScore: 0.86,
    count: 18,
    lastUsedHours: 3,
    fileMtimeHours: 3,
    path: "C:\\Users\\21\\AppData\\Local\\Temp\\ui-ux-pro-max-skill\\ui-ux-pro-max-skill-main",
  },
  {
    id: "folder-root",
    name: "ui-ux-pro-max",
    type: "folder",
    staticScore: 0.81,
    count: 12,
    lastUsedHours: 5,
    fileMtimeHours: 5,
    path: "C:\\Users\\21\\AppData\\Local\\Temp\\ui-ux-pro-max-skill\\ui-ux-pro-max",
  },
];

// 预览类型短标签：用于结果徽标展示
const PREVIEW_TYPE_LABEL_MAP: Record<SearchPreviewType, string> = {
  app: "应用",
  command: "命令",
  settings: "设置",
  file: "文件",
  folder: "文件夹",
  image: "图片",
  video: "视频",
};

type SettingsSearchPreviewProps = {
  draft: AppSettings;
  currentDefaultTypeLabel: string;
};

function SettingsSearchPreview({ draft, currentDefaultTypeLabel }: SettingsSearchPreviewProps) {
  const ranking = draft.searchRanking;

  const previewRows = useMemo(() => {
    // 预览排序使用与主搜索一致的加权口径，保证参数变化可被立即感知
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
        : { match: 40, frequency: 30, recency: 20, fileMtime: 10 };

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

      const finalScore =
        (normalizedWeights.match / 100) * staticScore +
        (normalizedWeights.frequency / 100) * frequencyScore +
        (normalizedWeights.recency / 100) * recencyScore +
        (normalizedWeights.fileMtime / 100) * fileMtimeScore;

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

  // 按展示条数裁剪预览结果，保持与设置中的显示限制一致
  const visibleRows = previewRows.slice(
    0,
    Math.min(Math.max(1, Number(draft.searchDisplayLimit) || previewRows.length), previewRows.length),
  );

  // 复用真实搜索面板右侧按钮筛选逻辑，保证预览与正式面板一致
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

  // 结果徽标逻辑对齐真实搜索面板：文件显示扩展名，文件夹/设置显示固定标签
  const buildBadgeText = (item: SearchPreviewSample) => {
    if (item.type === "folder") return "文件夹";
    if (item.type === "settings") return "设置";
    if (item.type !== "file" && item.type !== "image" && item.type !== "video") return "";
    if (!item.name.includes(".")) return PREVIEW_TYPE_LABEL_MAP.file;
    const ext = item.name.split(".").pop()?.toUpperCase();
    return ext && ext.length <= 6 ? ext : PREVIEW_TYPE_LABEL_MAP.file;
  };

  // 结果图标结构尽量与真实面板一致，避免预览出现样式漂移
  const renderResultIcon = (item: SearchPreviewSample) => {
    if (item.type === "folder") {
      return (
        <span className="result-icon folder-emoji" aria-hidden="true">
          📁
        </span>
      );
    }
    if (item.type === "settings") {
      return (
        <svg className="result-icon" viewBox="0 0 25 25" fill="none" aria-hidden="true">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    }
    if (item.type === "file" || item.type === "image" || item.type === "video") {
      const badge = buildBadgeText(item);
      return (
        <span className="result-icon ext-icon" aria-hidden="true">
          <span className="ext-icon-text">{badge}</span>
        </span>
      );
    }
    if (item.type === "command") {
      return (
        <svg className="result-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 7.5 9 12l-4 4.5M11.5 16.5H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <rect x="2.5" y="3.5" width="19" height="17" rx="3" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    }
    return (
      <svg className="result-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="3.5" width="16" height="17" rx="3" stroke="currentColor" strokeWidth="1.7" />
        <path d="M8 8.5h8M8 12h8M8 15.5h5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  };

  const isLimitedByDisplayCount = (Number(draft.searchDisplayLimit) || 0) < previewRows.length;

  return (
    <div className="settings-search-preview" aria-hidden="true">
      <div className={`container search-container ${draft.compactMode ? "compact" : ""}`}>
          {/* 顶部搜索框完整复用真实结构：保证视觉与真实搜索面板一致 */}
          <div className="search-box">
            <div className="search-icon-wrapper">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="search-icon-svg" aria-hidden="true">
                <path
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0 1 14 0z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="search-input-wrap">
              <input type="text" readOnly tabIndex={-1} value="ui-ux-pro-max" aria-label="搜索预览输入框" />
            </div>
            <div className="search-box-right">
              <button type="button" className="clear-btn" tabIndex={-1} aria-label="清空输入" title="清空 (Ctrl+L)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
              <div className="type-select">
                <button className="type-select-btn" type="button" tabIndex={-1} aria-haspopup="menu" aria-expanded="false">
                  <span className="type-select-label">{currentDefaultTypeLabel}</span>
                  <span className="type-select-caret">▾</span>
                </button>
              </div>
            </div>
            <button className="settings-btn" type="button" tabIndex={-1} title="打开设置面板">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button type="button" className="pin-btn" tabIndex={-1} aria-label="固定搜索面板" title="固定 (Alt+T)">
              <IconPinOff size={25} />
            </button>
          </div>

          <div className="results">
            {visibleRows.map((item, index) => {
              const isSelected = index === 0;
              const badgeText = buildBadgeText(item);
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
                        {badgeText ? <span className="file-ext-badge">{badgeText}</span> : null}
                        {isSelected ? <span className="shortcut-hint">ENTER</span> : null}
                      </div>
                      {showPathLine ? <span className="app-path">{item.path}</span> : null}
                    </div>
                    <div className="action-group">
                      {actionIds.includes("openFolder") ? (
                        <button type="button" className="action-btn" data-action-id="openFolder" tabIndex={-1}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path
                              d="M3 7.5c0-1.1.9-2 2-2h5l2 2h7c1.1 0 2 .9 2 2v7.5c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.5Z"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      ) : null}
                      {actionIds.includes("copyPath") ? (
                        <button type="button" className="action-btn" data-action-id="copyPath" tabIndex={-1}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path
                              d="M8 4V3c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v10c0 .6-.4 1-1 1h-1M4 8v12c0 .6.4 1 1 1h10c.6 0 1-.4 1-1V8c0-.6-.4-1-1-1H5c-.6 0-1 .4-1 1Z"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      ) : null}
                      {actionIds.includes("runAsAdmin") ? (
                        <button type="button" className="action-btn" data-action-id="runAsAdmin" tabIndex={-1}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path
                              d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      ) : null}
                    </div>
                  </li>
                </div>
              );
            })}
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

export function SettingsViewImpl() {
  const c = useSettingsController();
  const [avatarDataUrl, setAvatarDataUrl] = useState<string>("");
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 头像展示使用 dataUrl：由主进程读取本地图片并转为 dataUrl，避免 file:// 跨域/权限问题
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const p = typeof c.draft.customAvatarPath === "string" ? c.draft.customAvatarPath.trim() : "";
    if (!p) {
      setAvatarDataUrl("");
      return;
    }
    window.ipcRenderer
      ?.invoke("get-image-data-url", p)
      .then((resp: any) => {
        if (requestIdRef.current !== requestId) return;
        if (resp?.ok && typeof resp.dataUrl === "string") setAvatarDataUrl(resp.dataUrl);
      })
      .catch(() => {});
  }, [c.draft.customAvatarPath]);
  useEffect(() => {
    const focusContainer = () => {
      window.setTimeout(() => {
        containerRef.current?.focus();
      }, 0);
    };
    focusContainer();
    window.ipcRenderer?.on("settings-window-opened", focusContainer as any);
    return () => {
      window.ipcRenderer?.off("settings-window-opened", focusContainer as any);
    };
  }, []);
  const membershipBadge = !c.isMember ? <span className="membership-badge">订阅可用</span> : null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
      if (e.key === "Escape") c.onClose();
      return;
    }

    if (e.key === "Escape") {
      c.onClose();
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const keys: SettingsTabKey[] = ["account", ...NAV_ITEMS.map((x) => x.key)];
      const idx = Math.max(0, keys.indexOf(c.activeKey));
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const next = keys[(idx + delta + keys.length) % keys.length];
      c.setActiveKey(next);
    }
  };

  const currentMeta = useMemo(() => SECTION_META[c.activeKey], [c.activeKey]);
  // 搜索页需要替换顶部标题为预览面板，其余页面保留原标题与描述
  const isSearchTab = c.activeKey === "search";

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`container settings-container ${c.maximized ? "maximized" : ""}`}
      onKeyDown={handleKeyDown}
    >
      <BackgroundImage path={c.draft.backgroundImagePath} opacity={c.draft.backgroundImageOpacity} />
      <ParticleBackground enabled={c.draft.enableEffect} type={c.draft.effectType} />

      <div className="settings-header" >
        <div
          className="settings-title-wrap"
          onDoubleClick={(e) => {
            e.stopPropagation();
            c.onToggleMax();
          }}
        >
          <img src="tray.svg" className="settings-logo" alt="logo" />
          <span className="settings-title">设置</span>
          <button
            type="button"
            className="settings-official-link"
            title="访问官网"
            onClick={(e) => {
              e.stopPropagation();
              window.ipcRenderer?.invoke("open-external", "https://www.yitong.xin/");
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>
        <div className="settings-header-spacer" />
        <div className="settings-window-controls">
          <button
            type="button"
            className="window-btn"
            onClick={() => window.ipcRenderer?.invoke("minimize-window")}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label="最小化"
            title="最小化"
          >
            <span style={{ fontSize: 14, fontWeight: 600, transform: "translateY(-2px)" }}>—</span>
          </button>
          <button
            type="button"
            className="window-btn"
            onClick={c.onToggleMax}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label="全屏/取消全屏"
            title="全屏/取消全屏"
          >
            {c.maximized ? <span style={{ fontSize: 20 }}>❐</span> : <span style={{ fontSize: 20 }}>▢</span>}
          </button>
          <button
            type="button"
            className="window-btn close"
            onClick={c.onClose}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label="关闭"
            title="关闭"
          >
            <span style={{ fontSize: 30 }}>×</span>
          </button>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-shell">
          <div className="settings-body">
            <div className="settings-nav" role="tablist" aria-label="设置菜单">
              <button
                type="button"
                className={`settings-nav-account-card ${c.activeKey === "account" ? "active" : ""}`}
                onClick={() => c.setActiveKey("account")}
              >
                <div className="settings-account-avatar-box">
                  <span className="settings-nav-account-avatar" aria-hidden="true">
                    {avatarDataUrl ? (
                      <img className="settings-nav-account-avatar-img" src={avatarDataUrl} alt="" />
                    ) : c.user ? (
                      <span className="settings-nav-account-avatar-text">
                        {c.user.avatarText || c.user.nickname?.slice(0, 1).toUpperCase()}
                      </span>
                    ) : (
                      <svg className="settings-nav-account-avatar-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M20 21a8 8 0 1 0-16 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        <path d="M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeWidth="1.8" />
                      </svg>
                    )}
                  </span>
                </div>
                <span className="settings-nav-account-meta">
                  <span className="settings-nav-account-name">
                    {c.user ? c.user.nickname || c.user.phone || c.user.email : "未登录"}
                  </span>
                  <span className="settings-nav-account-sub">
                    {c.user ? c.user.email || c.user.phone || "" : "点击登录"}
                  </span>
                </span>
              </button>

              <div className="settings-nav-divider" aria-hidden="true" />
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`settings-nav-item ${c.activeKey === item.key ? "active" : ""}`}
                  onClick={() => c.setActiveKey(item.key)}
                >
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span className="settings-nav-label">{item.label}</span>
                </button>
              ))}
            </div>

            <div className="settings-main">
              <div className="settings-main-inner">
                <div className={`settings-section-header ${isSearchTab ? "search-preview-header" : ""}`}>
                  {isSearchTab ? (
                    <SettingsSearchPreview
                      draft={c.draft}
                      currentDefaultTypeLabel={c.currentDefaultTypeLabel}
                    />
                  ) : (
                    <>
                      <div className="settings-section-title">{currentMeta.title}</div>
                      <div className="settings-section-desc">{currentMeta.desc}</div>
                    </>
                  )}
                </div>

                {c.activeKey === "general" ? (
                  <GeneralSection draft={c.draft} setDraft={c.setDraft} setError={c.setError} />
                ) : null}
                {c.activeKey === "search" ? (
                  <SearchSection
                    error={c.error}
                    draft={c.draft}
                    setDraft={c.setDraft}
                    setError={c.setError}
                    newTypeExt={c.newTypeExt}
                    setNewTypeExt={c.setNewTypeExt}
                    isMember={c.isMember}
                    membershipBadge={membershipBadge}
                    typeOptions={c.typeOptions}
                    defaultTypeMenuOpen={c.defaultTypeMenuOpen}
                    setDefaultTypeMenuOpen={c.setDefaultTypeMenuOpen}
                    defaultTypeActiveIndex={c.defaultTypeActiveIndex}
                    setDefaultTypeActiveIndex={c.setDefaultTypeActiveIndex}
                    defaultTypeSelectRef={c.defaultTypeSelectRef}
                    currentDefaultTypeLabel={c.currentDefaultTypeLabel}
                    pickDefaultTypeByIndex={c.pickDefaultTypeByIndex}
                    moveTypeId={c.moveTypeId}
                  />
                ) : null}
                {c.activeKey === "account" ? (
                  <AccountSection
                    user={c.user}
                    isMember={c.isMember}
                    draft={c.draft}
                    setDraft={c.setDraft}
                    setError={c.setError}
                    isRefreshingStatus={c.isRefreshingStatus}
                    doRefreshStatus={c.doRefreshStatus}
                    isLoggingOut={c.isLoggingOut}
                    handleLogout={c.handleLogout}
                    loginForm={c.loginForm}
                    setLoginForm={c.setLoginForm}
                    isLoggingIn={c.isLoggingIn}
                    loginError={c.loginError}
                    handleLogin={c.handleLogin}
                    formatDateTime={c.formatDateTime}
                  />
                ) : null}
                {c.activeKey === "shortcuts" ? (
                  <ShortcutsSection draft={c.draft} setDraft={c.setDraft} setError={c.setError} />
                ) : null}
                {c.activeKey === "appearance" ? (
                  <AppearanceSection
                    draft={c.draft}
                    setDraft={c.setDraft}
                    setError={c.setError}
                    isMember={c.isMember}
                    membershipBadge={membershipBadge}
                    applyThemePreview={c.applyThemePreview}
                    applyFontPreview={c.applyFontPreview}
                    themeOptions={c.themeOptions}
                    fontOptions={c.fontOptions}
                  />
                ) : null}
              </div>
            </div>
          </div>

          <div className="settings-footer">
            <button className="settings-cancel" type="button" onClick={c.onClose}>
              取消
            </button>
            <button className="settings-confirm" type="button" onClick={c.save}>
              确认
            </button>
          </div>
        </div>

        {c.toast ? (
          <div className={`settings-toast ${c.toast.kind}`} role="status" aria-live="polite">
            <span className="settings-toast-icon" aria-hidden="true">
              {c.toast.kind === "success" ? "✓" : c.toast.kind === "error" ? "✕" : "i"}
            </span>
            <span className="settings-toast-text">{c.toast.message}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
