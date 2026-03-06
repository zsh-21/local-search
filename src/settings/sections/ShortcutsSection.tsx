import { AppSettings } from "../../appTypes";
import { toAccelerator } from "../../settingsStore";

// 快捷键分区：监听用户按键并生成 Electron Accelerator 字符串
export function ShortcutsSection({
  draft,
  setDraft,
  setError,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
}) {
  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">快捷键</div>
        <div className="shortcut-grid">
          <div className="shortcut-row">
            <div className="shortcut-label">呼出搜索框</div>
            <input
              className="shortcut-input"
              readOnly
              value={draft.searchShortcut}
              placeholder="点击设置快捷键"
              onKeyDown={(e) => {
                e.preventDefault();
                const acc = toAccelerator(e);
                if (acc) {
                  setDraft({ ...draft, searchShortcut: acc });
                  setError("");
                }
              }}
            />
          </div>
          <div className="shortcut-row">
            <div className="shortcut-label">打开设置</div>
            <input
              className="shortcut-input"
              readOnly
              value={draft.settingsShortcut}
              placeholder="点击设置快捷键"
              onKeyDown={(e) => {
                e.preventDefault();
                const acc = toAccelerator(e);
                if (acc) {
                  setDraft({ ...draft, settingsShortcut: acc });
                  setError("");
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">面板内快捷键（固定）</div>
        <div className="shortcut-grid">
          <div className="shortcut-row">
            <div className="shortcut-label">隐藏面板</div>
            <input className="shortcut-input" readOnly value="Esc" />
          </div>
          <div className="shortcut-row">
            <div className="shortcut-label">切换类型</div>
            <input className="shortcut-input" readOnly value="Tab / Shift+Tab" />
          </div>
          {/* <div className="shortcut-row">
            <div className="shortcut-label">聚焦输入</div>
            <input className="shortcut-input" readOnly value="Ctrl/Cmd+L 或 Ctrl/Cmd+K" />
          </div> */}
          <div className="shortcut-row">
            <div className="shortcut-label">打开/运行</div>
            <input className="shortcut-input" readOnly value="Enter" />
          </div>
          <div className="shortcut-row">
            <div className="shortcut-label">打开目录</div>
            <input className="shortcut-input" readOnly value="Ctrl/Cmd+Enter" />
          </div>
          <div className="shortcut-row">
            <div className="shortcut-label">上下选择</div>
            <input className="shortcut-input" readOnly value="↑ / ↓" />
          </div>
          <div className="shortcut-row">
            <div className="shortcut-label">跳到首尾</div>
            <input className="shortcut-input" readOnly value="Home / End" />
          </div>
          <div className="shortcut-row">
            <div className="shortcut-label">翻页选择</div>
            <input className="shortcut-input" readOnly value="PageUp / PageDown" />
          </div>
        </div>
      </div>
    </div>
  );
}
