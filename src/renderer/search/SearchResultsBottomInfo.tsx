/** 列表底部提示信息 */
export function SearchResultsBottomInfo(props: {
  resultsCount: number;
  visibleCount: number;
  hasMore: boolean;
  isHistoryMode: boolean;
  isCalcMode: boolean;
  trimmedQuery: string;
  ignoredPaths: string[];
}) {
  if (props.resultsCount === 0) return null;
  const ignored = Array.isArray(props.ignoredPaths) ? props.ignoredPaths : [];
  const hasIgnored = ignored.some((p) => typeof p === "string" && p.trim().length > 0);
  const isShortQueryMode =
    !props.isHistoryMode &&
    !props.isCalcMode &&
    props.trimmedQuery.length > 0 &&
    props.trimmedQuery.length <= 2;

  return (
    <div className="list-bottom-info">
      {props.isHistoryMode ? (
        <div className="no-more-results">{`已显示全部 ${props.visibleCount} 条历史记录`}</div>
      ) : props.hasMore ? (
        <div className="no-more-results">{`已显示 ${props.visibleCount} 条高匹配结果（仍在加载更多）`}</div>
      ) : (
        <div className="no-more-results">{`共 ${props.visibleCount} 个结果`}</div>
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
}
