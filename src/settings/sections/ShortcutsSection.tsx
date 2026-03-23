import { AppSettings } from "../../appTypes";
import { IconShortcuts } from "../../components/icons/SettingsIcons";
import { toAccelerator } from "../../settingsStore";

// 快捷键分区：卡片化布局不改变原快捷键采集与保存逻辑。
export function ShortcutsSection({
  draft,
  setDraft,
  setError,
}: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
}) {
  const fixedShortcuts: Array<{ title: string; value: string; desc: string }> = [
    { title: "隐藏面板", value: "Esc", desc: "关闭当前搜索面板" },
    { title: "固定面板", value: "Alt+T", desc: "固定搜索面板（失焦不隐藏）" },
    { title: "切换类型", value: "Tab / Shift+Tab", desc: "切换搜索类型筛选" },
    { title: "打开/运行", value: "Enter", desc: "执行当前选中结果" },
    { title: "打开目录", value: "Ctrl+Enter", desc: "打开选中项所在目录" },
    { title: "上下选择", value: "↑ / ↓", desc: "在结果列表中移动" },
    { title: "跳到首尾", value: "Home / End", desc: "快速跳到首项或末项" },
    { title: "分页选择", value: "PageUp / PageDown", desc: "按页移动选中位置" },
    { title: "切换右侧按钮", value: "Ctrl+← / Ctrl+→", desc: "切换结果项动作按钮" },
  ];

  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">快捷键</div>

        <div className="setting-item-card">
          <div className="setting-item-main">
            <span className="setting-item-icon" aria-hidden="true">
              <IconShortcuts size={18} />
            </span>
            <div className="setting-item-copy">
              <div className="setting-item-title">呼出搜索面板</div>
              <div className="setting-item-desc">全局快捷键，按下后显示搜索面板。</div>
            </div>
          </div>
          <input
            className="shortcut-input"
            readOnly
            value={draft.searchShortcut}
            placeholder="点击后按下快捷键"
            onKeyDown={(e) => {
              e.preventDefault();
              const acc = toAccelerator(e);
              if (!acc) return;
              setDraft({ ...draft, searchShortcut: acc });
              setError("");
            }}
          />
        </div>

        <div className="setting-item-card">
          <div className="setting-item-main">
            <span className="setting-item-icon" aria-hidden="true">
              <IconShortcuts size={18} />
            </span>
            <div className="setting-item-copy">
              <div className="setting-item-title">打开设置面板</div>
              <div className="setting-item-desc">全局快捷键，快速进入设置窗口。</div>
            </div>
          </div>
          <input
            className="shortcut-input"
            readOnly
            value={draft.settingsShortcut}
            placeholder="点击后按下快捷键"
            onKeyDown={(e) => {
              e.preventDefault();
              const acc = toAccelerator(e);
              if (!acc) return;
              setDraft({ ...draft, settingsShortcut: acc });
              setError("");
            }}
          />
        </div>

        <div className="setting-item-card">
          <div className="setting-item-main">
            <span className="setting-item-icon" aria-hidden="true">
              <IconShortcuts size={18} />
            </span>
            <div className="setting-item-copy">
              <div className="setting-item-title">写入选中项</div>
              <div className="setting-item-desc">把当前选中结果写入输入框，便于继续编辑。</div>
            </div>
          </div>
          <input
            className="shortcut-input"
            readOnly
            value={draft.acceptSelectedResultShortcut}
            placeholder="点击后按下快捷键"
            onKeyDown={(e) => {
              e.preventDefault();
              const acc = toAccelerator(e);
              if (!acc) return;
              setDraft({ ...draft, acceptSelectedResultShortcut: acc });
              setError("");
            }}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">面板内快捷键（固定）</div>
        {fixedShortcuts.map((item) => (
          <div className="setting-item-card" key={item.title}>
            <div className="setting-item-main">
              <span className="setting-item-icon" aria-hidden="true">
                <IconShortcuts size={18} />
              </span>
              <div className="setting-item-copy">
                <div className="setting-item-title">{item.title}</div>
                <div className="setting-item-desc">{item.desc}</div>
              </div>
            </div>
            <input className="shortcut-input" readOnly value={item.value} />
          </div>
        ))}
      </div>
    </div>
  );
}
