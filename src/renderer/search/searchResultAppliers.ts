import { AppItem } from "../appTypes";

type ApplyCalcParams = {
  currentCalcItem: AppItem | null;
  historyItems: AppItem[];
  preservePath?: string;
  setResults: (items: AppItem[]) => void;
  setTotalCount: (count: number) => void;
  setSelectedIndex: (index: number) => void;
  setIsSearching: (next: boolean) => void;
  setIsIndexing: (next: boolean) => void;
  setHasMore: (next: boolean) => void;
  dedupeResults: (items: AppItem[]) => AppItem[];
};

type ApplyHistoryParams = {
  historyItems: AppItem[];
  typeId: string;
  preservePath?: string;
  setResults: (items: AppItem[]) => void;
  setTotalCount: (count: number) => void;
  setSelectedIndex: (index: number) => void;
  setIsSearching: (next: boolean) => void;
  setIsIndexing: (next: boolean) => void;
  filterItemsBySearchType: (items: AppItem[], typeId: string) => AppItem[];
  limitHistoryResults: (items: AppItem[]) => AppItem[];
  dedupeResults: (items: AppItem[]) => AppItem[];
};

export function applyCalcResultsCore({
  currentCalcItem,
  historyItems,
  preservePath,
  setResults,
  setTotalCount,
  setSelectedIndex,
  setIsSearching,
  setIsIndexing,
  setHasMore,
  dedupeResults,
}: ApplyCalcParams) {
  // 计算模式合并历史记录后统一落地：保证选择项与计数同步更新
  const merged = currentCalcItem
    ? [currentCalcItem, ...historyItems.filter((it) => it.path !== currentCalcItem.path)]
    : historyItems.slice();
  const deduped = dedupeResults(merged);
  setResults(deduped);
  setTotalCount(deduped.length);
  if (preservePath) {
    const idx = deduped.findIndex((x) => x.path === preservePath);
    setSelectedIndex(idx >= 0 ? idx : 0);
  } else {
    setSelectedIndex(0);
  }
  setIsSearching(false);
  setIsIndexing(false);
  setHasMore(false);
}

export function applyHistoryResultsCore({
  historyItems,
  typeId,
  preservePath,
  setResults,
  setTotalCount,
  setSelectedIndex,
  setIsSearching,
  setIsIndexing,
  filterItemsBySearchType,
  limitHistoryResults,
  dedupeResults,
}: ApplyHistoryParams) {
  // 历史结果先过滤、去重、限量，再同步回选中项
  const filtered = filterItemsBySearchType(historyItems, typeId);
  const deduped = limitHistoryResults(dedupeResults(filtered));
  setResults(deduped);
  setTotalCount(deduped.length);
  if (preservePath) {
    const idx = deduped.findIndex((x) => x.path === preservePath);
    setSelectedIndex(idx >= 0 ? idx : 0);
  } else {
    setSelectedIndex(0);
  }
  setIsSearching(false);
  setIsIndexing(false);
}
