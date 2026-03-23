import { ReactNode } from "react";
import { AppSettings } from "../../../appTypes";
import { TypeOrderItem } from "../../../TypeOrderItem";
import { getSearchTypeOptions } from "../../../settingsStore";

type SearchSectionTypeAndActionsProps = {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  newTypeExt: string;
  setNewTypeExt: (v: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  typeOptions: { id: string; label: string }[];
  isTypeDisabled: (id: string) => boolean;
  toggleTypeEnabled: (id: string) => void;
  moveTypeId: (list: string[], fromId: string, toId: string, position: "before" | "after") => string[];
  resultActionOptions: { id: AppSettings["resultActionButtons"][number]; label: string; note?: string }[];
  selectedActionIds: AppSettings["resultActionButtons"];
  toggleAction: (id: AppSettings["resultActionButtons"][number]) => void;
  moveAction: (id: AppSettings["resultActionButtons"][number], dir: "up" | "down") => void;
};

export function SearchSectionTypeAndActions({
  draft,
  setDraft,
  setError,
  newTypeExt,
  setNewTypeExt,
  isMember,
  membershipBadge,
  typeOptions,
  isTypeDisabled,
  toggleTypeEnabled,
  moveTypeId,
  resultActionOptions,
  selectedActionIds,
  toggleAction,
  moveAction,
}: SearchSectionTypeAndActionsProps) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-group-title">
          <span>自定义类型</span>
          {membershipBadge}
        </div>
        <div className="settings-hint">按文件后缀新增搜索类型（订阅可配置）。</div>
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
                const nextOrder = getSearchTypeOptions(nextCustom, [...(draft.searchTypeOrder || []), `ext:${ext}`]).map((x) => x.id);
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
                const nextOrder = getSearchTypeOptions(nextCustom, [...(draft.searchTypeOrder || []), `ext:${ext}`]).map((x) => x.id);
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
        <div className="settings-hint">可拖拽排序并启停单个类型（订阅可配置）。</div>
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
                  const nextOrder = moveTypeId(typeOptions.map((x) => x.id), fromId, toId, position);
                  setDraft({ ...draft, searchTypeOrder: nextOrder });
                  setError("");
                }}
                onDelete={(targetId) => {
                  if (!isMember) return;
                  if (!targetId.startsWith("ext:")) return;
                  const ext = targetId.slice(4);
                  const nextCustom = (draft.customSearchTypes || []).filter((x) => x !== ext);
                  const nextDefault = draft.defaultSearchTypeId === targetId ? "all" : draft.defaultSearchTypeId;
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
          {!isMember ? "订阅后可自定义；非会员使用默认按钮。" : "最多显示 3 项，可调整顺序。"}
        </div>
        <div className="action-config-list">
          {resultActionOptions.map((opt) => {
            const checked = selectedActionIds.includes(opt.id);
            const order = checked ? selectedActionIds.indexOf(opt.id) + 1 : 0;
            const disableAdd = !checked && selectedActionIds.length >= 3;
            return (
              <div key={opt.id} className={`action-config-row ${checked ? "checked" : ""} ${disableAdd ? "disabled" : ""}`}>
                <label className="action-config-left">
                  <input type="checkbox" checked={checked} disabled={disableAdd || !isMember} onChange={() => toggleAction(opt.id)} />
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
    </>
  );
}
