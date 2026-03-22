import { useEffect, useMemo, useRef, useState } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import { useSettingsController, SettingsTabKey } from "./useSettingsController";
import { GeneralSection } from "./sections/GeneralSection";
import { SearchSection } from "./sections/SearchSection";
import { AccountSection } from "./sections/AccountSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import {
  IconAccount,
  IconAppearance,
  IconCommand,
  IconClear,
  IconCopyPath,
  IconFolder,
  IconFile,
  IconGeneral,
  IconOfficialLink,
  IconOpenFolder,
  IconPinOff,
  IconRunAsAdmin,
  IconSearch,
  IconSettings,
  IconShortcuts,
} from "../components/icons/SettingsIcons";
import type { AppSettings } from "../appTypes";

// 亮色主题集合：用于切换设置页左上角 Logo（黑/白），保证浅背景下有足够对比度。
const LIGHT_THEMES = new Set(["chrome", "mac", "paper"]);

// 设置页渲染层：负责整体布局与导航，具体逻辑集中在 useSettingsController，分区 UI 下沉到 sections
const NAV_ITEMS: { key: Exclude<SettingsTabKey, "account">; label: string; icon: JSX.Element }[] = [
  // 设置侧栏图标统一复用组件，避免在业务组件中继续堆叠内联 SVG。
  { key: "general", label: "通用", icon: <IconGeneral size={17} variant="duotone" /> },
  { key: "search", label: "搜索", icon: <IconSearch size={17} variant="duotone" /> },
  { key: "shortcuts", label: "快捷键", icon: <IconShortcuts size={17} variant="duotone" /> },
  { key: "appearance", label: "外观", icon: <IconAppearance size={17} variant="duotone" /> },
];

const SECTION_META: Record<SettingsTabKey, { title: string; desc: string }> = {
  general: { title: "通用", desc: "启动、状态与历史记录" },
  search: { title: "搜索", desc: "默认类型、窗口参数与结果行为" },
  shortcuts: { title: "快捷键", desc: "呼出搜索与面板内快捷操作" },
  // 特效能力已下线：外观分区仅保留主题、字体与背景图配置。
  appearance: { title: "外观", desc: "主题、字体与背景图" },
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
// 为了让用户在预览区看到“所有类型”的真实样式，这里补齐每种类型的代表样本。
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
      // 预览区文件夹结果与真实搜索页保持一致，统一使用彩色文件夹图标。
      return <IconFolder size={35} className="result-icon" />;
    }
    if (item.type === "settings") {
      // 设置结果沿用专门的设置图标，和主页面的结果列表保持同一套语义。
      return <IconSettings size={35} className="result-icon" />;
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
      // 命令类型预览改用 sprite 图标：避免内联 SVG 导致风格与主题色不一致。
      return <IconCommand size={35} className="result-icon" />;
    }

    // 未覆盖类型的兜底图标也统一使用 sprite，避免“剩一个内联 SVG”破坏整体一致性。
    return <IconFile size={35} className="result-icon" />;
  };

  const isLimitedByDisplayCount = (Number(draft.searchDisplayLimit) || 0) < previewRows.length;

  return (
    <div className="settings-search-preview" aria-hidden="true">
      <div className={`container search-container ${draft.compactMode ? "compact" : ""}`}>
          {/* 顶部搜索框完整复用真实结构：保证视觉与真实搜索面板一致 */}
          <div className="search-box">
            <div className="search-icon-wrapper">
              {/* 预览区搜索入口与主页面保持同一套彩色图标。 */}
              <IconSearch size={18} className="search-icon-svg" />
            </div>
            <div className="search-input-wrap">
              <input type="text" readOnly tabIndex={-1} value="ui-ux-pro-max" aria-label="搜索预览输入框" />
            </div>
            <div className="search-box-right">
              <button type="button" className="clear-btn" tabIndex={-1} aria-label="清空输入" title="清空 (Ctrl+L)">
                {/* 清空图标改为统一组件，避免预览和主页面出现两套写法。 */}
                <IconClear size={14} />
              </button>
              <div className="type-select">
                {/* 预览区移除类型下拉，仅展示当前类型文案，避免与真实面板交互造成误解。 */}
                <span className="type-select-text">{currentDefaultTypeLabel}</span>
              </div>
            </div>
            <button className="settings-btn" type="button" tabIndex={-1} title="打开设置面板">
              {/* 预览区设置按钮沿用统一设置图标，减少视觉断层。 */}
              <IconSettings size={18} />
            </button>
            <button type="button" className="pin-btn" tabIndex={-1} aria-label="固定搜索面板" title="固定 (Alt+T)">
              {/* 固定按钮使用与搜索面板一致的图标与尺寸：状态仅通过 active 高亮表达。 */}
              <IconPinOff size={18} />
            </button>
          </div>

          <div className="results">
            {/* 预览搜索面板一次只需要看到 3 条结果：超出的通过滚动查看，避免设置页被长列表撑高。 */}
            <div className="settings-preview-results-scroll">
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
                            <IconOpenFolder size={16} />
                          </button>
                        ) : null}
                        {actionIds.includes("copyPath") ? (
                          <button type="button" className="action-btn" data-action-id="copyPath" tabIndex={-1}>
                            <IconCopyPath size={16} />
                          </button>
                        ) : null}
                        {actionIds.includes("runAsAdmin") ? (
                          <button type="button" className="action-btn" data-action-id="runAsAdmin" tabIndex={-1}>
                            <IconRunAsAdmin size={16} />
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
  const settingsLogoSrc = useMemo(() => {
    // 设置页左上角 Logo 需要在亮/暗主题下切换黑白：避免浅色主题里白色描边对比度不足。
    return LIGHT_THEMES.has(c.draft.theme) ? "tray-black.svg" : "tray.svg";
  }, [c.draft.theme]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`container settings-container ${c.maximized ? "maximized" : ""}`}
      onKeyDown={handleKeyDown}
    >
      <BackgroundImage path={c.draft.backgroundImagePath} opacity={c.draft.backgroundImageOpacity} />

      <div className="settings-header" >
        <div
          className="settings-title-wrap"
          onDoubleClick={(e) => {
            e.stopPropagation();
            c.onToggleMax();
          }}
        >
          <img src={settingsLogoSrc} className="settings-logo" alt="logo" />
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
            {/* 官网按钮改为统一的外链图标，避免在同一行里混入另一套线稿。 */}
            <IconOfficialLink size={14} variant="duotone" />
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
                      <IconAccount size={18} variant="duotone" className="settings-nav-account-avatar-icon" />
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
