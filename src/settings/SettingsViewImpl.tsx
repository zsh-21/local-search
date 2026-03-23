import { useEffect, useMemo, useRef, useState } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import { useSettingsController, SettingsTabKey } from "./useSettingsController";
import { GeneralSection } from "./sections/GeneralSection";
import { SearchSection } from "./sections/SearchSection";
import { AccountSection } from "./sections/AccountSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { SettingsSearchPreview } from "./components/SettingsSearchPreview";
import {
  IconAccount,
  IconAppearance,
  IconGeneral,
  IconOfficialLink,
  IconSearch,
  IconShortcuts,
} from "../components/icons/SettingsIcons";

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
