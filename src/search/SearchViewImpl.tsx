import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { List } from "react-window";
import { BackgroundImage } from "../components/BackgroundImage";
import { ParticleBackground } from "../components/ParticleBackground";
import { AppItem } from "../appTypes";
import { useSearchController } from "./useSearchController";

// 搜索页渲染层：纯 UI/交互展示，状态与副作用集中在 useSearchController
export function SearchViewImpl() {
  const c = useSearchController();

  const isHistoryMode = c.query.trim().length === 0;

  const [actionTooltip, setActionTooltip] = useState<
    null | { text: string; x: number; y: number; placement: "top" | "bottom"; anchorX: number; arrowLeftPx: number }
  >(null);

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

  const getVisibleActionIdsForItem = (item: AppItem) => {
    const raw = Array.isArray(c.settings.resultActionButtons) ? c.settings.resultActionButtons : [];
    const out: string[] = [];
    for (const id of raw) {
      if (id === "deleteHistory" && !isHistoryMode) continue;
      if (id === "runAsAdmin" && item.type !== "app") continue;
      if (!["openFolder", "copyPath", "deleteHistory", "runAsAdmin"].includes(id as any)) continue;
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

  const getExtension = (path: string) => {
    const parts = path.split(".");
    return parts.length > 1 ? parts.pop()?.toUpperCase() : "";
  };

  // 图片类型用于显示预览缩略图，非图片使用扩展名图标
  const isImageFile = (path: string) => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg"].includes(ext);
  };

  // 根据结果类型渲染不同图标：文件夹/应用/设置/文件
  const renderResultIcon = (item: AppItem, isImg: boolean) => {
    if (item.type === "folder") {
      // 文件夹图标使用 📂：无需额外图标资源，且在深浅色主题下对比度稳定
      return (
        <span className="result-icon folder-emoji" aria-hidden="true">
          📂
        </span>
      );
    }

    if (item.type === "app") {
      if (!item.icon) return <span className="result-icon placeholder" />;
      return <img className="result-icon" src={item.icon} alt="" />;
    }

    if (item.type === "settings") {
      return (
        <svg className="result-icon" viewBox="0 0 25 25" fill="none" aria-hidden="true">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }

    if (item.type === "file") {
      if (item.icon && isImg) return <img className="result-icon image-preview" src={item.icon} alt="" />;
      if (item.icon) return <img className="result-icon" src={item.icon} alt="" />;
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
          return;
        }}
      >
        <li className={isSelected ? "selected" : ""}>
          <span className="result-index">{index + 1}</span>
          {renderResultIcon(item, isImg)}
          <div className="result-meta">
            <div className="result-name-row">
              <span className="app-name">{renderHighlightedText(item.name)}</span>
              {badgeText ? <span className="file-ext-badge">{badgeText}</span> : null}
              {isSelected && <span className="shortcut-hint">ENTER</span>}
            </div>
            {c.settings.showResultPath ? (
              <span className="app-path" title={item.path}>
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
                    className={selectedBtn ? "action-btn kbd-selected" : "action-btn"}
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
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
                    className={selectedBtn ? "action-btn kbd-selected" : "action-btn"}
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
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
                    className={selectedBtn ? "action-btn kbd-selected" : "action-btn"}
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
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
                    className={selectedBtn ? "action-btn delete-btn kbd-selected" : "action-btn delete-btn"}
                    data-action-id={actionId}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void c.deleteHistoryItem(item.path);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    title="删除该历史"
                    aria-label="删除该历史"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
    const ignored = Array.isArray(c.settings.ignoredPaths) ? c.settings.ignoredPaths : [];
    const hasIgnored = ignored.some((p) => typeof p === "string" && p.trim().length > 0);
    return (
      <div className="list-bottom-info">
        {isHistoryMode ? (
          <div className="no-more-results">{`已显示全部 ${c.results.length} 条历史记录`}</div>
        ) : c.totalCount > 500 ? (
          <div className="no-more-results">由于内容太多，展示最匹配的前500</div>
        ) : (
          <div className="no-more-results">{`共 ${c.totalCount} 个结果`}</div>
        )}
        {hasIgnored ? (
          <div className="no-more-results ignore-tips">
            您配置了黑名单路径，如果搜索不到您想要的文件，可以尝试在【设置-搜索-黑名单路径】移除对应的路径再试~
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className={`container search-container ${c.typeMenuOpen ? "menu-open" : ""}`}
      ref={c.containerRef}
      onMouseDownCapture={(e) => {
        if (e.target !== e.currentTarget) return;
        c.hideWindow();
      }}
    >
      <BackgroundImage path={c.settings.backgroundImagePath} opacity={c.settings.backgroundImageOpacity} />
      <ParticleBackground enabled={c.settings.enableEffect} type={c.settings.effectType} />
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
      <div className="resize-handle left" onMouseDown={(e) => c.startResizing(e, "left")} />
      <div className="resize-handle right" onMouseDown={(e) => c.startResizing(e, "right")} />

      <div className="search-box">
        <div className="search-icon-wrapper">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="search-icon-svg">
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <input
          ref={c.inputRef}
          type="text"
          value={c.inputValue}
          onChange={(e) => c.setQuery(e.target.value)}
          placeholder={c.placeholder}
          autoFocus
        />

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
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}

          <div className="result-count">
            {/* 计数展示使用“去掉盘符前缀后的真实搜索词”，避免输入 `C:` 这类前缀影响 UI 文案逻辑 */}
            {c.trimmedQuery.length >= 1 && c.totalCount > 0 ? `${c.totalCount} 条结果` : ""}
          </div>

          <div className="type-select" ref={c.typeSelectRef}>
            <button
              className="type-select-btn"
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                c.setTypeMenuOpen((v) => !v);
              }}
              aria-haspopup="menu"
              aria-expanded={c.typeMenuOpen}
              aria-label="切换搜索类型"
              title="切换搜索类型"
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
                        c.setSearchTypeId(opt.id);
                        c.setTypeMenuOpen(false);
                      }}
                    >
                      <div className="type-select-item-left">
                        <span>{opt.label}</span>
                      </div>
                      {opt.id === c.searchTypeId && <span className="check-mark">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <button
          className="settings-btn"
          onClick={c.openSettings}
          title="设置"
          type="button"
          aria-label="设置"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" strokeWidth="1.8" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.05 2.05 0 0 1-1.45 3.5 2 2 0 0 1-1.45-.6l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.54V21a2.05 2.05 0 0 1-4.1 0v-.08a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-1.45.6 2.05 2.05 0 0 1-1.45-3.5l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.54-1H3a2.05 2.05 0 0 1 0-4.1h.08a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.05 2.05 0 0 1 5.71 3.5c.53 0 1.04.2 1.45.6l.06.06c.5.5 1.23.65 1.87.34a1.7 1.7 0 0 0 1-1.54V3a2.05 2.05 0 0 1 4.1 0v.08c0 .67.4 1.27 1 1.54.64.31 1.37.16 1.87-.34l.06-.06c.41-.4.92-.6 1.45-.6a2.05 2.05 0 0 1 1.45 3.5l-.06.06c-.5.5-.65 1.23-.34 1.87.27.6.87 1 1.54 1H21a2.05 2.05 0 0 1 0 4.1h-.08c-.67 0-1.27.4-1.54 1Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="drag-icon" title="按住拖拽移动" />
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
            <div className="empty-state">继续输入以开始搜索（至少 2 个字符）</div>
          ) : c.showEmptyState ? (
            <div className="empty-state">未找到匹配结果</div>
          ) : (
            <>
              <div
                ref={c.scrollContainerRef}
                className="results-scroll-container"
                style={{ maxHeight: c.MAX_LIST_HEIGHT, overflowY: "auto" }}
                onWheel={() => c.setLastSelectedBy("mouse")}
                onMouseDown={() => c.setLastSelectedBy("mouse")}
                onMouseLeave={() => c.setHoveredKey("")}
              >
                {/* 结果列表增量刷新时保持 hover 稳定：鼠标离开才清空 hoveredKey，避免 hover 视觉闪烁 */}
                <List<any>
                  listRef={c.listRef}
                  style={{ height: c.listHeight, width: "100%", overflow: "visible" }}
                  rowCount={c.visibleResults.length}
                  rowHeight={c.ITEM_HEIGHT}
                  className="virtual-list"
                  rowComponent={Row}
                  rowProps={{}}
                  onRowsRendered={(visibleRows: any) => c.onItemsRendered(visibleRows)}
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
