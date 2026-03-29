import { useEffect, useLayoutEffect, useState } from "react";

/** 操作提示浮层状态 */
export type SearchActionTooltip = {
  text: string;
  x: number;
  y: number;
  placement: "top" | "bottom";
  anchorX: number;
  arrowLeftPx: number;
};

/** 动作提示文案映射 */
const ACTION_LABEL_MAP: Record<string, string> = {
  openFolder: "打开所在目录",
  copyPath: "复制路径",
  runAsAdmin: "以管理员身份运行",
  deleteHistory: "删除该历史",
};

/** 维护键盘选中动作按钮的提示浮层 */
export function useSearchActionTooltip(selectedActionId: string) {
  const [actionTooltip, setActionTooltip] = useState<SearchActionTooltip | null>(null);

  useEffect(() => {
    if (!selectedActionId) return void setActionTooltip(null);
    const text = ACTION_LABEL_MAP[selectedActionId] || "";
    if (!text) return void setActionTooltip(null);
    const el = document.querySelector(`.results li.selected .action-btn[data-action-id="${selectedActionId}"]`) as HTMLElement | null;
    if (!el) return void setActionTooltip(null);

    const r = el.getBoundingClientRect();
    const centerX = r.left + r.width / 2;
    const gap = 8;
    const yTop = r.top - gap;
    const yBottom = r.bottom + gap;
    const placement = yTop < 36 ? "bottom" : "top";
    const approxW = 260;
    const margin = 12;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const x = clamp(centerX, margin + approxW / 2, window.innerWidth - margin - approxW / 2);
    setActionTooltip({
      text,
      x: Math.round(x),
      y: Math.round(placement === "top" ? yTop : yBottom),
      placement,
      anchorX: Math.round(centerX),
      arrowLeftPx: 0,
    });
  }, [selectedActionId]);

  useLayoutEffect(() => {
    if (!actionTooltip) return;
    const tipEl = document.querySelector(`.fs-tooltip-pop[data-tooltip="action"]`) as HTMLElement | null;
    const btnEl = document.querySelector(`.results li.selected .action-btn[data-action-id="${selectedActionId}"]`) as HTMLElement | null;
    if (!tipEl || !btnEl) return;

    const margin = 12;
    const gap = 8;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const tipRect = tipEl.getBoundingClientRect();
    const btnRect = btnEl.getBoundingClientRect();
    const anchorX = btnRect.left + btnRect.width / 2;

    let placement: "top" | "bottom" = actionTooltip.placement;
    if (placement === "top" && btnRect.top - gap - tipRect.height < margin) placement = "bottom";
    if (placement === "bottom" && btnRect.bottom + gap + tipRect.height > window.innerHeight - margin) placement = "top";

    const x = clamp(anchorX, margin + tipRect.width / 2, window.innerWidth - margin - tipRect.width / 2);
    const arrowLeft = clamp(anchorX - (x - tipRect.width / 2), 12, tipRect.width - 12);
    let y = actionTooltip.y;
    if (placement === "top") y = Math.max(margin + tipRect.height, btnRect.top - gap);
    else {
      y = Math.min(window.innerHeight - margin - tipRect.height, btnRect.bottom + gap);
      y = Math.max(margin, y);
    }
    const next = { ...actionTooltip, x: Math.round(x), y: Math.round(y), placement, anchorX: Math.round(anchorX), arrowLeftPx: Math.round(arrowLeft) };
    if (next.x !== actionTooltip.x || next.y !== actionTooltip.y || next.placement !== actionTooltip.placement || next.arrowLeftPx !== actionTooltip.arrowLeftPx) {
      setActionTooltip(next);
    }
  }, [actionTooltip, selectedActionId]);

  return actionTooltip;
}
