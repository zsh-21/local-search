import type { ReactNode } from "react";
import { TypeOrderItem } from "../../../TypeOrderItem";
import { getSearchTypeOptions } from "../../../settingsStore";
import type { AppSettings } from "../../../appTypes";

/** 类型顺序配置分组 */
export function SearchSectionTypeOrderGroup(props: {
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  typeOptions: { id: string; label: string }[];
  isTypeDisabled: (id: string) => boolean;
  toggleTypeEnabled: (id: string) => void;
  moveTypeId: (list: string[], fromId: string, toId: string, position: "before" | "after") => string[];
}) {
  const { draft, setDraft, setError, isMember, membershipBadge, typeOptions, isTypeDisabled, toggleTypeEnabled, moveTypeId } = props;
  return (
    <div className="settings-group">
      <div className="settings-group-title"><span>类型顺序</span>{membershipBadge}</div>
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
                if (!isMember || !targetId.startsWith("ext:")) return;
                const ext = targetId.slice(4);
                const nextCustom = (draft.customSearchTypes || []).filter((x) => x !== ext);
                const nextDefault = draft.defaultSearchTypeId === targetId ? "all" : draft.defaultSearchTypeId;
                const nextOrder = getSearchTypeOptions(nextCustom, (draft.searchTypeOrder || []).filter((x) => x !== targetId)).map((x) => x.id);
                setDraft({ ...draft, customSearchTypes: nextCustom, defaultSearchTypeId: nextDefault, searchTypeOrder: nextOrder });
                setError("");
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
