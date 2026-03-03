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
    </div>
  );
}
