import { useEffect, useRef } from "react";

// 搜索窗口宽度拖拽：封装左右拖拽把手逻辑，避免主逻辑文件过大
export function useWindowResizeHandles() {
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const startXPosRef = useRef(0);
  const resizeDirRef = useRef<"left" | "right" | null>(null);

  const startResizing = async (e: React.MouseEvent, dir: "left" | "right") => {
    e.preventDefault();
    e.stopPropagation();

    const bounds = await window.ipcRenderer?.invoke("get-window-bounds");
    if (!bounds) return;

    isResizingRef.current = true;
    startXRef.current = e.screenX;
    startWidthRef.current = bounds.width;
    startXPosRef.current = bounds.x;
    resizeDirRef.current = dir;
    document.body.style.cursor = "ew-resize";
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      const deltaX = e.screenX - startXRef.current;
      let newWidth = startWidthRef.current;
      let newX = startXPosRef.current;

      if (resizeDirRef.current === "right") {
        newWidth = startWidthRef.current + deltaX;
      } else if (resizeDirRef.current === "left") {
        newWidth = startWidthRef.current - deltaX;
        newX = startXPosRef.current + deltaX;
      }

      if (newWidth < 450) {
        if (resizeDirRef.current === "left") {
          newX = startXPosRef.current + (startWidthRef.current - 450);
        }
        newWidth = 450;
      } else if (newWidth > 1000) {
        if (resizeDirRef.current === "left") {
          newX = startXPosRef.current - (1000 - startWidthRef.current);
        }
        newWidth = 1000;
      }

      window.ipcRenderer?.invoke("set-window-bounds", {
        width: Math.round(newWidth),
        x: Math.round(newX),
      });
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        resizeDirRef.current = null;
        document.body.style.cursor = "";
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return { startResizing };
}
