import type { ReactNode } from "react";
import { AccountSection } from "./sections/AccountSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { GeneralSection } from "./sections/GeneralSection";
import { SearchSection } from "./sections/SearchSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { SettingsSearchPreview } from "./components/SettingsSearchPreview";
import type { SettingsController, SettingsSectionMeta } from "./settingsViewTypes";

/** 设置页右侧内容区 */
export function SettingsTabContent(props: {
  c: SettingsController;
  isSearchTab: boolean;
  currentMeta: SettingsSectionMeta;
  membershipBadge: ReactNode;
}) {
  const { c, isSearchTab, currentMeta, membershipBadge } = props;
  return (
    <div className="settings-main">
      <div className="settings-main-inner">
        <div className={`settings-section-header ${isSearchTab ? "search-preview-header" : ""}`}>
          {isSearchTab ? (
            <SettingsSearchPreview draft={c.draft} currentDefaultTypeLabel={c.currentDefaultTypeLabel} />
          ) : (
            <>
              <div className="settings-section-title">{currentMeta.title}</div>
              <div className="settings-section-desc">{currentMeta.desc}</div>
            </>
          )}
        </div>

        {c.activeKey === "general" ? <GeneralSection draft={c.draft} setDraft={c.setDraft} setError={c.setError} /> : null}
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
        {c.activeKey === "shortcuts" ? <ShortcutsSection draft={c.draft} setDraft={c.setDraft} setError={c.setError} /> : null}
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
  );
}
