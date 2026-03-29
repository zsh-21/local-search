import { IPC_MINIMIZE_WINDOW, IPC_OPEN_EXTERNAL } from "../../shared/ipc/channels";
import { IconOfficialLink } from "../components/icons/SettingsIcons";

/** 设置窗口标题栏 */
export function SettingsWindowHeader(props: {
  settingsLogoSrc: string;
  maximized: boolean;
  onToggleMax: () => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-header">
      <div
        className="settings-title-wrap"
        onDoubleClick={(e) => {
          e.stopPropagation();
          props.onToggleMax();
        }}
      >
        <img src={props.settingsLogoSrc} className="settings-logo" alt="logo" />
        <span className="settings-title">设置</span>
        <button
          type="button"
          className="settings-official-link"
          title="访问官网"
          onClick={(e) => {
            e.stopPropagation();
            window.ipcRenderer?.invoke(IPC_OPEN_EXTERNAL, "https://www.yitong.xin/");
          }}
        >
          {/* 官网按钮改为统一的外链图标，避免在同一行里混入另一套线稿。 */}
          <IconOfficialLink size={16} variant="duotone" />
        </button>
      </div>
      <div className="settings-header-spacer" />
      <div className="settings-window-controls">
        <button
          type="button"
          className="window-btn"
          onClick={() => window.ipcRenderer?.invoke(IPC_MINIMIZE_WINDOW)}
          onDoubleClick={(e) => e.stopPropagation()}
          aria-label="最小化"
          title="最小化"
        >
          <span style={{ fontSize: 14, fontWeight: 600, transform: "translateY(-2px)" }}>—</span>
        </button>
        <button
          type="button"
          className="window-btn"
          onClick={props.onToggleMax}
          onDoubleClick={(e) => e.stopPropagation()}
          aria-label="全屏/取消全屏"
          title="全屏/取消全屏"
        >
          {props.maximized ? <span style={{ fontSize: 20 }}>❐</span> : <span style={{ fontSize: 20 }}>▢</span>}
        </button>
        <button
          type="button"
          className="window-btn close"
          onClick={props.onClose}
          onDoubleClick={(e) => e.stopPropagation()}
          aria-label="关闭"
          title="关闭"
        >
          <span style={{ fontSize: 30 }}>×</span>
        </button>
      </div>
    </div>
  );
}
