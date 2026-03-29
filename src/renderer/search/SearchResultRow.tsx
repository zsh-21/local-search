import type { CSSProperties, ReactNode } from "react";
import type { AppItem, ResultActionButtonId } from "../appTypes";
import { normalizeResultKey } from "./searchResultUtils";
import {
  buildSearchHighlightRanges,
  type SearchHighlightRange,
  type SearchMatchIntent,
} from "../../shared/utils/searchMatch";
import { SearchResultActionButtons } from "./SearchResultActionButtons";
import { SearchResultIcon } from "./SearchResultIcon";

/** 渲染高亮文本片段 */
function renderHighlightedText(text: string, ranges: SearchHighlightRange[]): ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range.start > cursor) nodes.push(text.slice(cursor, range.start));
    nodes.push(<span className="match" key={`${range.start}-${range.end}-${i}`}>{text.slice(range.start, range.end)}</span>);
    cursor = range.end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** 单行结果组件：负责名称/路径/图标和操作按钮渲染 */
export function SearchResultRow(props: {
  index: number;
  item: AppItem;
  style: CSSProperties;
  ariaAttributes?: Record<string, unknown>;
  isSelected: boolean;
  hoveredKey: string;
  selectedActionId: string;
  isCalcMode: boolean;
  showResultPath: boolean;
  highlightIntent: SearchMatchIntent;
  highlightNameMode: boolean;
  highlightPathMode: boolean;
  actionIds: ResultActionButtonId[];
  iconByKey: Record<string, string>;
  calculatorIconDataUrl: string;
  onLaunchApp: (item: AppItem) => void;
  onOpenFolder: (item: AppItem) => void;
  onCopyPath: (item: AppItem) => void;
  onRunAsAdmin: (item: AppItem) => void;
  onDeleteHistory: (item: AppItem) => Promise<void>;
  onHover: (item: AppItem) => void;
}) {
  const { item, highlightIntent, highlightNameMode, highlightPathMode } = props;
  const isNativeCalcItem = item.type === "calc";
  const calcExpression = isNativeCalcItem ? String(item.path || "").trim() : "";
  const calcResult = isNativeCalcItem ? String(item.name || "").trim() : "";
  const displayName = isNativeCalcItem && calcExpression && calcResult ? `${calcExpression}=${calcResult}` : item.name;
  const hasPath = typeof item.path === "string" && item.path.trim().length > 0;
  const isDrivePath = /^[a-zA-Z]:\\/.test(item.path || "");
  const nameHighlightRanges = highlightNameMode ? buildSearchHighlightRanges(displayName, highlightIntent) : [];
  const pathHighlightRanges = highlightPathMode ? buildSearchHighlightRanges(item.path, highlightIntent) : [];
  const showPathLine = !isNativeCalcItem && hasPath && (highlightPathMode || (props.showResultPath && isDrivePath));
  const tooltipAddress = showPathLine ? item.path : undefined;
  const itemKey = normalizeResultKey(item);

  return (
    <div
      style={props.style}
      {...(props.ariaAttributes as object)}
      className={`result-item-wrapper ${props.isSelected ? "selected" : ""}`}
      onMouseDown={(event) => {
        if (event.button === 0) props.onLaunchApp(item);
      }}
      onMouseEnter={() => props.onHover(item)}
    >
      <li className={`${props.isSelected ? "selected" : ""} ${props.hoveredKey === itemKey ? "hovered" : ""}`}>
        <span className="result-index">{props.index + 1}</span>
        <SearchResultIcon
          item={item}
          isCalcMode={props.isCalcMode}
          calculatorIconDataUrl={props.calculatorIconDataUrl}
          iconByKey={props.iconByKey}
        />
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
        <SearchResultActionButtons
          item={item}
          actionIds={props.actionIds}
          selectedActionId={props.selectedActionId}
          isSelectedRow={props.isSelected}
          onOpenFolder={props.onOpenFolder}
          onCopyPath={props.onCopyPath}
          onRunAsAdmin={props.onRunAsAdmin}
          onDeleteHistory={props.onDeleteHistory}
        />
      </li>
    </div>
  );
}
