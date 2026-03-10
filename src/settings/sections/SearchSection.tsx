import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppSettings } from "../../appTypes";
import { getSearchTypeOptions } from "../../settingsStore";
import { TypeOrderItem } from "../../TypeOrderItem";

// 搜索设置分区：默认类型、自定义类型、列表显示与类型顺序（含会员禁用逻辑）
export function SearchSection({
  error,
  draft,
  setDraft,
  setError,
  newTypeExt,
  setNewTypeExt,
  isMember,
  membershipBadge,
  typeOptions,
  defaultTypeMenuOpen,
  setDefaultTypeMenuOpen,
  defaultTypeActiveIndex,
  setDefaultTypeActiveIndex,
  defaultTypeSelectRef,
  currentDefaultTypeLabel,
  pickDefaultTypeByIndex,
  moveTypeId,
}: {
  error: string;
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  newTypeExt: string;
  setNewTypeExt: (v: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  typeOptions: { id: string; label: string }[];
  defaultTypeMenuOpen: boolean;
  setDefaultTypeMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  defaultTypeActiveIndex: number;
  setDefaultTypeActiveIndex: (v: number | ((prev: number) => number)) => void;
  defaultTypeSelectRef: React.RefObject<HTMLDivElement>;
  currentDefaultTypeLabel: string;
  pickDefaultTypeByIndex: (idx: number) => void;
  moveTypeId: (list: string[], fromId: string, toId: string, position: "before" | "after") => string[];
}) {
  const [newIgnoredPath, setNewIgnoredPath] = useState("");
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<null | {
    text: string;
    left: number;
    top: number;
    placement: "top" | "bottom";
    anchor: { left: number; right: number; top: number; bottom: number };
    arrowLeft: number;
  }>(null);

  useEffect(() => {
    // 索引建立状态跨页面切换保持：重新进入“搜索”设置页时，如果后台仍在索引，则继续显示“建立中...”
    const syncIndexing = async () => {
      try {
        const st = (await window.ipcRenderer?.invoke("get-file-index-status")) as
          | { isIndexing: boolean }
          | undefined;
        if (typeof st?.isIndexing === "boolean") setIsRebuildingIndex(st.isIndexing);
      } catch {}
    };
    void syncIndexing();
  }, []);

  useEffect(() => {
    if (!isRebuildingIndex) return;
    // 索引完成后需要自动恢复按钮可点击：这里用轮询查询主进程索引状态，直到结束为止
    const timer = window.setInterval(async () => {
      try {
        const st = (await window.ipcRenderer?.invoke("get-file-index-status")) as
          | { isIndexing: boolean }
          | undefined;
        if (st?.isIndexing === false) setIsRebuildingIndex(false);
      } catch {}
    }, 1200);
    return () => window.clearInterval(timer);
  }, [isRebuildingIndex]);

  useEffect(() => {
    if (!tooltip) return;
    const hide = () => setTooltip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("mousedown", hide, true);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("mousedown", hide, true);
    };
  }, [tooltip]);

  useLayoutEffect(() => {
    if (!tooltip) return;
    const el = tooltipRef.current;
    if (!el) return;
    const gap = 10;
    const padding = 12;
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;

    const rect = tooltip.anchor;
    const tipRect = el.getBoundingClientRect();
    const tipW = tipRect.width || 0;
    const tipH = tipRect.height || 0;

    let placement: "top" | "bottom" = tooltip.placement;
    if (placement === "top" && rect.top - gap - tipH < padding) placement = "bottom";
    if (placement === "bottom" && rect.bottom + gap + tipH > viewportH - padding) placement = "top";

    const left = Math.min(Math.max(padding, rect.left), Math.max(padding, viewportW - padding - tipW));
    const top = placement === "top" ? rect.top - gap - tipH : rect.bottom + gap;

    const anchorCenter = (rect.left + rect.right) / 2;
    const arrowLeft = Math.min(Math.max(14, anchorCenter - left), Math.max(14, tipW - 14));

    setTooltip((prev) => {
      if (!prev) return prev;
      if (prev.left === left && prev.top === top && prev.placement === placement && prev.arrowLeft === arrowLeft) return prev;
      return { ...prev, left, top, placement, arrowLeft };
    });
  }, [tooltip?.text, tooltip?.anchor.left, tooltip?.anchor.right, tooltip?.anchor.top, tooltip?.anchor.bottom, tooltip?.placement]);

  const showTooltipByRect = (text: string, rect: DOMRect) => {
    const placement: "top" | "bottom" = rect.top > (window.innerHeight || 0) * 0.55 ? "top" : "bottom";
    setTooltip({
      text,
      left: 12,
      top: 12,
      placement,
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      arrowLeft: 14,
    });
  };

  // 搜索结果右侧按钮配置：保持未来可扩展（新增按钮只需追加选项与渲染逻辑）
  const resultActionOptions: { id: AppSettings["resultActionButtons"][number]; label: string; note?: string }[] = [
    { id: "openFolder", label: "打开所在目录" },
    { id: "copyPath", label: "复制路径" },
    // 管理员运行仅对“应用”有意义：文件/文件夹等不展示该按钮
    { id: "runAsAdmin", label: "使用管理员权限打开", note: "仅应用显示" },
    { id: "deleteHistory", label: "删除历史记录", note: "仅历史模式显示" },
  ];
  const selectedActionIds = Array.isArray(draft.resultActionButtons) ? draft.resultActionButtons : [];

  // 勾选/取消按钮：限制最多三项，超限给出提示
  const toggleAction = (id: AppSettings["resultActionButtons"][number]) => {
    if (!isMember) {
      setError("该功能订阅可用");
      return;
    }
    const exists = selectedActionIds.includes(id);
    if (exists) {
      setDraft({
        ...draft,
        resultActionButtons: selectedActionIds.filter((x) => x !== id),
      });
      setError("");
      return;
    }
    if (selectedActionIds.length >= 3) {
      setError("右侧按钮最多只能选择 3 个");
      return;
    }
    setDraft({
      ...draft,
      resultActionButtons: [...selectedActionIds, id],
    });
    setError("");
  };

  // 上下移动顺序：仅调整已选项的展示顺序
  const moveAction = (id: AppSettings["resultActionButtons"][number], dir: "up" | "down") => {
    if (!isMember) {
      setError("该功能订阅可用");
      return;
    }
    const idx = selectedActionIds.indexOf(id);
    if (idx < 0) return;
    const next = selectedActionIds.slice();
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= next.length) return;
    const tmp = next[target];
    next[target] = next[idx];
    next[idx] = tmp;
    setDraft({ ...draft, resultActionButtons: next });
    setError("");
  };

  const normalizeIgnoredPath = (v: string) => v.replace(/\//g, "\\").trim().replace(/[\\]+$/g, "");
  const ignoredPaths = Array.isArray(draft.ignoredPaths) ? draft.ignoredPaths : [];
  const addIgnoredPath = () => {
    const raw = newIgnoredPath.trim();
    const normalized = normalizeIgnoredPath(raw);
    if (!normalized) {
      setError("请输入要忽略的路径");
      return;
    }
    const exists = ignoredPaths.some((p) => normalizeIgnoredPath(p).toLowerCase() === normalized.toLowerCase());
    if (exists) {
      setError("该路径已存在");
      return;
    }
    setDraft({ ...draft, ignoredPaths: [...ignoredPaths, raw] });
    setNewIgnoredPath("");
    setError("");
  };

  const disabledTypeIds = Array.isArray(draft.disabledSearchTypeIds) ? draft.disabledSearchTypeIds : [];
  const isTypeDisabled = (id: string) => id !== "all" && disabledTypeIds.includes(id);
  const toggleTypeEnabled = (id: string) => {
    if (!id || id === "all") return;
    const disabled = isTypeDisabled(id);
    const nextDisabled = disabled ? disabledTypeIds.filter((x) => x !== id) : [...disabledTypeIds, id];
    const nextDefault = !disabled && draft.defaultSearchTypeId === id ? "all" : draft.defaultSearchTypeId;
    setDraft({ ...draft, disabledSearchTypeIds: nextDisabled, defaultSearchTypeId: nextDefault });
    setError("");
  };

  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">
          <span>默认类型</span>
          {membershipBadge}
        </div>
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
                    const next = (prev + delta + typeOptions.length) % typeOptions.length;
                    return next;
                  });
                  return;
                }
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!defaultTypeMenuOpen) setDefaultTypeMenuOpen(true);
                  else pickDefaultTypeByIndex(defaultTypeActiveIndex);
                  return;
                }
                if (e.key === "Tab") {
                  setDefaultTypeMenuOpen(false);
                }
              }}
              aria-haspopup="listbox"
              aria-expanded={defaultTypeMenuOpen}
              aria-label="默认类型选择"
              title={currentDefaultTypeLabel}
            >
              <span className="type-select-label">{currentDefaultTypeLabel}</span>
              <span className="type-select-caret">▾</span>
            </button>

            {defaultTypeMenuOpen ? (
              <div
                className="type-select-menu"
                role="listbox"
                aria-label="默认类型列表"
                onMouseDown={(e) => e.stopPropagation()}
              >
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
        <div className="settings-group-title">
          <span>列表显示</span>
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
      </div>

      <div className="settings-group">
        <div className="settings-group-title">
          <span>路径黑名单</span>
        </div>
        <div className="settings-hint">
          命中前缀的路径及其子目录将被忽略（可配置多个，上不封顶）
        </div>
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
              className="fs-tooltip-pop"
              data-placement={tooltip.placement}
              style={
                {
                  left: tooltip.left,
                  top: tooltip.top,
                  ["--fs-tooltip-arrow-left" as any]: `${tooltip.arrowLeft}px`,
                } as any
              }
            >
              <div className="fs-tooltip-text">{tooltip.text}</div>
              <div className="fs-tooltip-arrow" />
            </div>,
            document.body,
          )
        : null}

      <div className="settings-group">
        <div className="settings-group-title">
          <span>自定义类型</span>
          {membershipBadge}
        </div>
        {/* 自定义类型作为高级功能：非会员保持禁用，但支持回车提交，提高录入效率 */}
        <div className="form-row">
          <div className="form-label">新增后缀</div>
          <div className="input-with-btn">
            <input
              type="text"
              className="text-input"
              value={newTypeExt}
              placeholder=".docx"
              disabled={!isMember}
              onChange={(e) => {
                setNewTypeExt(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.stopPropagation();
                if (!isMember) return;
                const ext = newTypeExt.trim().toLowerCase();
                if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
                  setError("后缀格式不合法（例如 .docx）");
                  return;
                }
                if (draft.customSearchTypes.includes(ext)) {
                  setError("该类型已存在");
                  return;
                }
                const nextCustom = [...draft.customSearchTypes, ext];
                const nextOrder = getSearchTypeOptions(nextCustom, [
                  ...(draft.searchTypeOrder || []),
                  `ext:${ext}`,
                ]).map((x) => x.id);
                setDraft({
                  ...draft,
                  customSearchTypes: nextCustom,
                  searchTypeOrder: nextOrder,
                });
                setNewTypeExt("");
                setError("");
              }}
            />
            <button
              type="button"
              className="small-btn"
              disabled={!isMember}
              onClick={() => {
                const ext = newTypeExt.trim().toLowerCase();
                if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
                  setError("后缀格式不合法（例如 .docx）");
                  return;
                }
                if (draft.customSearchTypes.includes(ext)) {
                  setError("该类型已存在");
                  return;
                }
                const nextCustom = [...draft.customSearchTypes, ext];
                const nextOrder = getSearchTypeOptions(nextCustom, [
                  ...(draft.searchTypeOrder || []),
                  `ext:${ext}`,
                ]).map((x) => x.id);
                setDraft({
                  ...draft,
                  customSearchTypes: nextCustom,
                  searchTypeOrder: nextOrder,
                });
                setNewTypeExt("");
                setError("");
              }}
            >
              添加
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">
          <span>类型顺序</span>
          {membershipBadge}
        </div>
        <div className="type-order-list">
          <div className="type-order-list-inner">
            {typeOptions.map((opt) => (
              <TypeOrderItem
                key={opt.id}
                id={opt.id}
                label={opt.label}
                isCustom={opt.id.startsWith("ext:")}
                orderedIds={typeOptions.map((x) => x.id)}
                disabled={!isMember}
                rightExtra={
                  opt.id === "all" ? null : (
                    <button
                      type="button"
                      className={`type-toggle-btn ${isTypeDisabled(opt.id) ? "on" : ""}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleTypeEnabled(opt.id);
                      }}
                      aria-pressed={!isTypeDisabled(opt.id)}
                      aria-label={isTypeDisabled(opt.id) ? "启用该类型" : "禁用该类型"}
                    >
                      {isTypeDisabled(opt.id) ? "开启" : "关闭"}
                    </button>
                  )
                }
                onMove={(fromId, toId, position) => {
                  if (!isMember) return;
                  const nextOrder = moveTypeId(
                    typeOptions.map((x) => x.id),
                    fromId,
                    toId,
                    position,
                  );
                  setDraft({ ...draft, searchTypeOrder: nextOrder });
                  setError("");
                }}
                onDelete={(targetId) => {
                  if (!isMember) return;
                  if (!targetId.startsWith("ext:")) return;
                  const ext = targetId.slice(4);
                  const nextCustom = (draft.customSearchTypes || []).filter(
                    (x) => x !== ext,
                  );
                  const nextDefault =
                    draft.defaultSearchTypeId === targetId
                      ? "all"
                      : draft.defaultSearchTypeId;
                  const nextOrder = getSearchTypeOptions(
                    nextCustom,
                    (draft.searchTypeOrder || []).filter((x) => x !== targetId),
                  ).map((x) => x.id);
                  setDraft({
                    ...draft,
                    customSearchTypes: nextCustom,
                    defaultSearchTypeId: nextDefault,
                    searchTypeOrder: nextOrder,
                  });
                  setError("");
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-title">
          <span>结果右侧按钮</span>
          {membershipBadge}
        </div>
        <div className="settings-hint">
          {!isMember
            ? "订阅后可自定义；非会员使用默认按钮"
            : "最多显示 3 项，可调整顺序；后续新增按钮也在此处选择展示"}
        </div>
        <div className="action-config-list">
          {resultActionOptions.map((opt) => {
            const checked = selectedActionIds.includes(opt.id);
            const order = checked ? selectedActionIds.indexOf(opt.id) + 1 : 0;
            const disableAdd = !checked && selectedActionIds.length >= 3;
            return (
              <div key={opt.id} className={`action-config-row ${checked ? "checked" : ""} ${disableAdd ? "disabled" : ""}`}>
                <label className="action-config-left">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disableAdd || !isMember}
                    onChange={() => toggleAction(opt.id)}
                  />
                  <span className="action-config-label">
                    {opt.label}
                    {opt.note ? <span className="action-config-note">{opt.note}</span> : null}
                  </span>
                </label>
                <div className="action-config-right">
                  {checked ? <span className="action-config-order">{order}</span> : null}
                  <button
                    type="button"
                    className="small-btn ghost"
                    disabled={!isMember || !checked || order <= 1}
                    onClick={() => moveAction(opt.id, "up")}
                    aria-label="上移"
                    title="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small-btn ghost"
                    disabled={!isMember || !checked || order >= selectedActionIds.length}
                    onClick={() => moveAction(opt.id, "down")}
                    aria-label="下移"
                    title="下移"
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-title">索引管理</div>
        <div className="settings-hint">
          扫描整台电脑建立/补齐索引。该过程可能持续一段时间，但会在后台进行，请耐心等待。
        </div>
        <div className="form-row">
          <div className="form-label">全盘索引</div>
          <button
            type="button"
            className="small-btn"
            disabled={isRebuildingIndex}
            onClick={async () => {
              // 二次确认：全盘索引可能耗时较长，避免用户误触
              const ok = window.confirm(
                "将扫描整台电脑建立索引，此过程需要一定时间，期间可能会持续占用磁盘与 CPU。\n\n确定要开始吗？",
              );
              if (!ok) return;
              // 触发后立即返回：避免等待索引任务完成导致 UI 阻塞，按钮状态由轮询自动恢复
              setIsRebuildingIndex(true);
              setError("");
              // 索引构建需要尊重“路径黑名单”等配置：将当前 draft 配置传给主进程生效
              void window.ipcRenderer?.invoke("rebuild-file-index", { ignoredPaths: draft.ignoredPaths }).catch(() => {});
            }}
          >
            {isRebuildingIndex ? "建立中..." : "开始全盘建立索引"}
          </button>
        </div>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
    </div>
  );
}

