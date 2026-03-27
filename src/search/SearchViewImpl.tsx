import { useEffect, useLayoutEffect, useState } from "react";
import { BackgroundImage } from "../components/BackgroundImage";
import {
  IconClear,
  IconPin,
  IconSearch,
  IconSettings,
} from "../components/icons/SettingsIcons";
import { SearchResultsPanel } from "./SearchResultsPanel";
import { useSearchController } from "./useSearchController";

export function SearchViewImpl() {
  const c = useSearchController();
  const [footerOffsetPx, setFooterOffsetPx] = useState(0);

  const isHistoryMode = c.query.trim().length === 0;
  const isCalcMode = c.isCalcMode;
  const indexPercent = Math.max(1, Math.min(100, Math.round((c.indexProgress || 0) * 100)));
  const statusText =
    c.searchActivity === "searching"
      ? "搜索中..."
      : c.searchActivity === "indexing"
        ? `正在索引 ${indexPercent}%`
        : "";

  const [actionTooltip, setActionTooltip] = useState<null | {
    text: string;
    x: number;
    y: number;
    placement: "top" | "bottom";
    anchorX: number;
    arrowLeftPx: number;
  }>(null);

  useEffect(() => {
    window.addEventListener("keydown", c.handleWindowKeyDownCapture, true);
    return () => {
      window.removeEventListener("keydown", c.handleWindowKeyDownCapture, true);
    };
  }, [c.handleWindowKeyDownCapture]);

  useEffect(() => {
    if (!c.selectedActionId) {
      setActionTooltip(null);
      return;
    }

    const labelMap: Record<string, string> = {
      openFolder: "打开所在目录",
      copyPath: "复制路径",
      runAsAdmin: "以管理员身份运行",
      deleteHistory: "删除该历史",
    };
    const text = labelMap[c.selectedActionId] || "";
    if (!text) {
      setActionTooltip(null);
      return;
    }

    const el = document.querySelector(
      `.results li.selected .action-btn[data-action-id="${c.selectedActionId}"]`,
    ) as HTMLElement | null;
    if (!el) {
      setActionTooltip(null);
      return;
    }

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
  }, [c.selectedActionId]);

  useLayoutEffect(() => {
    if (!actionTooltip) return;

    const tipEl = document.querySelector(`.fs-tooltip-pop[data-tooltip="action"]`) as HTMLElement | null;
    const btnEl = document.querySelector(
      `.results li.selected .action-btn[data-action-id="${c.selectedActionId}"]`,
    ) as HTMLElement | null;
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
    if (placement === "top") {
      y = Math.max(margin + tipRect.height, btnRect.top - gap);
    } else {
      y = Math.min(window.innerHeight - margin - tipRect.height, btnRect.bottom + gap);
      y = Math.max(margin, y);
    }

    const next = {
      ...actionTooltip,
      x: Math.round(x),
      y: Math.round(y),
      placement,
      anchorX: Math.round(anchorX),
      arrowLeftPx: Math.round(arrowLeft),
    };
    if (
      next.x !== actionTooltip.x ||
      next.y !== actionTooltip.y ||
      next.placement !== actionTooltip.placement ||
      next.arrowLeftPx !== actionTooltip.arrowLeftPx
    ) {
      setActionTooltip(next);
    }
  }, [actionTooltip, c.selectedActionId]);

  const pinButtonTitle = c.isPanelPinned ? "取消固定 (Alt+T)" : "固定 (Alt+T)";
  const pinButtonAriaLabel = c.isPanelPinned ? "取消固定搜索面板" : "固定搜索面板";

  useLayoutEffect(() => {
    let rafId = 0;
    const measureFooterOffset = () => {
      const container = c.containerRef.current;
      if (!container) return;
      const footerEl = container.querySelector(".list-bottom-info") as HTMLElement | null;
      if (!footerEl) {
        setFooterOffsetPx((prev) => (prev === 0 ? prev : 0));
        return;
      }
      const nextOffset = Math.max(0, Math.round(window.innerHeight - container.scrollHeight));
      setFooterOffsetPx((prev) => (prev === nextOffset ? prev : nextOffset));
    };
    const scheduleMeasure = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        measureFooterOffset();
      });
    };
    const container = c.containerRef.current;
    const resizeObserver =
      container && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleMeasure()) : null;
    if (resizeObserver && container) resizeObserver.observe(container);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [c.containerRef]);

  return (
    <div
      className={`container search-container ${c.typeMenuOpen ? "menu-open" : ""} ${c.settings.compactMode ? "compact" : ""} ${footerOffsetPx > 0 ? "footer-docked" : ""}`}
      ref={c.containerRef}
      style={
        footerOffsetPx > 0
          ? { ["--search-footer-offset" as any]: `${footerOffsetPx}px` }
          : undefined
      }
      onClickCapture={(e) => {
        c.clearActionSelection();
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const hitInteractive = Boolean(
          target.closest(
            ".search-box, .results li, .type-select-menu, .action-btn, .back-to-top-btn, .settings-toast, .fs-tooltip-pop",
          ),
        );
        if (hitInteractive) return;
        if (c.isPanelPinned) return;
        c.hideWindow();
      }}
    >
      <BackgroundImage path={c.settings.backgroundImagePath} opacity={c.settings.backgroundImageOpacity} />

      {actionTooltip ? (
        <div
          className="fs-tooltip-pop"
          data-placement={actionTooltip.placement}
          data-tooltip="action"
          style={{
            left: actionTooltip.x,
            top: actionTooltip.y,
            transform: actionTooltip.placement === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            ["--fs-tooltip-arrow-left" as any]: `${actionTooltip.arrowLeftPx || 0}px`,
            maxWidth: 260,
          }}
          role="status"
          aria-live="polite"
        >
          <div className="fs-tooltip-text">{actionTooltip.text}</div>
          <div className="fs-tooltip-arrow" />
        </div>
      ) : null}

      {c.toast ? (
        <div className={`settings-toast ${c.toast.kind}`} role="status" aria-live="polite">
          <span className="settings-toast-icon" aria-hidden="true">
            {c.toast.kind === "success" ? "✓" : c.toast.kind === "error" ? "✕" : "i"}
          </span>
          <span className="settings-toast-text">{c.toast.message}</span>
        </div>
      ) : null}

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

      {statusText && (
        <div className="status">
          <span className="spinner" />
          <span className="status-text">{statusText}</span>
        </div>
      )}

      <SearchResultsPanel c={c} isHistoryMode={isHistoryMode} isCalcMode={isCalcMode} statusText={statusText} />
    </div>
  );
}
