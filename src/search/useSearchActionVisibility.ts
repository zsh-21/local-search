import { useCallback, useMemo } from "react";
import { AppItem, AppSettings } from "../appTypes";

type Params = {
  settings: AppSettings;
  isHistoryMode: boolean;
  isCalcMode: boolean;
  results: AppItem[];
  selectedIndex: number;
  selectedActionIndex: number;
};

export function useSearchActionVisibility({
  settings,
  isHistoryMode,
  isCalcMode,
  results,
  selectedIndex,
  selectedActionIndex,
}: Params) {
  // 抽出可见动作的计算逻辑，减少主控制器体积
  const getVisibleActionIdsForItem = useCallback(
    (item: AppItem | undefined) => {
      if (!item) return [] as AppSettings["resultActionButtons"];
      if (item.type === "calc") {
        return isCalcMode ? (["deleteHistory"] as AppSettings["resultActionButtons"]) : ([] as AppSettings["resultActionButtons"]);
      }
      const raw = Array.isArray(settings.resultActionButtons) ? settings.resultActionButtons : [];
      const out: AppSettings["resultActionButtons"][number][] = [];
      for (const id of raw) {
        if (id === "deleteHistory" && !isHistoryMode) continue;
        if (id === "runAsAdmin" && item.type !== "app") continue;
        if (!(["openFolder", "copyPath", "deleteHistory", "runAsAdmin"] as const).includes(id as any)) continue;
        if (out.includes(id)) continue;
        out.push(id);
        if (out.length >= 3) break;
      }
      return out;
    },
    [settings.resultActionButtons, isHistoryMode, isCalcMode],
  );

  const selectedActionIds = useMemo(() => {
    return getVisibleActionIdsForItem(results[selectedIndex]);
  }, [getVisibleActionIdsForItem, results, selectedIndex]);

  const selectedActionId =
    selectedActionIndex >= 0 && selectedActionIndex < selectedActionIds.length
      ? selectedActionIds[selectedActionIndex]
      : "";

  return { getVisibleActionIdsForItem, selectedActionIds, selectedActionId };
}
