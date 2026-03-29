import type { ReactNode } from "react";
import type { AppSettings } from "../../../appTypes";

/** 结果右侧按钮配置分组 */
export function SearchSectionResultActionsGroup(props: {
  isMember: boolean;
  membershipBadge: ReactNode;
  resultActionOptions: { id: AppSettings["resultActionButtons"][number]; label: string; note?: string }[];
  selectedActionIds: AppSettings["resultActionButtons"];
  toggleAction: (id: AppSettings["resultActionButtons"][number]) => void;
  moveAction: (id: AppSettings["resultActionButtons"][number], dir: "up" | "down") => void;
}) {
  const { isMember, membershipBadge, resultActionOptions, selectedActionIds, toggleAction, moveAction } = props;
  return (
    <div className="settings-group">
      <div className="settings-group-title"><span>结果右侧按钮</span>{membershipBadge}</div>
      <div className="settings-hint">{!isMember ? "订阅后可自定义；非会员使用默认按钮。" : "最多显示 3 项，可调整顺序。"}</div>
      <div className="action-config-list">
        {resultActionOptions.map((opt) => {
          const checked = selectedActionIds.includes(opt.id);
          const order = checked ? selectedActionIds.indexOf(opt.id) + 1 : 0;
          const disableAdd = !checked && selectedActionIds.length >= 3;
          return (
            <div key={opt.id} className={`action-config-row ${checked ? "checked" : ""} ${disableAdd ? "disabled" : ""}`}>
              <label className="action-config-left">
                <input type="checkbox" checked={checked} disabled={disableAdd || !isMember} onChange={() => toggleAction(opt.id)} />
                <span className="action-config-label">{opt.label}{opt.note ? <span className="action-config-note">{opt.note}</span> : null}</span>
              </label>
              <div className="action-config-right">
                {checked ? <span className="action-config-order">{order}</span> : null}
                <button type="button" className="small-btn ghost" disabled={!isMember || !checked || order <= 1} onClick={() => moveAction(opt.id, "up")} aria-label="上移" title="上移">↑</button>
                <button type="button" className="small-btn ghost" disabled={!isMember || !checked || order >= selectedActionIds.length} onClick={() => moveAction(opt.id, "down")} aria-label="下移" title="下移">↓</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
