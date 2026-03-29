import { ReactNode } from "react";
import { AppSettings } from "../../appTypes";
import { IPC_SELECT_BACKGROUND_IMAGE } from "../../../shared/ipc/channels";
// 外观分区：主题、字体与背景图。
export function AppearanceSection({
  draft,
  setDraft,
  setError,
  isMember,
  membershipBadge,
  applyThemePreview,
  applyFontPreview,
  themeOptions,
  fontOptions,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  applyThemePreview: (theme: AppSettings["theme"]) => void;
  applyFontPreview: (fontFamily: string) => void;
  themeOptions: { id: AppSettings["theme"]; label: string }[];
  fontOptions: { id: string; label: string; value: string; sample: string }[];
}) {
  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">主题界面</div>
        <div className="settings-hint">切换全局配色与材质风格，点击后立即预览，保存后作为默认主题。</div>
        <div className="theme-grid">
          {themeOptions.map((opt) => {
            const active = draft.theme === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`theme-card theme-${opt.id} ${active ? "active" : ""}`}
                onClick={() => {
                  const nextTheme = opt.id;
                  setDraft({ ...draft, theme: nextTheme });
                  applyThemePreview(nextTheme);
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
        <div className="settings-hint">切换应用整体字体方案，用于优化中文可读性与英文字符观感。</div>
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
          <span>背景图片</span>
          {membershipBadge}
        </div>
        <div className="settings-hint">设置窗口与搜索面板的背景图，并可调整透明度；订阅账号可用。</div>
        <div className="form-row">
          <div className="form-label">图片</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="small-btn"
              disabled={!isMember}
              onClick={async () => {
                setError("");
                const resp = (await window.ipcRenderer?.invoke(IPC_SELECT_BACKGROUND_IMAGE)) as
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
    </div>
  );
}
