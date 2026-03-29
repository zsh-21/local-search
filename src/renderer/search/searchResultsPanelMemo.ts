import type { useSearchController } from "./useSearchController";

/** 搜索控制器类型别名 */
type SearchController = ReturnType<typeof useSearchController>;

/** 面板入参 */
export type SearchResultsPanelProps = {
  c: SearchController;
  isHistoryMode: boolean;
  isCalcMode: boolean;
  statusText: string;
};

/** 自定义浅比较，避免结果列表非必要重渲染 */
export function areSearchResultsPanelPropsEqual(prev: SearchResultsPanelProps, next: SearchResultsPanelProps) {
  if (prev.isHistoryMode !== next.isHistoryMode) return false;
  if (prev.isCalcMode !== next.isCalcMode) return false;
  if (Boolean(prev.statusText) !== Boolean(next.statusText)) return false;
  const pc = prev.c;
  const nc = next.c;
  return (
    pc.visibleResults === nc.visibleResults &&
    pc.results === nc.results &&
    pc.selectedIndex === nc.selectedIndex &&
    pc.hoveredKey === nc.hoveredKey &&
    pc.selectedActionId === nc.selectedActionId &&
    pc.showBackToTop === nc.showBackToTop &&
    pc.hasMore === nc.hasMore &&
    pc.trimmedQuery === nc.trimmedQuery &&
    pc.showEmptyState === nc.showEmptyState &&
    pc.showInputHint === nc.showInputHint &&
    pc.listHeight === nc.listHeight &&
    pc.MAX_LIST_HEIGHT === nc.MAX_LIST_HEIGHT &&
    pc.ITEM_HEIGHT === nc.ITEM_HEIGHT &&
    pc.settings === nc.settings &&
    pc.iconByKey === nc.iconByKey &&
    pc.calculatorIconDataUrl === nc.calculatorIconDataUrl
  );
}
