import { useMemo } from "react";
import { List } from "react-window";
import { BackgroundImage } from "../components/BackgroundImage";
import { ParticleBackground } from "../components/ParticleBackground";
import { AppItem } from "../appTypes";
import { useSearchController } from "./useSearchController";

// 搜索页渲染层：纯 UI/交互展示，状态与副作用集中在 useSearchController
export function SearchViewImpl() {
  const c = useSearchController();

  const isHistoryMode = c.query.trim().length === 0;

  // 根据用户配置与当前模式筛选右侧按钮：最多展示三项，避免右侧区域拥挤
  const visibleActionIds = useMemo(() => {
    const raw = Array.isArray(c.settings.resultActionButtons) ? c.settings.resultActionButtons : [];
    const out: string[] = [];
    for (const id of raw) {
      if (id === "deleteHistory" && !isHistoryMode) continue;
      if (!["openFolder", "copyPath", "deleteHistory"].includes(id)) continue;
      if (out.includes(id)) continue;
      out.push(id);
      if (out.length >= 3) break;
    }
    return out;
  }, [c.settings.resultActionButtons, isHistoryMode]);

  const highlightQuery = useMemo(() => {
    const q = c.query.trim();
    if (q.length < 2 || q.length > 32) return "";
    return q.toLowerCase();
  }, [c.query]);

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

  const isImageFile = (path: string) => {
    const ext = (path.split(".").pop() || "").toLowerCase();
    return ["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg"].includes(ext);
  };

  const renderResultIcon = (item: AppItem, isImg: boolean) => {
    if (item.type === "folder") {
      return (
        <svg className="result-icon folder-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M10.2 5.2h-5A2.2 2.2 0 0 0 3 7.4v9.3A2.3 2.3 0 0 0 5.3 19h13.4A2.3 2.3 0 0 0 21 16.7V9.3A2.3 2.3 0 0 0 18.7 7H12l-1.3-1.4a2 2 0 0 0-1.5-.4Z"
            fill="currentColor"
            opacity="0.16"
          />
          <path
            d="M4.5 8.2h15.2a1.6 1.6 0 0 1 1.6 1.6v6.8a1.8 1.8 0 0 1-1.8 1.8H5.1A2.1 2.1 0 0 1 3 16.3V9.7a1.5 1.5 0 0 1 1.5-1.5Z"
            fill="currentColor"
            opacity="0.34"
          />
          <path
            d="M4.5 8.2h15.2a1.6 1.6 0 0 1 1.6 1.6v6.8a1.8 1.8 0 0 1-1.8 1.8H5.1A2.1 2.1 0 0 1 3 16.3V9.7a1.5 1.5 0 0 1 1.5-1.5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            opacity="0.8"
          />
        </svg>
      );
    }

    if (item.type === "app") {
      if (!item.icon) return <span className="result-icon placeholder" />;
      return <img className="result-icon" src={item.icon} alt="" />;
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

    const isSelected = index === c.selectedIndex;
    const isImg = item.type === "file" && isImageFile(item.path);
    const lowerPath = (item.path || "").toLowerCase();
    const isLink = lowerPath.endsWith(".lnk") || lowerPath.endsWith(".url");
    const badgeText =
      item.type === "folder"
        ? "文件夹"
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
        onClick={() => c.launchApp(item)}
        onMouseEnter={() => {
          if (c.selectedIndex !== index) {
            c.setLastSelectedBy("mouse");
            c.setSelectedIndex(index);
          }
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
            {visibleActionIds.map((actionId) => {
              if (actionId === "openFolder") {
                return (
                  <button
                    key={actionId}
                    className="action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      c.openFolder(item);
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
                    className="action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(item.path);
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
              if (actionId === "deleteHistory") {
                return (
                  <button
                    key={actionId}
                    className="action-btn delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      void c.deleteHistoryItem(item.path);
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
    return (
      <div className="list-bottom-info">
        {c.visibleResults.length < c.results.length ? (
          c.isSearching || c.isIndexing ? (
            <div className="loading-more">
              <span className="spinner" />
              <span>正在加载更多结果...</span>
            </div>
          ) : (
            <div className="no-more-results">
              {`已显示 ${c.visibleResults.length} / ${c.results.length} ${isHistoryMode ? "条历史记录" : "个结果"}`}
            </div>
          )
        ) : (
          <div className="no-more-results">
            {isHistoryMode ? `已显示全部 ${c.results.length} 条历史记录` : `已显示全部 ${c.results.length} 个结果`}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`container search-container ${c.typeMenuOpen ? "menu-open" : ""}`}
      ref={c.containerRef}
      onKeyDownCapture={c.handleKeyDownCapture}
    >
      <BackgroundImage path={c.settings.backgroundImagePath} opacity={c.settings.backgroundImageOpacity} />
      <ParticleBackground enabled={c.settings.enableEffect} type={c.settings.effectType} />
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
          value={c.query}
          onChange={(e) => c.setQuery(e.target.value)}
          placeholder={c.placeholder}
          autoFocus
        />

        <div className="search-box-right">
          {c.query.trim().length > 0 ? (
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
            {c.results.length > 0 ? `${c.results.length} 条结果` : ""}
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
              >
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
                <BottomInfo />
              </div>
              {c.selectedIndex > 8 && (
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
