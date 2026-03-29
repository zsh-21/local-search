import type { AppItem, ResultActionButtonId } from "../appTypes";

/** 允许在结果右侧展示的操作按钮集合 */
const ALLOWED_ACTION_IDS: ResultActionButtonId[] = [
  "openFolder",
  "copyPath",
  "deleteHistory",
  "runAsAdmin",
];

/** 计算单条结果的可见按钮列表 */
export function getVisibleActionIdsForItem(input: {
  item: AppItem;
  resultActionButtons: ResultActionButtonId[];
  isHistoryMode: boolean;
  isCalcMode: boolean;
}) {
  const { item, resultActionButtons, isHistoryMode, isCalcMode } = input;
  if (item.type === "calc") return isCalcMode ? (["deleteHistory"] as ResultActionButtonId[]) : [];
  const raw = Array.isArray(resultActionButtons) ? resultActionButtons : [];
  const out: ResultActionButtonId[] = [];
  for (const id of raw) {
    if (!ALLOWED_ACTION_IDS.includes(id)) continue;
    if (id === "deleteHistory" && !isHistoryMode) continue;
    if (id === "runAsAdmin" && item.type !== "app") continue;
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= 3) break;
  }
  return out;
}
