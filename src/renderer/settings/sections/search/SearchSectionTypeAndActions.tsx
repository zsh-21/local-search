import type { ReactNode } from "react";
import { getSearchTypeOptions } from "../../../settingsStore";
import type { AppSettings } from "../../../appTypes";
import { SearchSectionResultActionsGroup } from "./SearchSectionResultActionsGroup";
import { SearchSectionTypeOrderGroup } from "./SearchSectionTypeOrderGroup";

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

/** 搜索类型与结果按钮配置分区 */
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
  const addCustomType = () => {
    const ext = newTypeExt.trim().toLowerCase();
    if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) return void setError("后缀格式不合法（例如 .docx）");
    if (draft.customSearchTypes.includes(ext)) return void setError("该类型已存在");
    const nextCustom = [...draft.customSearchTypes, ext];
    const nextOrder = getSearchTypeOptions(nextCustom, [...(draft.searchTypeOrder || []), `ext:${ext}`]).map((x) => x.id);
    setDraft({ ...draft, customSearchTypes: nextCustom, searchTypeOrder: nextOrder });
    setNewTypeExt("");
    setError("");
  };

  return (
    <>
      <div className="settings-group">
        <div className="settings-group-title"><span>自定义类型</span>{membershipBadge}</div>
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
                addCustomType();
              }}
            />
            <button type="button" className="small-btn" disabled={!isMember} onClick={addCustomType}>添加</button>
          </div>
        </div>
      </div>

      <SearchSectionTypeOrderGroup
        draft={draft}
        setDraft={setDraft}
        setError={setError}
        isMember={isMember}
        membershipBadge={membershipBadge}
        typeOptions={typeOptions}
        isTypeDisabled={isTypeDisabled}
        toggleTypeEnabled={toggleTypeEnabled}
        moveTypeId={moveTypeId}
      />

      <SearchSectionResultActionsGroup
        isMember={isMember}
        membershipBadge={membershipBadge}
        resultActionOptions={resultActionOptions}
        selectedActionIds={selectedActionIds}
        toggleAction={toggleAction}
        moveAction={moveAction}
      />
    </>
  );
}
