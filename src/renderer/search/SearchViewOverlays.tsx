import type { CSSProperties } from "react";
import type { SearchActionTooltip } from "./useSearchActionTooltip";

/** 搜索页覆盖层：动作提示 + 提示气泡 */
export function SearchViewOverlays(props: {
  actionTooltip: SearchActionTooltip | null;
  toast: { kind: "success" | "error" | "info"; message: string } | null;
}) {
  const tooltipStyle: CSSProperties & { "--fs-tooltip-arrow-left"?: string } =
    props.actionTooltip
      ? {
          left: props.actionTooltip.x,
          top: props.actionTooltip.y,
          transform: props.actionTooltip.placement === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
          "--fs-tooltip-arrow-left": `${props.actionTooltip.arrowLeftPx || 0}px`,
          maxWidth: 260,
        }
      : {};

  return (
    <>
      {props.actionTooltip ? (
        <div
          className="fs-tooltip-pop"
          data-placement={props.actionTooltip.placement}
          data-tooltip="action"
          style={tooltipStyle}
          role="status"
          aria-live="polite"
        >
          <div className="fs-tooltip-text">{props.actionTooltip.text}</div>
          <div className="fs-tooltip-arrow" />
        </div>
      ) : null}

      {props.toast ? (
        <div className={`settings-toast ${props.toast.kind}`} role="status" aria-live="polite">
          <span className="settings-toast-icon" aria-hidden="true">
            {props.toast.kind === "success" ? "✓" : props.toast.kind === "error" ? "✕" : "i"}
          </span>
          <span className="settings-toast-text">{props.toast.message}</span>
        </div>
      ) : null}
    </>
  );
}
