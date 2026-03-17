import { useEffect, useMemo, useRef, useState } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import { ParticleBackground } from "../components/ParticleBackground";
import { useSettingsController, SettingsTabKey } from "./useSettingsController";
import { GeneralSection } from "./sections/GeneralSection";
import { SearchSection } from "./sections/SearchSection";
import { AccountSection } from "./sections/AccountSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { AppearanceSection } from "./sections/AppearanceSection";

// 设置页渲染层：负责整体布局与导航，具体逻辑集中在 useSettingsController，分区 UI 下沉到 sections
const NAV_ITEMS: { key: Exclude<SettingsTabKey, "account">; label: string; icon: JSX.Element }[] = [
  {
    key: "general",
    label: "通用",
    icon: (
      <svg width="16" height="16" viewBox="0 0 25 25" fill="none" aria-hidden="true">
        <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    ),
  },
  {
    key: "search",
    label: "搜索",
    icon: (
      <svg width="16" height="16" viewBox="0 0 22 22" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
        <path d="m20 20-3.3-3.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "shortcuts",
    label: "快捷键",
    icon: (
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M7 15a4 4 0 1 1 0-8h6a4 4 0 1 1 0 8H7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M10 9v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M14 9v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "appearance",
    label: "外观",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3a9 9 0 1 0 9 9c0-.4-.03-.8-.08-1.19A7 7 0 0 1 12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const SECTION_META: Record<SettingsTabKey, { title: string; desc: string }> = {
  general: { title: "通用", desc: "启动、状态与历史记录" },
  search: { title: "搜索", desc: "默认类型、自定义类型与顺序" },
  shortcuts: { title: "快捷键", desc: "呼出搜索与打开设置" },
  appearance: { title: "外观", desc: "主题模式与主题色" },
  account: { title: "账号", desc: "登录与账号状态" },
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

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className={`container settings-container ${c.maximized ? "maximized" : ""}`}
      onKeyDown={handleKeyDown}
    >
      <BackgroundImage path={c.draft.backgroundImagePath} opacity={c.draft.backgroundImageOpacity} />
      <ParticleBackground enabled={c.draft.enableEffect} type={c.draft.effectType} />

      <div className="settings-header" title="按住拖拽可移动窗口">
        <div
          className="settings-title-wrap"
          onDoubleClick={(e) => {
            e.stopPropagation();
            c.onToggleMax();
          }}
          title="双击全屏/取消全屏"
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
                <div className="settings-section-header">
                  <div className="settings-section-title">{currentMeta.title}</div>
                  <div className="settings-section-desc">{currentMeta.desc}</div>
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
                    themeColors={c.themeColors}
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
