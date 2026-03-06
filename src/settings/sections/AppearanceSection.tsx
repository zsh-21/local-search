import { ReactNode } from "react";
import { AppSettings } from "../../appTypes";

// 外观分区：主题模式、特效开关/类型、背景图片、主题色（含会员禁用）
export function AppearanceSection({
  draft,
  setDraft,
  setError,
  isMember,
  membershipBadge,
  applyThemePreview,
  themeColors,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  applyThemePreview: (theme: AppSettings["theme"], accentColor: string) => void;
  themeColors: { name: string; color: string }[];
}) {
  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">主题界面</div>
        <div className="theme-grid">
          <button
            type="button"
            className={`theme-card dark ${draft.theme === "dark" ? "active" : ""}`}
            onClick={() => {
              // 主题切换即时生效，避免保存前视觉不一致
              setDraft({ ...draft, theme: "dark" });
              document.documentElement.dataset.theme = "dark";
            }}
          >
            <div className="theme-preview" />
            <span>深色模式</span>
          </button>
          <button
            type="button"
            className={`theme-card light ${draft.theme === "light" ? "active" : ""}`}
            onClick={() => {
              // 主题切换即时生效，避免保存前视觉不一致
              setDraft({ ...draft, theme: "light" });
              document.documentElement.dataset.theme = "light";
            }}
          >
            <div className="theme-preview" />
            <span>浅色模式</span>
          </button>
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
              // 非会员禁用特效，避免保存后被回退产生困惑
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
                代码瀑布
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
                极速穿梭
              </label>
            </div>
          </div>
        )}
      </div>

      {/* 背景图片为订阅功能：非会员只允许使用默认背景 */}
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
