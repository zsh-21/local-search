import { useState } from "react";

// 类型顺序拖拽条目：负责单行拖拽排序与删除交互（可按会员状态禁用）
export function TypeOrderItem({
  id,
  label,
  isCustom,
  orderedIds,
  disabled,
  onMove,
  onDelete,
}: {
  id: string;
  label: string;
  isCustom: boolean;
  orderedIds: string[];
  disabled?: boolean;
  onMove: (fromId: string, toId: string, position: "before" | "after") => void;
  onDelete: (id: string) => void;
}) {
  const [dragOverPos, setDragOverPos] = useState<"top" | "bottom" | null>(null);

  return (
    <div
      className={`type-order-item ${disabled ? "disabled" : ""} ${dragOverPos ? `drag-over-${dragOverPos}` : ""}`}
      draggable={!disabled}
      onDragStart={(e) => {
        if (disabled) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", id);
        const target = e.currentTarget as HTMLElement;
        target.classList.add("dragging-source");
        setTimeout(() => target.classList.remove("dragging-source"), 0);
      }}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        setDragOverPos(e.clientY < midY ? "top" : "bottom");
      }}
      onDragLeave={() => {
        if (disabled) return;
        setDragOverPos(null);
      }}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOverPos(null);
        const fromId = e.dataTransfer.getData("text/plain");
        if (!fromId || fromId === id) return;
        if (!orderedIds.includes(fromId) || !orderedIds.includes(id)) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const isTop = e.clientY < midY;
        onMove(fromId, id, isTop ? "before" : "after");
      }}
    >
      <span className="type-order-handle" aria-hidden="true" />
      <span className="type-order-label">{label}</span>
      <span className="type-order-spacer" />
      {isCustom ? (
        <button
          type="button"
          className="type-order-del"
          aria-label="删除"
          title="删除"
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (disabled) return;
            onDelete(id);
          }}
        >
          ×
        </button>
      ) : (
        <span className="type-order-fixed">内置</span>
      )}
    </div>
  );
}
