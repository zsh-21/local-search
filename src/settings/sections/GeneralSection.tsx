import { AppSettings } from "../../appTypes";

// 通用设置分区：开机自启、搜索状态保留、历史记录开关与数量
export function GeneralSection({
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
        <div className="settings-group-title">启动</div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.autoStart}
            onChange={(e) => {
              setDraft({ ...draft, autoStart: e.target.checked });
              setError("");
            }}
          />
          <span>跟随此电脑启动自动运行</span>
        </label>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">搜索状态</div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.keepStateOnClose}
            onChange={(e) => {
              setDraft({ ...draft, keepStateOnClose: e.target.checked });
              setError("");
            }}
          />
          <span>呼出面板时保留上一次的状态</span>
        </label>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">历史记录</div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.enableHistory}
            onChange={(e) => {
              setDraft({ ...draft, enableHistory: e.target.checked });
              setError("");
            }}
          />
          <span>记录历史操作</span>
        </label>
        <div className="form-row">
          <div className="form-label">最大展示数量</div>
          <input
            className="number-input"
            type="number"
            min={0}
            max={50}
            step={1}
            value={draft.historyLimit}
            onChange={(e) => {
              const n = Number(e.target.value);
              setDraft({
                ...draft,
                historyLimit: Number.isFinite(n)
                  ? Math.min(50, Math.max(0, Math.floor(n)))
                  : 5,
              });
              setError("");
            }}
          />
        </div>
        <div className="form-row">
          <div className="form-label">历史操作</div>
          <button
            type="button"
            className="small-btn"
            onClick={async () => {
              setError("");
              const ok = window.confirm(
                "确定要清除所有历史记录吗？此操作不可恢复。",
              );
              if (!ok) return;
              await window.ipcRenderer?.invoke("clear-history");
            }}
          >
            清除所有历史操作记录
          </button>
        </div>
      </div>
    </div>
  );
}
