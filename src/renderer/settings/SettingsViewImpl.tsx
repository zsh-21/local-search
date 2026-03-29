import { useEffect, useMemo, useRef, useState } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import { useSettingsController, type SettingsTabKey } from "./useSettingsController";
import { IconAppearance, IconGeneral, IconSearch, IconShortcuts } from "../components/icons/SettingsIcons";
import { IPC_EVENT_SETTINGS_WINDOW_OPENED, IPC_GET_IMAGE_DATA_URL } from "../../shared/ipc/channels";
import { SettingsNavSidebar } from "./SettingsNavSidebar";
import { SettingsTabContent } from "./SettingsTabContent";
import { SettingsWindowHeader } from "./SettingsWindowHeader";
import type { SettingsNavItem, SettingsSectionMeta } from "./settingsViewTypes";

/** 亮色主题集合：用于切换设置页左上角 Logo（黑/白），保证浅背景下有足够对比度。 */
const LIGHT_THEMES = new Set(["chrome", "mac", "paper"]);

/** 设置页侧栏导航 */
const NAV_ITEMS: SettingsNavItem[] = [
  { key: "general", label: "通用", icon: <IconGeneral size={20} variant="duotone" /> },
  { key: "search", label: "搜索", icon: <IconSearch size={20} variant="duotone" /> },
  { key: "shortcuts", label: "快捷键", icon: <IconShortcuts size={20} variant="duotone" /> },
  { key: "appearance", label: "外观", icon: <IconAppearance size={20} variant="duotone" /> },
];

/** 分区标题描述 */
const SECTION_META: Record<SettingsTabKey, SettingsSectionMeta> = {
  general: { title: "通用", desc: "启动、状态与历史记录" },
  search: { title: "搜索", desc: "默认类型、窗口参数与结果行为" },
  shortcuts: { title: "快捷键", desc: "呼出搜索与面板内快捷操作" },
  appearance: { title: "外观", desc: "主题、字体与背景图" },
  account: { title: "账号", desc: "登录状态与订阅信息" },
};

/** 头像读取响应 */
type AvatarImageResponse = { ok?: boolean; dataUrl?: string };

/** 设置页视图 */
export function SettingsViewImpl() {
  const c = useSettingsController();
  const [avatarDataUrl, setAvatarDataUrl] = useState("");
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const membershipBadge = !c.isMember ? <span className="membership-badge">订阅可用</span> : null;
  const isSearchTab = c.activeKey === "search";
  const currentMeta = useMemo(() => SECTION_META[c.activeKey], [c.activeKey]);
  const settingsLogoSrc = useMemo(() => (LIGHT_THEMES.has(c.draft.theme) ? "tray-black.svg" : "tray.svg"), [c.draft.theme]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
      if (e.key === "Escape") c.onClose();
      return;
    }
    if (e.key === "Escape") return void c.onClose();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const keys: SettingsTabKey[] = ["account", ...NAV_ITEMS.map((x) => x.key)];
    const idx = Math.max(0, keys.indexOf(c.activeKey));
    const delta = e.key === "ArrowDown" ? 1 : -1;
    const next = keys[(idx + delta + keys.length) % keys.length];
    c.setActiveKey(next);
  };

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const p = typeof c.draft.customAvatarPath === "string" ? c.draft.customAvatarPath.trim() : "";
    if (!p) return void setAvatarDataUrl("");
    window.ipcRenderer?.invoke(IPC_GET_IMAGE_DATA_URL, p).then((raw) => {
      if (requestIdRef.current !== requestId) return;
      const resp = raw as AvatarImageResponse | undefined;
      if (resp?.ok && typeof resp.dataUrl === "string") setAvatarDataUrl(resp.dataUrl);
    }).catch(() => {});
  }, [c.draft.customAvatarPath]);

  useEffect(() => {
    const focusContainer = () => window.setTimeout(() => containerRef.current?.focus(), 0);
    focusContainer();
    window.ipcRenderer?.on(IPC_EVENT_SETTINGS_WINDOW_OPENED, focusContainer);
    return () => window.ipcRenderer?.off(IPC_EVENT_SETTINGS_WINDOW_OPENED, focusContainer);
  }, []);

  return (
    <div ref={containerRef} tabIndex={-1} className={`container settings-container ${c.maximized ? "maximized" : ""}`} onKeyDown={handleKeyDown}>
      <BackgroundImage path={c.draft.backgroundImagePath} opacity={c.draft.backgroundImageOpacity} />
      <SettingsWindowHeader settingsLogoSrc={settingsLogoSrc} maximized={c.maximized} onToggleMax={c.onToggleMax} onClose={c.onClose} />

      <div className="settings-panel">
        <div className="settings-shell">
          <div className="settings-body">
            <SettingsNavSidebar c={c} avatarDataUrl={avatarDataUrl} navItems={NAV_ITEMS} />
            <SettingsTabContent c={c} isSearchTab={isSearchTab} currentMeta={currentMeta} membershipBadge={membershipBadge} />
          </div>

          <div className="settings-footer">
            <button className="settings-cancel" type="button" onClick={c.onClose}>取消</button>
            <button className="settings-confirm" type="button" onClick={c.save}>确认</button>
          </div>
        </div>

        {c.toast ? (
          <div className={`settings-toast ${c.toast.kind}`} role="status" aria-live="polite">
            <span className="settings-toast-icon" aria-hidden="true">{c.toast.kind === "success" ? "✓" : c.toast.kind === "error" ? "✕" : "i"}</span>
            <span className="settings-toast-text">{c.toast.message}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
