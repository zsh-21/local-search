import type { CSSProperties, Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { AppSettings } from "../../../appTypes";
import type {
  NumberInputKeydownHandler,
  TooltipPayload,
} from "./searchSectionSharedTypes";

type SearchSectionBasicsProps = {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  membershipBadge: ReactNode;
  isMember: boolean;
  defaultTypeMenuOpen: boolean;
  setDefaultTypeMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  defaultTypeActiveIndex: number;
  setDefaultTypeActiveIndex: (v: number | ((prev: number) => number)) => void;
  defaultTypeSelectRef: RefObject<HTMLDivElement>;
  currentDefaultTypeLabel: string;
  typeOptions: { id: string; label: string }[];
  pickDefaultTypeByIndex: (idx: number) => void;
  handleNumberInputKeyDown: NumberInputKeydownHandler;
  searchWindowInitialWidthText: string;
  setSearchWindowInitialWidthText: (v: string) => void;
  searchWindowMaxHeightText: string;
  setSearchWindowMaxHeightText: (v: string) => void;
  clampInt: (v: unknown, fallback: number, min: number, max: number) => number;
  newIgnoredPath: string;
  setNewIgnoredPath: (v: string) => void;
  ignoredPaths: string[];
  addIgnoredPath: () => void;
  showTooltipByRect: (text: string, rect: DOMRect) => void;
  setTooltip: Dispatch<SetStateAction<TooltipPayload | null>>;
  tooltip: TooltipPayload | null;
  tooltipRef: RefObject<HTMLDivElement>;
};

export function SearchSectionBasics({
  draft,
  setDraft,
  setError,
  membershipBadge,
  isMember,
  defaultTypeMenuOpen,
  setDefaultTypeMenuOpen,
  defaultTypeActiveIndex,
  setDefaultTypeActiveIndex,
  defaultTypeSelectRef,
  currentDefaultTypeLabel,
  typeOptions,
  pickDefaultTypeByIndex,
  handleNumberInputKeyDown,
  searchWindowInitialWidthText,
  setSearchWindowInitialWidthText,
  searchWindowMaxHeightText,
  setSearchWindowMaxHeightText,
  clampInt,
  newIgnoredPath,
  setNewIgnoredPath,
  ignoredPaths,
  addIgnoredPath,
  showTooltipByRect,
  setTooltip,
  tooltip,
  tooltipRef,
}: SearchSectionBasicsProps) {
  return (
    <>
      <div className="settings-group" style={{ zIndex: defaultTypeMenuOpen ? 100 : undefined }}>
        <div className="settings-group-title">
          <span>默认类型</span>
          {membershipBadge}
        </div>
        <div className="settings-hint">设置搜索框初始选中的类型（订阅可配置）。</div>
        <div className="form-row">
          <div className="form-label">默认选择</div>
          <div className="settings-type-select type-select" ref={defaultTypeSelectRef}>
            <button
              className="type-select-btn"
              type="button"
              disabled={!isMember}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!isMember) return;
                setDefaultTypeMenuOpen((v) => !v);
              }}
              onKeyDown={(e) => {
                if (!isMember) return;
                if (e.key === "Escape") {
                  setDefaultTypeMenuOpen(false);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setDefaultTypeMenuOpen(true);
                  setDefaultTypeActiveIndex((prev) => {
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    return (prev + delta + typeOptions.length) % typeOptions.length;
                  });
                  return;
                }
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!defaultTypeMenuOpen) setDefaultTypeMenuOpen(true);
                  else pickDefaultTypeByIndex(defaultTypeActiveIndex);
                  return;
                }
                if (e.key === "Tab") setDefaultTypeMenuOpen(false);
              }}
              aria-haspopup="listbox"
              aria-expanded={defaultTypeMenuOpen}
              aria-label="默认类型选择"
              title={currentDefaultTypeLabel}
            >
              <span className="type-select-label">{currentDefaultTypeLabel}</span>
              <span className="type-select-caret">▼</span>
            </button>

            {defaultTypeMenuOpen ? (
              <div className="type-select-menu" role="listbox" aria-label="默认类型列表" onMouseDown={(e) => e.stopPropagation()}>
                <div className="type-select-menu-inner">
                  {typeOptions.map((opt, idx) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={opt.id === draft.defaultSearchTypeId}
                      className={`type-select-item ${opt.id === draft.defaultSearchTypeId ? "active" : ""} ${idx === defaultTypeActiveIndex ? "kbd-active" : ""}`}
                      onMouseMove={() => setDefaultTypeActiveIndex(idx)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        pickDefaultTypeByIndex(idx);
                      }}
                    >
                      <div className="type-select-item-left">
                        <span>{opt.label}</span>
                      </div>
                      {opt.id === draft.defaultSearchTypeId && <span className="check-mark">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">列表显示</div>
        <div className="settings-hint">控制结果列表展示条数与密度（仅影响显示，不影响命中数量）。</div>
        <div className="form-row">
          <div className="form-label">展示条数</div>
          <input
            type="text"
            className="text-input"
            inputMode="numeric"
            value={String(draft.searchDisplayLimit)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const n = raw === "" ? NaN : Number(raw);
              if (!Number.isFinite(n)) return;
              const next = Math.min(100, Math.max(20, Math.round(n)));
              setDraft({ ...draft, searchDisplayLimit: next });
              setError("");
            }}
            onKeyDown={(e) =>
              handleNumberInputKeyDown(e, {
                min: 20,
                max: 100,
                integer: true,
                step: 1,
                fallbackValue: draft.searchDisplayLimit,
                onValueChange: (nextValue: number) => {
                  setDraft({ ...draft, searchDisplayLimit: nextValue });
                  setError("");
                },
              })
            }
          />
        </div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.showResultPath}
            onChange={(e) => {
              setDraft({ ...draft, showResultPath: e.target.checked });
              setError("");
            }}
          />
          <span>显示列表文件地址</span>
        </label>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.compactMode}
            onChange={(e) => {
              setDraft({ ...draft, compactMode: e.target.checked });
              setError("");
            }}
          />
          <span>紧凑模式</span>
        </label>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">搜索窗口尺寸</div>
        <div className="settings-hint">初始宽度范围 450-1000；最大高度不会超过当前屏幕可用高度。</div>
        <div className="form-row">
          <div className="form-label">初始宽度</div>
          <input
            type="text"
            className="text-input"
            inputMode="numeric"
            value={searchWindowInitialWidthText}
            onChange={(e) => setSearchWindowInitialWidthText(e.target.value)}
            onBlur={() => {
              const raw = searchWindowInitialWidthText.trim();
              const next = clampInt(raw, draft.searchWindowInitialWidth, 450, 1000);
              setDraft({ ...draft, searchWindowInitialWidth: next });
              setError("");
              setSearchWindowInitialWidthText(String(next));
            }}
            onKeyDown={(e) =>
              handleNumberInputKeyDown(e, {
                min: 450,
                max: 1000,
                integer: true,
                step: 1,
                fallbackValue: draft.searchWindowInitialWidth,
                onValueChange: (nextValue: number) => {
                  setDraft({ ...draft, searchWindowInitialWidth: nextValue });
                  setSearchWindowInitialWidthText(String(nextValue));
                  setError("");
                },
              })
            }
          />
        </div>
        <div className="form-row">
          <div className="form-label">最大高度</div>
          <input
            type="text"
            className="text-input"
            inputMode="numeric"
            value={searchWindowMaxHeightText}
            onChange={(e) => setSearchWindowMaxHeightText(e.target.value)}
            onBlur={() => {
              const raw = searchWindowMaxHeightText.trim();
              const max = Math.max(200, Math.floor(window.screen?.availHeight || 0));
              const next = clampInt(raw, draft.searchWindowMaxHeight, 200, max);
              setDraft({ ...draft, searchWindowMaxHeight: next });
              setError("");
              setSearchWindowMaxHeightText(String(next));
            }}
            onKeyDown={(e) =>
              handleNumberInputKeyDown(e, {
                min: 200,
                max: Math.max(200, Math.floor(window.screen?.availHeight || 0)),
                integer: true,
                step: 1,
                fallbackValue: draft.searchWindowMaxHeight,
                onValueChange: (nextValue: number) => {
                  setDraft({ ...draft, searchWindowMaxHeight: nextValue });
                  setSearchWindowMaxHeightText(String(nextValue));
                  setError("");
                },
              })
            }
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">路径黑名单</div>
        <div className="settings-hint">命中前缀的路径及其子目录会被忽略，适合排除缓存或临时目录。</div>
        <div className="form-row">
          <div className="form-label">新增路径</div>
          <div className="input-with-btn">
            <input
              type="text"
              className="text-input"
              value={newIgnoredPath}
              placeholder="例如 D:\\Downloads 或 C:\\Users\\xxx\\AppData\\Local"
              onChange={(e) => {
                setNewIgnoredPath(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addIgnoredPath();
                }
              }}
            />
            <button type="button" className="small-btn" onClick={addIgnoredPath}>
              添加
            </button>
          </div>
        </div>
        {ignoredPaths.length > 0 ? (
          <div className="action-config-list">
            {ignoredPaths.map((p) => (
              <div key={p} className="action-config-row checked">
                <div className="action-config-left">
                  <span className="action-config-label">
                    <span
                      className="fs-ellipsis"
                      onMouseEnter={(e) => showTooltipByRect(p, (e.currentTarget as HTMLElement).getBoundingClientRect())}
                      onMouseLeave={() => setTooltip(null)}
                    >
                      {p}
                    </span>
                  </span>
                </div>
                <div className="action-config-right">
                  <button
                    type="button"
                    className="small-btn ghost"
                    onClick={() => {
                      setDraft({ ...draft, ignoredPaths: ignoredPaths.filter((x) => x !== p) });
                      setError("");
                    }}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {tooltip
        ? createPortal(
            <div
              ref={tooltipRef}
              className={`fs-tooltip-pop ${tooltip.kind === "info" ? "fs-tooltip-pop--info" : ""}`}
              data-placement={tooltip.placement}
              style={
                {
                  left: tooltip.left,
                  top: tooltip.top,
                  "--fs-tooltip-arrow-left": `${tooltip.arrowLeft}px`,
                } as CSSProperties & { "--fs-tooltip-arrow-left": string }
              }
            >
              <div className="fs-tooltip-text">{tooltip.text}</div>
              {tooltip.kind === "info" && tooltip.example ? <div className="fs-tooltip-example">{tooltip.example}</div> : null}
              <div className="fs-tooltip-arrow" />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
