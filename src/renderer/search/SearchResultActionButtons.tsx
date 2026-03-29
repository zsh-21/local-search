import type { MouseEvent } from "react";
import type { AppItem, ResultActionButtonId } from "../appTypes";
import {
  IconCopyPath,
  IconDeleteHistory,
  IconOpenFolder,
  IconRunAsAdmin,
} from "../components/icons/SettingsIcons";

/** 统一构建操作按钮样式 */
function buildButtonClassName(isSelected: boolean, isDelete = false) {
  if (!isDelete) return isSelected ? "action-btn kbd-selected" : "action-btn";
  return isSelected ? "action-btn delete-btn kbd-selected" : "action-btn delete-btn";
}

/** 操作按钮组：负责右侧按钮行为转发 */
export function SearchResultActionButtons(props: {
  item: AppItem;
  actionIds: ResultActionButtonId[];
  selectedActionId: string;
  isSelectedRow: boolean;
  onOpenFolder: (item: AppItem) => void;
  onCopyPath: (item: AppItem) => void;
  onRunAsAdmin: (item: AppItem) => void;
  onDeleteHistory: (item: AppItem) => Promise<void>;
}) {
  const { item, actionIds, selectedActionId, isSelectedRow } = props;
  const stopAndPrevent = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="action-group">
      {actionIds.map((actionId) => {
        const selectedBtn = isSelectedRow && selectedActionId === actionId;
        if (actionId === "openFolder") {
          return (
            <button
              key={actionId}
              className={buildButtonClassName(selectedBtn)}
              data-action-id={actionId}
              onMouseDown={(event) => {
                stopAndPrevent(event);
                props.onOpenFolder(item);
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (event.detail === 0) props.onOpenFolder(item);
              }}
              title="打开所在目录"
              aria-label="打开所在目录"
            >
              <IconOpenFolder size={18} />
            </button>
          );
        }
        if (actionId === "copyPath") {
          return (
            <button
              key={actionId}
              className={buildButtonClassName(selectedBtn)}
              data-action-id={actionId}
              onMouseDown={(event) => {
                stopAndPrevent(event);
                props.onCopyPath(item);
              }}
              onClick={(event) => event.stopPropagation()}
              title="复制路径"
              aria-label="复制路径"
            >
              <IconCopyPath size={18} />
            </button>
          );
        }
        if (actionId === "runAsAdmin") {
          return (
            <button
              key={actionId}
              className={buildButtonClassName(selectedBtn)}
              data-action-id={actionId}
              onMouseDown={(event) => {
                stopAndPrevent(event);
                props.onRunAsAdmin(item);
              }}
              onClick={(event) => event.stopPropagation()}
              title="以管理员身份运行"
              aria-label="以管理员身份运行"
            >
              <IconRunAsAdmin size={18} />
            </button>
          );
        }
        return (
          <button
            key={actionId}
            className={buildButtonClassName(selectedBtn, true)}
            data-action-id={actionId}
            onMouseDown={(event) => {
              stopAndPrevent(event);
              void props.onDeleteHistory(item);
            }}
            onClick={(event) => event.stopPropagation()}
            title="删除该历史"
            aria-label="删除该历史"
          >
            <IconDeleteHistory size={18} />
          </button>
        );
      })}
    </div>
  );
}
