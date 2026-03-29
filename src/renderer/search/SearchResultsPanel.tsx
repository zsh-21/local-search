import { memo, useCallback, useMemo } from "react";
import { List, type RowComponentProps } from "react-window";
import { IconChevronUp } from "../components/icons/SettingsIcons";
import { parseSearchMatchIntent } from "../../shared/utils/searchMatch";
import { normalizeResultKey } from "./searchResultUtils";
import { SearchResultRow } from "./SearchResultRow";
import { SearchResultsBottomInfo } from "./SearchResultsBottomInfo";
import { getVisibleActionIdsForItem } from "./searchResultsPanelActions";
import { areSearchResultsPanelPropsEqual, type SearchResultsPanelProps } from "./searchResultsPanelMemo";

/** 搜索结果面板主体 */
function SearchResultsPanelImpl({ c, isHistoryMode, isCalcMode, statusText }: SearchResultsPanelProps) {
  const highlightIntent = useMemo(() => parseSearchMatchIntent(c.trimmedQuery), [c.trimmedQuery]);
  const highlightPathMode = highlightIntent.matchTarget === "path" && highlightIntent.tokens.length > 0;
  const highlightNameMode = highlightIntent.matchTarget === "name" && highlightIntent.tokens.length > 0;
  const stableRowProps = useMemo(() => ({} as Record<string, never>), []);

  const rowRenderer = useCallback(({ index, style, ariaAttributes }: RowComponentProps<Record<string, never>>) => {
    const item = c.visibleResults[index];
    if (!item) return null;
    return (
      <SearchResultRow
        index={index}
        item={item}
        style={style}
        ariaAttributes={ariaAttributes}
        isSelected={index === c.selectedIndex}
        hoveredKey={c.hoveredKey}
        selectedActionId={c.selectedActionId}
        isCalcMode={isCalcMode}
        showResultPath={c.settings.showResultPath}
        highlightIntent={highlightIntent}
        highlightNameMode={highlightNameMode}
        highlightPathMode={highlightPathMode}
        actionIds={getVisibleActionIdsForItem({
          item,
          resultActionButtons: c.settings.resultActionButtons,
          isHistoryMode,
          isCalcMode,
        })}
        iconByKey={c.iconByKey}
        calculatorIconDataUrl={c.calculatorIconDataUrl}
        onLaunchApp={c.launchApp}
        onOpenFolder={c.openFolder}
        onCopyPath={c.copyPath}
        onRunAsAdmin={c.runAsAdmin}
        onDeleteHistory={c.deleteResultItem}
        onHover={(nextItem) => c.setHoveredKey(normalizeResultKey(nextItem))}
      />
    );
  }, [
    c.calculatorIconDataUrl,
    c.copyPath,
    c.deleteResultItem,
    c.hoveredKey,
    c.iconByKey,
    c.launchApp,
    c.openFolder,
    c.runAsAdmin,
    c.selectedActionId,
    c.selectedIndex,
    c.setHoveredKey,
    c.settings.resultActionButtons,
    c.settings.showResultPath,
    c.visibleResults,
    highlightIntent,
    highlightNameMode,
    highlightPathMode,
    isCalcMode,
    isHistoryMode,
  ]);

  if (!(c.visibleResults.length > 0 || c.showEmptyState || c.showInputHint)) return null;
  return (
    <div className={`results ${statusText ? "results-with-status" : ""}`}>
      {c.showInputHint ? (
        <div className="empty-state">继续输入以开始搜索（至少 2 个字符）</div>
      ) : c.showEmptyState ? (
        <div className="empty-state">未找到匹配结果</div>
      ) : (
        <>
          <div
            ref={c.scrollContainerRef}
            className="results-scroll-container"
            style={{ maxHeight: c.MAX_LIST_HEIGHT, overflowY: "auto" }}
            onWheel={c.clearActionSelection}
            onMouseDown={c.clearActionSelection}
            onMouseLeave={() => c.setHoveredKey("")}
          >
            <List
              listRef={c.listRef}
              style={{ height: c.listHeight, width: "100%", overflow: "visible" }}
              rowCount={c.visibleResults.length}
              rowHeight={c.ITEM_HEIGHT}
              className="virtual-list"
              rowComponent={rowRenderer}
              rowProps={stableRowProps}
              onRowsRendered={(visibleRows) => c.onItemsRendered(visibleRows)}
            />
          </div>
          <SearchResultsBottomInfo
            resultsCount={c.results.length}
            visibleCount={c.visibleResults.length}
            hasMore={c.hasMore}
            isHistoryMode={isHistoryMode}
            isCalcMode={isCalcMode}
            trimmedQuery={c.trimmedQuery}
            ignoredPaths={c.settings.ignoredPaths}
          />
          {c.showBackToTop ? (
            <button className="back-to-top-btn" onClick={c.scrollToTop} title="返回顶部" type="button">
              <IconChevronUp size={20} />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 记忆化导出 */
export const SearchResultsPanel = memo(SearchResultsPanelImpl, areSearchResultsPanelPropsEqual);
