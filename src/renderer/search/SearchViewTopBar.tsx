import type { useSearchController } from "./useSearchController";
import {
  IconClear,
  IconPin,
  IconSearch,
  IconSettings,
} from "../components/icons/SettingsIcons";

/** 搜索控制器类型别名 */
type SearchController = ReturnType<typeof useSearchController>;

/** 顶部搜索栏 */
export function SearchViewTopBar(props: {
  c: SearchController;
  pinButtonTitle: string;
  pinButtonAriaLabel: string;
}) {
  const { c, pinButtonTitle, pinButtonAriaLabel } = props;
  return (
    <div className="search-box">
      <div className="search-icon-wrapper">
        <IconSearch size={18} className="search-icon-svg" variant="mono" />
      </div>
      <div className="search-input-wrap">
        <input
          ref={c.inputRef}
          type="text"
          value={c.inputValue}
          onChange={(e) => {
            c.clearActionSelection();
            c.setQuery(e.target.value);
          }}
          placeholder={c.placeholder}
          autoFocus
        />
        {c.ghostSuffixValue ? (
          <span className="search-ghost-value" aria-hidden="true">
            <span className="search-ghost-prefix">{c.inputValue}</span>
            <span className="search-ghost-suffix">{c.ghostSuffixValue}</span>
          </span>
        ) : null}
      </div>
      <div className="search-box-right">
        {c.inputValue.trim().length > 0 ? (
          <button
            type="button"
            className="clear-btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              c.clearSearchInput();
            }}
            aria-label="清空输入"
            title="清空 (Ctrl+L)"
          >
            <IconClear size={14} variant="mono" />
          </button>
        ) : null}
        <div className="type-select" ref={c.typeSelectRef}>
          <span className="type-select-text">{c.currentTypeLabel}</span>
        </div>
      </div>
      <button
        className="settings-btn"
        onClick={() => {
          c.clearActionSelection();
          c.openSettings();
        }}
        type="button"
        title={`打开设置面板 (${c.settings.settingsShortcut})`}
      >
        <IconSettings size={20} />
      </button>
      <button
        type="button"
        className={`pin-btn ${c.isPanelPinned ? "active" : "inactive"}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          c.togglePanelPinned();
        }}
        aria-label={pinButtonAriaLabel}
        title={pinButtonTitle}
      >
        {/* 非固定态沿用同一图标语义，仅通过样式区分“无背景 + 更暗”视觉。 */}
        <IconPin size={17} />
      </button>
    </div>
  );
}
