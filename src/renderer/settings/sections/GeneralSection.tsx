import { AppSettings } from "../../appTypes";
import { IconHistory, IconPower, IconState } from "../../components/icons/SettingsIcons";
import { handleNumericStepperKeyDown } from "../numericInputStepper";
import { IPC_CLEAR_HISTORY } from "../../../shared/ipc/channels";

// 通用分区：统一使用卡片行布局，右侧保持原有开关和输入逻辑。
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
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">通用</div>

        <div className="setting-item-card">
          <div className="setting-item-main">
            <span className="setting-item-icon" aria-hidden="true">
              {/* 设置分区图标使用双色叠层：增强层次，同时保持整体风格统一。 */}
              <IconPower size={20} variant="duotone" />
            </span>
            <div className="setting-item-copy">
              <div className="setting-item-title">开机自启</div>
              {/* 说明文案补充使用场景，帮助用户理解影响范围。 */}
              <div className="setting-item-desc">随系统启动自动运行搜索面板，减少手动打开步骤。</div>
            </div>
          </div>
          <label className="setting-item-control" aria-label="开机自启">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(e) => {
                setDraft({ ...draft, autoStart: e.target.checked });
                setError("");
              }}
            />
          </label>
        </div>

        <div className="setting-item-card">
          <div className="setting-item-main">
            <span className="setting-item-icon" aria-hidden="true">
              {/* 设置分区图标使用双色叠层：增强层次，同时保持整体风格统一。 */}
              <IconState size={20} variant="duotone" />
            </span>
            <div className="setting-item-copy">
              <div className="setting-item-title">保留搜索状态</div>
              {/* 说明文案补充状态含义，避免用户误解为“清空/缓存”。 */}
              <div className="setting-item-desc">关闭窗口后仍保留输入与选中，便于继续上次操作。</div>
            </div>
          </div>
          <label className="setting-item-control" aria-label="保留搜索状态">
            <input
              type="checkbox"
              checked={draft.keepStateOnClose}
              onChange={(e) => {
                setDraft({ ...draft, keepStateOnClose: e.target.checked });
                setError("");
              }}
            />
          </label>
        </div>

        <div className="setting-item-card setting-item-card-stack">
          <div className="setting-item-main">
            <span className="setting-item-icon" aria-hidden="true">
              {/* 设置分区图标使用双色叠层：增强层次，同时保持整体风格统一。 */}
              <IconHistory size={20} variant="duotone" />
            </span>
            <div className="setting-item-copy">
              <div className="setting-item-title">历史记录</div>
              {/* 说明文案补充性能与容量影响，帮助理解开关意义。 */}
              <div className="setting-item-desc">控制历史记录开关、最大条数与清理动作，避免记录过多影响性能。</div>
            </div>
          </div>
          <label className="setting-item-control" aria-label="启用历史记录">
            <input
              type="checkbox"
              checked={draft.enableHistory}
              onChange={(e) => {
                setDraft({ ...draft, enableHistory: e.target.checked });
                setError("");
              }}
            />
          </label>
          <div className="setting-item-extra">
            <div className="form-row">
              <div className="form-label">最大显示数量</div>
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
                    historyLimit: Number.isFinite(n) ? Math.min(50, Math.max(0, Math.floor(n))) : 5,
                  });
                  setError("");
                }}
                onKeyDown={(e) => {
                  // 历史条数支持方向键步进，同时保留手动输入
                  handleNumericStepperKeyDown(e, {
                    min: 0,
                    max: 50,
                    integer: true,
                    step: 1,
                    fallbackValue: draft.historyLimit,
                    onValueChange: (nextValue) => {
                      setDraft({ ...draft, historyLimit: nextValue });
                      setError("");
                    },
                  });
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
                  const ok = window.confirm("确定要清除历史记录吗？此操作不可恢复。");
                  if (!ok) return;
                  await window.ipcRenderer?.invoke(IPC_CLEAR_HISTORY);
                }}
              >
                清除历史操作记录
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
