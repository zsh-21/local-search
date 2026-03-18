import { ReactNode } from "react";
import { AppSettings } from "../../appTypes";

// 外观分区：主题模式、特效、背景图、主题色与字体预览。
export function AppearanceSection({
  draft,
  setDraft,
  setError,
  isMember,
  membershipBadge,
  applyThemePreview,
  applyFontPreview,
  themeColors,
  themeOptions,
  fontOptions,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  applyThemePreview: (theme: AppSettings["theme"], accentColor: string) => void;
  applyFontPreview: (fontFamily: string) => void;
  themeColors: { name: string; color: string }[];
  themeOptions: { id: AppSettings["theme"]; label: string }[];
  fontOptions: { id: string; label: string; value: string; sample: string }[];
}) {
  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">主题界面</div>
        <div className="theme-grid">
          {themeOptions.map((opt) => {
            const active = draft.theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`theme-card theme-${opt.id} ${active ? "active" : ""}`}
                onClick={() => {
                  // 主题切换立即预览，确认保存后再全局持久化生效。
                  const nextTheme = opt.id;
                  setDraft({ ...draft, theme: nextTheme });
                  applyThemePreview(nextTheme, draft.accentColor);
                  setError("");
                }}
              >
                <div className="theme-preview" />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">字体</div>
        <div className="font-grid">
          {fontOptions.map((opt) => {
            const active = draft.uiFontFamily === opt.value;
            return (
              <button
                key={opt.id}
                type="button"
                className={`font-card ${active ? "active" : ""}`}
                style={{ fontFamily: opt.value }}
                onClick={() => {
                  setDraft({ ...draft, uiFontFamily: opt.value });
                  applyFontPreview(opt.value);
                  setError("");
                }}
              >
                <div className="font-preview">{opt.sample}</div>
                <div className="font-name">{opt.label}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">
          <span>特效</span>
          {membershipBadge}
        </div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.enableEffect}
            disabled={!isMember}
            onChange={(e) => {
              // 非会员禁用高级特效，避免保存后被系统回退造成困惑。
              setDraft({ ...draft, enableEffect: e.target.checked });
              setError("");
            }}
          />
          <span>启用背景特效</span>
        </label>
        {draft.enableEffect && (
          <div className="form-row">
            <div className="form-label">特效类型</div>
            <div className="effect-type-options">
              <label className={`effect-option ${draft.effectType === "particles" ? "active" : ""}`}>
                <input
                  type="radio"
                  name="effectType"
                  value="particles"
                  checked={draft.effectType === "particles"}
                  onChange={() => {
                    setDraft({ ...draft, effectType: "particles" });
                    setError("");
                  }}
                />
                粒子
              </label>
              <label className={`effect-option ${draft.effectType === "warp" ? "active" : ""}`}>
                <input
                  type="radio"
                  name="effectType"
                  value="warp"
                  checked={draft.effectType === "warp"}
                  onChange={() => {
                    setDraft({ ...draft, effectType: "warp" });
                    setError("");
                  }}
                />
                穿梭
              </label>
            </div>
          </div>
        )}
      </div>

      {/* 背景图片为会员能力：非会员可看见入口但不可修改。 */}
      <div className="settings-group">
        <div className="settings-group-title">
          <span>背景图片</span>
          {membershipBadge}
        </div>
        <div className="form-row">
          <div className="form-label">图片</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="small-btn"
              disabled={!isMember}
              onClick={async () => {
                setError("");
                const resp = (await window.ipcRenderer?.invoke("select-background-image")) as
                  | { ok: boolean; path?: string; message?: string }
                  | undefined;
                if (!resp?.ok) {
                  setError(resp?.message || "选择图片失败");
                  return;
                }
                const p = typeof resp.path === "string" ? resp.path : "";
                if (!p) return;
                setDraft({ ...draft, backgroundImagePath: p });
              }}
            >
              选择图片
            </button>
            <button
              type="button"
              className="small-btn"
              disabled={!isMember || !draft.backgroundImagePath}
              onClick={() => {
                setDraft({ ...draft, backgroundImagePath: "" });
                setError("");
              }}
            >
              清除
            </button>
            <span style={{ color: "var(--fs-muted)", fontSize: 12, fontWeight: 650 }}>
              {draft.backgroundImagePath
                ? draft.backgroundImagePath.split(/[/\\]/).pop() || draft.backgroundImagePath
                : "未选择"}
            </span>
          </div>
        </div>
        <div className="form-row">
          <div className="form-label">透明度</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
            <input
              type="range"
              min={0}
              max={100}
              disabled={!isMember}
              value={Math.round((draft.backgroundImageOpacity || 0) * 100)}
              onChange={(e) => {
                const v = Number(e.target.value);
                const next = Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0;
                setDraft({ ...draft, backgroundImageOpacity: next });
                setError("");
              }}
              style={{ flex: 1, minWidth: 100 }}
            />
            <span style={{ color: "var(--fs-muted)", fontSize: 12, fontWeight: 750, width: 44, textAlign: "right" }}>
              {Math.round((draft.backgroundImageOpacity || 0) * 100)}%
            </span>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">
          <span>主题色</span>
          {membershipBadge}
        </div>
        <div className="accent-color-grid">
          {themeColors.map((item) => (
            <button
              key={item.color}
              type="button"
              className={`accent-color-item ${draft.accentColor === item.color ? "active" : ""}`}
              style={{ "--item-color": item.color } as any}
              disabled={!isMember}
              onClick={() => {
                setDraft({ ...draft, accentColor: item.color });
                applyThemePreview(draft.theme, item.color);
              }}
              title={isMember ? item.name : undefined}
            >
              <div className="accent-color-dot" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
