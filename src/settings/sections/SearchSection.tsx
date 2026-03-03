import { ReactNode } from "react";
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
  // 搜索结果右侧按钮配置：保持未来可扩展（新增按钮只需追加选项与渲染逻辑）
  const resultActionOptions: { id: AppSettings["resultActionButtons"][number]; label: string; note?: string }[] = [
    { id: "openFolder", label: "打开所在目录" },
    { id: "copyPath", label: "复制路径" },
    { id: "deleteHistory", label: "删除历史记录", note: "仅历史模式显示" },
  ];
  const selectedActionIds = Array.isArray(draft.resultActionButtons) ? draft.resultActionButtons : [];

  // 勾选/取消按钮：限制最多三项，超限给出提示
  const toggleAction = (id: AppSettings["resultActionButtons"][number]) => {
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
          {membershipBadge}
        </div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.showResultPath}
            disabled={!isMember}
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
          <span>自定义类型</span>
          {membershipBadge}
        </div>
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
        {error ? <div className="settings-error">{error}</div> : null}
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
        <div className="settings-group-title">结果右侧按钮</div>
        <div className="settings-hint">
          最多显示 3 项，可调整顺序；后续新增按钮也在此处选择展示
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
                    disabled={disableAdd}
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
                    disabled={!checked || order <= 1}
                    onClick={() => moveAction(opt.id, "up")}
                    aria-label="上移"
                    title="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small-btn ghost"
                    disabled={!checked || order >= selectedActionIds.length}
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
    </div>
  );
}

