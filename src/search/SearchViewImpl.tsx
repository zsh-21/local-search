import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { List } from "react-window";
import { BackgroundImage } from "../components/BackgroundImage";
import { IconPin, IconPinOff } from "../components/icons/SettingsIcons";
import { ParticleBackground } from "../components/ParticleBackground";
import { AppItem } from "../appTypes";
import { useSearchController } from "./useSearchController";
import { normalizeResultKey } from "./searchResultUtils";

// 搜索页渲染层：纯 UI/交互展示，状态与副作用集中在 useSearchController
export function SearchViewImpl() {
  const c = useSearchController();

  const isHistoryMode = c.query.trim().length === 0;
  const isCalcMode = c.isCalcMode;

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

    // tooltip 先按近似宽度做初始定位；最终会在 layout 阶段按实际宽度微调，并让箭头指向按钮
    const approxW = 260;
    const margin = 12;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    const x = clamp(
      centerX,
      margin + approxW / 2,
      window.innerWidth - margin - approxW / 2,
    );
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

    const tipEl = document.querySelector(
      `.fs-tooltip-pop[data-tooltip="action"]`,
    ) as HTMLElement | null;
    const btnEl = document.querySelector(
      `.results li.selected .action-btn[data-action-id="${c.selectedActionId}"]`,
    ) as HTMLElement | null;
    if (!tipEl || !btnEl) return;

    const margin = 12;
    const gap = 8;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));

    const tipRect = tipEl.getBoundingClientRect();
    const btnRect = btnEl.getBoundingClientRect();
    const anchorX = btnRect.left + btnRect.width / 2;

    let placement: "top" | "bottom" = actionTooltip.placement;
    if (placement === "top" && btnRect.top - gap - tipRect.height < margin)
      placement = "bottom";
    if (
      placement === "bottom" &&
      btnRect.bottom + gap + tipRect.height > window.innerHeight - margin
    )
      placement = "top";

    const x = clamp(
      anchorX,
      margin + tipRect.width / 2,
      window.innerWidth - margin - tipRect.width / 2,
    );

    const arrowLeft = clamp(
      anchorX - (x - tipRect.width / 2),
      12,
      tipRect.width - 12,
    );

    let y = actionTooltip.y;
    if (placement === "top") {
      y = Math.max(margin + tipRect.height, btnRect.top - gap);
    } else {
      y = Math.min(
        window.innerHeight - margin - tipRect.height,
        btnRect.bottom + gap,
      );
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

  const getVisibleActionIdsForItem = (item: AppItem) => {
    if (item.type === "calc") return isCalcMode ? ["deleteHistory"] : [];
    const raw = Array.isArray(c.settings.resultActionButtons)
      ? c.settings.resultActionButtons
      : [];
    const out: string[] = [];
    for (const id of raw) {
      if (id === "deleteHistory" && !isHistoryMode) continue;
      if (id === "runAsAdmin" && item.type !== "app") continue;
      if (
        !["openFolder", "copyPath", "deleteHistory", "runAsAdmin"].includes(
          id as any,
        )
      )
        continue;
      if (out.includes(id)) continue;
      out.push(id);
      if (out.length >= 3) break;
    }
    return out;
  };

  // 仅在输入较稳定时高亮，避免短字符导致过度高亮与误匹配
  const highlightQuery = useMemo(() => {
    const q = c.query.trim();
    if (q.length < 2 || q.length > 32) return "";
    return q.toLowerCase();
  }, [c.query]);

  // 将命中片段拆分为“前/中/后”，仅渲染一次高亮，避免视觉干扰
  const renderHighlightedText = (text: string) => {
    if (!highlightQuery) return text;
    const lower = (text || "").toLowerCase();
    const idx = lower.indexOf(highlightQuery);
    if (idx < 0) return text;
    const before = text.slice(0, idx);
    const mid = text.slice(idx, idx + highlightQuery.length);
    const after = text.slice(idx + highlightQuery.length);
    return (
      <>
        {before}
        <span className="match">{mid}</span>
        {after}
      </>
    );
  };

  const buildIconClassName = (icon: string | undefined, extra?: string) => {
    const classes = ["result-icon"];
    if (extra) classes.push(extra);
    if (icon && icon.startsWith("data:image/svg+xml")) classes.push("svg-icon");
    return classes.join(" ");
  };

  const getExtension = (path: string) => {
    const parts = path.split(".");
    return parts.length > 1 ? parts.pop()?.toUpperCase() : "";
  };

  // 图片类型用于显示预览缩略图，非图片使用扩展名图标
  const isImageFile = (path: string) => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg"].includes(
      ext,
    );
  };

  // “=历史/计算项”统一识别：兼容 type=calc 与“=开头”的历史文案，保证图标一致。
  const isCalcLikeItem = (item: AppItem) => {
    if (item.type === "calc") return true;
    if (!isCalcMode) return false;
    const candidates = [item.description, item.path, item.name];
    return candidates.some(
      (text) => typeof text === "string" && text.trim().startsWith("="),
    );
  };

  // 根据结果类型渲染不同图标：文件夹/应用/设置/文件
  const renderResultIcon = (item: AppItem, isImg: boolean) => {
    if (isCalcLikeItem(item)) {
      // “= 当前项 + 计算历史”优先复用系统计算器图标；仅在取图失败时回退 SVG。
      if (c.calculatorIconDataUrl) {
        return (
          <img
            className={buildIconClassName(c.calculatorIconDataUrl)}
            src={c.calculatorIconDataUrl}
            alt=""
          />
        );
      }
      return (
        <svg
          className="result-icon"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="4"
            y="2.5"
            width="16"
            height="19"
            rx="3"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M8 7.5h8M8 12h3m5 0h.01M8 16.5h3m5 0h.01"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
      );
    }

    if (item.type === "folder") {
      return (
        <span className="result-icon folder-emoji" aria-hidden="true">
          📂
        </span>
      );
    }

    if (item.type === "app") {
      if (!item.icon) return <span className="result-icon placeholder" />;
      return (
        <img className={buildIconClassName(item.icon)} src={item.icon} alt="" />
      );
    }

    if (item.type === "settings") {
      return (
        <svg
          className="result-icon"
          viewBox="0 0 25 25"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    }

    if (item.type === "file") {
      if (item.icon && isImg)
        return (
          <img className="result-icon image-preview" src={item.icon} alt="" />
        );
      if (item.icon)
        return (
          <img
            className={buildIconClassName(item.icon)}
            src={item.icon}
            alt=""
          />
        );
      const ext = (item.path.split(".").pop() || "").trim().toUpperCase();
      const label = ext && ext.length <= 6 ? ext : "FILE";
      return (
        <span className="result-icon ext-icon" aria-hidden="true">
          <span className="ext-icon-text">{label}</span>
        </span>
      );
    }

    return <span className="result-icon placeholder" />;
  };

  const Row = ({
    index,
    style,
    ariaAttributes,
  }: {
    index: number;
    style: React.CSSProperties;
    ariaAttributes?: any;
  }) => {
    const item = c.visibleResults[index];
    if (!item) return null;

    // 当前选中项用于键盘导航与样式高亮
    const isSelected = index === c.selectedIndex;
    const isImg = item.type === "file" && isImageFile(item.path);
    const lowerPath = (item.path || "").toLowerCase();
    const isLink = lowerPath.endsWith(".lnk") || lowerPath.endsWith(".url");
    // 仅对真正的 calc 类型做“表达式=结果”拼接，避免误改普通历史项文案。
    const isNativeCalcItem = item.type === "calc";
    const calcExpression = isNativeCalcItem ? String(item.path || "").trim() : "";
    const calcResult = isNativeCalcItem ? String(item.name || "").trim() : "";
    const displayName =
      isNativeCalcItem && calcExpression && calcResult
        ? `${calcExpression}=${calcResult}`
        : item.name;
    const hasPath =
      typeof item.path === "string" && item.path.trim().length > 0;
    // 仅展示盘符开头的完整路径，避免显示非路径字符串（如 ms-settings:）。
    const isDrivePath = /^[a-zA-Z]:\\/.test(item.path || "");
    const showPathLine =
      !isNativeCalcItem && c.settings.showResultPath && hasPath && isDrivePath;
    const tooltipAddress = showPathLine ? item.path : undefined;

    const actionIds = getVisibleActionIdsForItem(item);
    const badgeText =
      item.type === "folder"
        ? "文件夹"
        : item.type === "settings"
          ? "设置"
          : isLink
            ? "LINK"
            : item.type === "file"
              ? getExtension(item.path)
              : "";

    return (
      <div
        style={style}
        {...ariaAttributes}
        className={`result-item-wrapper ${isSelected ? "selected" : ""}`}
        onMouseDown={(e) => {
          if (e.button === 0) {
            c.launchApp(item);
          }
        }}
        onMouseEnter={() => {
          c.setHoveredKey(normalizeResultKey(item));
        }}
      >
        <li
          className={`${isSelected ? "selected" : ""} ${c.hoveredKey === normalizeResultKey(item) ? "hovered" : ""}`}
          title={displayName}
          data-title-address={tooltipAddress}
          data-title-delay="500"
          data-title-no-scroll="true"
        >
          <span className="result-index">{index + 1}</span>
          {renderResultIcon(item, isImg)}
          <div className="result-meta">
            <div className="result-name-row">
              <span className="app-name">
                {renderHighlightedText(displayName)}
              </span>
              {badgeText ? (
                <span className="file-ext-badge">{badgeText}</span>
              ) : null}
              {isSelected && <span className="shortcut-hint">ENTER</span>}
            </div>
            {showPathLine ? (
              <span className="app-path">
                {renderHighlightedText(item.path)}
              </span>
            ) : null}
          </div>
          <div className="action-group">
            {actionIds.map((actionId) => {
              const selectedBtn = isSelected && c.selectedActionId === actionId;
              if (actionId === "openFolder") {
                return (
                  <button
                    key={actionId}
                    className={
                      selectedBtn ? "action-btn kbd-selected" : "action-btn"
                    }
                    data-action-id={actionId}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      c.openFolder(item);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if ((e as any).detail === 0) c.openFolder(item);
                    }}
                    title="打开所在目录"
                    aria-label="打开所在目录"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 7.5c0-1.1.9-2 2-2h5l2 2h7c1.1 0 2 .9 2 2v7.5c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.5Z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                );
              }
              if (actionId === "copyPath") {
                return (
                  <button
                    key={actionId}
                    className={
                      selectedBtn ? "action-btn kbd-selected" : "action-btn"
                    }
                    data-action-id={actionId}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      c.copyPath(item);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    title="复制路径"
                    aria-label="复制路径"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M8 4V3c0-.6.4-1 1-1h10c.6 0 1 .4 1 1v10c0 .6-.4 1-1 1h-1M4 8v12c0 .6.4 1 1 1h10c.6 0 1-.4 1-1V8c0-.6-.4-1-1-1H5c-.6 0-1 .4-1 1Z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                );
              }
              if (actionId === "runAsAdmin") {
                return (
                  <button
                    key={actionId}
                    className={
                      selectedBtn ? "action-btn kbd-selected" : "action-btn"
                    }
                    data-action-id={actionId}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      c.runAsAdmin(item);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    title="以管理员身份运行"
                    aria-label="以管理员身份运行"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                );
              }
              if (actionId === "deleteHistory") {
                return (
                  <button
                    key={actionId}
                    className={
                      selectedBtn
                        ? "action-btn delete-btn kbd-selected"
                        : "action-btn delete-btn"
                    }
                    data-action-id={actionId}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void c.deleteResultItem(item);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    title="删除该历史"
                    aria-label="删除该历史"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M6 6l12 12M18 6 6 18"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                );
              }
              return null;
            })}
          </div>
        </li>
      </div>
    );
  };

  const BottomInfo = () => {
    if (c.results.length === 0) return null;
    const ignored = Array.isArray(c.settings.ignoredPaths)
      ? c.settings.ignoredPaths
      : [];
    const hasIgnored = ignored.some(
      (p) => typeof p === "string" && p.trim().length > 0,
    );
    return (
      <div className="list-bottom-info">
        {isHistoryMode ? (
          <div className="no-more-results">{`已显示全部 ${c.results.length} 条历史记录`}</div>
        ) : c.totalCount > c.settings.searchDisplayLimit ? (
          <div className="no-more-results">{`由于内容太多，展示最匹配的前${c.settings.searchDisplayLimit}`}</div>
        ) : (
          <div className="no-more-results">{`共 ${c.totalCount} 个结果`}</div>
        )}
        {hasIgnored ? (
          <div className="no-more-results ignore-tips">
            如果搜索不到您想要的文件，可以尝试在【设置-搜索-黑名单路径】移除对应的路径再试~
          </div>
        ) : null}
      </div>
    );
  };

  // 固定按钮文案集中计算：确保点击与 Alt+T 切换后，title 与 aria-label 同步更新。
  const pinButtonTitle = c.isPanelPinned ? "取消固定（Alt+T）" : "固定（Alt+T）";
  const pinButtonAriaLabel = c.isPanelPinned
    ? "取消固定搜索面板"
    : "固定搜索面板";

  return (
    <div
      className={`container search-container ${c.typeMenuOpen ? "menu-open" : ""} ${c.settings.compactMode ? "compact" : ""}`}
      ref={c.containerRef}
      // 空白区改为 click 语义隐藏，避免 mousedown 抢占 Electron 原生拖拽起手。
      onClickCapture={(e) => {
        c.clearActionSelection();
        const target = e.target as HTMLElement | null;
        if (!target) return;
        // 空白点击隐藏兜底：仅当未点到可交互元素时才隐藏，避免“取消固定后点击空白无效”。
        const hitInteractive = Boolean(
          target.closest(
            ".search-box, .results li, .type-select-menu, .action-btn, .back-to-top-btn, .settings-toast, .fs-tooltip-pop",
          ),
        );
        if (hitInteractive) return;
        // 固定状态下点击面板空白不自动隐藏，保持面板常驻。
        if (c.isPanelPinned) return;
        c.hideWindow();
      }}
    >
      <BackgroundImage
        path={c.settings.backgroundImagePath}
        opacity={c.settings.backgroundImageOpacity}
      />
      <ParticleBackground
        enabled={c.settings.enableEffect}
        type={c.settings.effectType}
      />
      {actionTooltip ? (
        <div
          className="fs-tooltip-pop"
          data-placement={actionTooltip.placement}
          data-tooltip="action"
          style={{
            left: actionTooltip.x,
            top: actionTooltip.y,
            transform:
              actionTooltip.placement === "top"
                ? "translate(-50%, -100%)"
                : "translate(-50%, 0)",
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
        <div
          className={`settings-toast ${c.toast.kind}`}
          role="status"
          aria-live="polite"
        >
          <span className="settings-toast-icon" aria-hidden="true">
            {c.toast.kind === "success"
              ? "✓"
              : c.toast.kind === "error"
                ? "✕"
                : "i"}
          </span>
          <span className="settings-toast-text">{c.toast.message}</span>
        </div>
      ) : null}

      <div className="search-box">
        <div className="search-icon-wrapper">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            className="search-icon-svg"
          >
            <path
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
              {/* 前缀使用隐藏占位保证后缀起始位置与真实输入严格对齐 */}
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
                c.setQuery("");
                c.setSelectedIndex(0);
                c.setTypeMenuOpen(false);
                c.inputRef.current?.focus();
              }}
              aria-label="清空输入"
              title="清空 (Ctrl+L)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ) : null}

          <div className="type-select" ref={c.typeSelectRef}>
            <button
              className="type-select-btn"
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                c.clearActionSelection();
                c.setTypeMenuOpen((v) => !v);
              }}
              aria-haspopup="menu"
              aria-expanded={c.typeMenuOpen}
            >
              <span className="type-select-label">{c.currentTypeLabel}</span>
              <span className="type-select-caret">▾</span>
            </button>
            {c.typeMenuOpen ? (
              <div
                className="type-select-menu"
                role="menu"
                ref={c.typeMenuRef}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="type-select-menu-inner">
                  {c.searchTypeOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`type-select-item ${opt.id === c.searchTypeId ? "active" : ""}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        c.clearActionSelection();
                        c.setSearchTypeId(opt.id);
                        c.setTypeMenuOpen(false);
                      }}
                    >
                      <div className="type-select-item-left">
                        <span>{opt.label}</span>
                      </div>
                      {opt.id === c.searchTypeId && (
                        <span className="check-mark">✓</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className={`pin-btn ${c.isPanelPinned ? "active" : ""}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            c.togglePanelPinned();
          }}
          aria-label={pinButtonAriaLabel}
          title={pinButtonTitle}
        >
          {c.isPanelPinned ? <IconPin size={18} /> : <IconPinOff size={18} />}
        </button>

        {/* <div className="drag-icon" title="按住拖拽移动" /> */}
      </div>

      {c.statusText && (
        <div className="status">
          <span className="spinner" />
          <span className="status-text">{c.statusText}</span>
        </div>
      )}

      {(c.visibleResults.length > 0 || c.showEmptyState || c.showInputHint) && (
        <div className="results">
          {c.showInputHint ? (
            <div className="empty-state">
              继续输入以开始搜索（至少 2 个字符）
            </div>
          ) : c.showEmptyState ? (
            <div className="empty-state">未找到匹配结果</div>
          ) : (
            <>
              <div
                ref={c.scrollContainerRef}
                className="results-scroll-container"
                style={{ maxHeight: c.MAX_LIST_HEIGHT, overflowY: "auto" }}
                onWheel={() => {
                  c.clearActionSelection();
                  c.clearGhostInputValue();
                  c.setLastSelectedBy("mouse");
                }}
                onMouseDown={() => {
                  c.clearActionSelection();
                  c.clearGhostInputValue();
                  c.setLastSelectedBy("mouse");
                }}
                onMouseLeave={() => c.setHoveredKey("")}
              >
                {/* 结果列表增量刷新时保持 hover 稳定：鼠标离开才清空 hoveredKey，避免 hover 视觉闪烁 */}
                <List<any>
                  listRef={c.listRef}
                  style={{
                    height: c.listHeight,
                    width: "100%",
                    overflow: "visible",
                  }}
                  rowCount={c.visibleResults.length}
                  rowHeight={c.ITEM_HEIGHT}
                  className="virtual-list"
                  rowComponent={Row}
                  rowProps={{}}
                  onRowsRendered={(visibleRows: any) =>
                    c.onItemsRendered(visibleRows)
                  }
                />
              </div>
              <BottomInfo />
              {/* “回到顶部”按钮同时跟随滚动位置与键盘选中项，保证鼠标滚动到底部也会出现 */}
              {c.showBackToTop && (
                <button
                  className="back-to-top-btn"
                  onClick={c.scrollToTop}
                  title="返回顶部"
                  type="button"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m18 15-6-6-6 6" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
