import { useEffect } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import { SearchResultsPanel } from "./SearchResultsPanel";
import { useSearchController } from "./useSearchController";
import { SearchViewOverlays } from "./SearchViewOverlays";
import { SearchViewTopBar } from "./SearchViewTopBar";
import { useSearchActionTooltip } from "./useSearchActionTooltip";
import { useSearchFooterOffset } from "./useSearchFooterOffset";

/** 搜索主视图 */
export function SearchViewImpl() {
  const c = useSearchController();
  const footerOffsetPx = useSearchFooterOffset(c.containerRef);
  const actionTooltip = useSearchActionTooltip(c.selectedActionId);
  const isHistoryMode = c.query.trim().length === 0;
  const isCalcMode = c.isCalcMode;
  const indexPercent = Math.max(1, Math.min(100, Math.round((c.indexProgress || 0) * 100)));
  const statusText = c.searchActivity === "searching" ? "搜索中..." : c.searchActivity === "indexing" ? `正在索引 ${indexPercent}%` : "";
  const pinButtonTitle = c.isPanelPinned ? "取消固定 (Alt+T)" : "固定 (Alt+T)";
  const pinButtonAriaLabel = c.isPanelPinned ? "取消固定搜索面板" : "固定搜索面板";
  const containerStyle: React.CSSProperties & { "--search-footer-offset"?: string } =
    footerOffsetPx > 0 ? { "--search-footer-offset": `${footerOffsetPx}px` } : {};

  useEffect(() => {
    window.addEventListener("keydown", c.handleWindowKeyDownCapture, true);
    return () => window.removeEventListener("keydown", c.handleWindowKeyDownCapture, true);
  }, [c.handleWindowKeyDownCapture]);

  return (
    <div
      className={`container search-container ${c.typeMenuOpen ? "menu-open" : ""} ${c.settings.compactMode ? "compact" : ""} ${footerOffsetPx > 0 ? "footer-docked" : ""}`}
      ref={c.containerRef}
      style={containerStyle}
      onClickCapture={(e) => {
        c.clearActionSelection();
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const hitInteractive = Boolean(target.closest(".search-box, .results li, .type-select-menu, .action-btn, .back-to-top-btn, .settings-toast, .fs-tooltip-pop"));
        if (hitInteractive || c.isPanelPinned) return;
        c.hideWindow();
      }}
    >
      <BackgroundImage path={c.settings.backgroundImagePath} opacity={c.settings.backgroundImageOpacity} />
      <SearchViewOverlays actionTooltip={actionTooltip} toast={c.toast} />
      <SearchViewTopBar c={c} pinButtonTitle={pinButtonTitle} pinButtonAriaLabel={pinButtonAriaLabel} />
      {statusText ? (
        <div className="status">
          <span className="spinner" />
          <span className="status-text">{statusText}</span>
        </div>
      ) : null}
      <SearchResultsPanel c={c} isHistoryMode={isHistoryMode} isCalcMode={isCalcMode} statusText={statusText} />
    </div>
  );
}
