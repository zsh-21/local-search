import { useMemo } from "react";
import { List } from "react-window";
import type { AppItem } from "../appTypes";
import {
  IconCalc,
  IconChevronUp,
  IconCopyPath,
  IconDeleteHistory,
  IconFile,
  IconFolder,
  IconOpenFolder,
  IconRunAsAdmin,
  IconSettings,
} from "../components/icons/SettingsIcons";
import { normalizeResultKey } from "./searchResultUtils";
import type { useSearchController } from "./useSearchController";
import { buildSearchHighlightRanges, parseSearchMatchIntent, type SearchHighlightRange } from "../../shared/searchMatch";

type SearchController = ReturnType<typeof useSearchController>;

type SearchResultsPanelProps = {
  c: SearchController;
  isHistoryMode: boolean;
  isCalcMode: boolean;
  statusText: string;
};

export function SearchResultsPanel({ c, isHistoryMode, isCalcMode, statusText }: SearchResultsPanelProps) {
  const getVisibleActionIdsForItem = (item: AppItem) => {
    if (item.type === "calc") return isCalcMode ? ["deleteHistory"] : [];
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

  const highlightIntent = useMemo(() => parseSearchMatchIntent(c.trimmedQuery), [c.trimmedQuery]);
  const highlightPathMode = highlightIntent.matchTarget === "path" && highlightIntent.tokens.length > 0;
  const highlightNameMode = highlightIntent.matchTarget === "name" && highlightIntent.tokens.length > 0;

  const renderHighlightedText = (text: string, ranges: SearchHighlightRange[]) => {
    if (!ranges || ranges.length === 0) return text;
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
      nodes.push(
        <span className="match" key={`${range.start}-${range.end}-${i}`}>
          {text.slice(range.start, range.end)}
        </span>,
      );
      cursor = range.end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return <>{nodes}</>;
  };

  const buildIconClassName = (icon: string | undefined, extra?: string) => {
    const classes = ["result-icon"];
    if (extra) classes.push(extra);
    if (icon && icon.startsWith("data:image/svg+xml")) classes.push("svg-icon");
    return classes.join(" ");
  };

  const isImageFile = (targetPath: string) => {
    const ext = (targetPath.split(".").pop() || "").toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg"].includes(ext);
  };

  const isCalcLikeItem = (item: AppItem) => {
    if (item.type === "calc") return true;
    if (!isCalcMode) return false;
    const candidates = [item.description, item.path, item.name];
    return candidates.some((text) => typeof text === "string" && text.trim().startsWith("="));
  };

  const renderResultIcon = (item: AppItem, isImg: boolean) => {
    const iconData =
      (typeof item.iconKey === "string" && item.iconKey ? c.iconByKey[item.iconKey.toLowerCase()] : "") ||
      item.icon ||
      "";
    if (isCalcLikeItem(item)) {
      if (c.calculatorIconDataUrl) {
        return <img className={buildIconClassName(c.calculatorIconDataUrl)} src={c.calculatorIconDataUrl} alt="" />;
      }
      return <IconCalc size={40} className="result-icon" />;
    }
    if (item.type === "folder") {
      return <IconFolder size={40} className="result-icon" />;
    }
    if (item.type === "app") {
      if (!iconData) return <span className="result-icon placeholder fallback-icon fallback-app-icon" aria-hidden="true" />;
      return <img className={buildIconClassName(iconData)} src={iconData} alt="" />;
    }
    if (item.type === "settings") {
      return <IconSettings size={40} className="result-icon" />;
    }
    if (item.type === "file") {
      if (iconData && isImg) return <img className="result-icon image-preview" src={iconData} alt="" />;
      if (iconData) return <img className={buildIconClassName(iconData)} src={iconData} alt="" />;
      return <IconFile size={40} className="result-icon" />;
    }
    return <span className="result-icon placeholder fallback-icon fallback-generic-icon" aria-hidden="true" />;
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

    const isSelected = index === c.selectedIndex;
    const isImg = item.type === "file" && isImageFile(item.path);
    const isNativeCalcItem = item.type === "calc";
    const calcExpression = isNativeCalcItem ? String(item.path || "").trim() : "";
    const calcResult = isNativeCalcItem ? String(item.name || "").trim() : "";
    const displayName = isNativeCalcItem && calcExpression && calcResult ? `${calcExpression}=${calcResult}` : item.name;
    const hasPath = typeof item.path === "string" && item.path.trim().length > 0;
    const isDrivePath = /^[a-zA-Z]:\\/.test(item.path || "");
    const nameHighlightRanges = highlightNameMode ? buildSearchHighlightRanges(displayName, highlightIntent) : [];
    const pathHighlightRanges = highlightPathMode ? buildSearchHighlightRanges(item.path, highlightIntent) : [];
    const showPathLine = !isNativeCalcItem && hasPath && (highlightPathMode || (c.settings.showResultPath && isDrivePath));
    const tooltipAddress = showPathLine ? item.path : undefined;

    const actionIds = getVisibleActionIdsForItem(item);

    return (
      <div
        style={style}
        {...ariaAttributes}
        className={`result-item-wrapper ${isSelected ? "selected" : ""}`}
        onMouseDown={(e) => {
          if (e.button === 0) c.launchApp(item);
        }}
        onMouseEnter={() => {
          c.setHoveredKey(normalizeResultKey(item));
        }}
      >
        <li className={`${isSelected ? "selected" : ""} ${c.hoveredKey === normalizeResultKey(item) ? "hovered" : ""}`}>
          <span className="result-index">{index + 1}</span>
          {renderResultIcon(item, isImg)}
          <div className="result-meta">
            <div className="result-name-row">
              <span className="app-name" title={displayName} data-title-delay="500" data-title-no-scroll="true">
                {renderHighlightedText(displayName, nameHighlightRanges)}
              </span>
            </div>
            {showPathLine ? (
              <span className="app-path" title={tooltipAddress} data-title-delay="500" data-title-no-scroll="true">
                {renderHighlightedText(item.path, pathHighlightRanges)}
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
                    <IconOpenFolder size={18} />
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
                    <IconCopyPath size={18} />
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
                    <IconRunAsAdmin size={18} />
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
                      void c.deleteResultItem(item);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    title="删除该历史"
                    aria-label="删除该历史"
                  >
                    <IconDeleteHistory size={18} />
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
    const visibleCount = c.visibleResults.length;
    const hasIgnored = ignored.some((p) => typeof p === "string" && p.trim().length > 0);
    const isShortQueryMode = !isHistoryMode && !isCalcMode && c.trimmedQuery.length > 0 && c.trimmedQuery.length <= 2;
    return (
      <div className="list-bottom-info">
        {isHistoryMode ? (
          <div className="no-more-results">{`已显示全部 ${visibleCount} 条历史记录`}</div>
        ) : c.hasMore ? (
          <div className="no-more-results">{`已显示 ${visibleCount} 条高匹配结果（仍在加载更多）`}</div>
        ) : (
          <div className="no-more-results">{`共 ${visibleCount} 个结果`}</div>
        )}
        {isShortQueryMode ? (
          <div className="no-more-results ignore-tips">短查询（1~2 字符）仅展示前 10 条结果，不再继续补批。</div>
        ) : null}
        {hasIgnored ? (
          <div className="no-more-results ignore-tips">
            如果搜索不到您想要的文件，可以尝试在【设置-搜索-黑名单路径】移除对应的路径再试~
          </div>
        ) : null}
      </div>
    );
  };

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
            onWheel={() => {
              c.clearActionSelection();
            }}
            onMouseDown={() => {
              c.clearActionSelection();
            }}
            onMouseLeave={() => c.setHoveredKey("")}
          >
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
              onRowsRendered={(visibleRows: any) => c.onItemsRendered(visibleRows)}
            />
          </div>
          <BottomInfo />
          {c.showBackToTop && (
            <button className="back-to-top-btn" onClick={c.scrollToTop} title="返回顶部" type="button">
              <IconChevronUp size={20} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
