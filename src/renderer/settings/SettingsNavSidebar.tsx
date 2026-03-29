import { IconAccount } from "../components/icons/SettingsIcons";
import type { SettingsController, SettingsNavItem } from "./settingsViewTypes";

/** 设置页左侧导航 */
export function SettingsNavSidebar(props: {
  c: SettingsController;
  avatarDataUrl: string;
  navItems: SettingsNavItem[];
}) {
  const { c, avatarDataUrl, navItems } = props;
  return (
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
              <IconAccount size={20} variant="duotone" className="settings-nav-account-avatar-icon" />
            )}
          </span>
        </div>
        <span className="settings-nav-account-meta">
          <span className="settings-nav-account-name">{c.user ? c.user.nickname || c.user.phone || c.user.email : "未登录"}</span>
          <span className="settings-nav-account-sub">{c.user ? c.user.email || c.user.phone || "" : "点击登录"}</span>
        </span>
      </button>

      <div className="settings-nav-divider" aria-hidden="true" />
      {navItems.map((item) => (
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
  );
}
