import { useEffect, useRef } from "react";

// 搜索窗口宽度拖拽：封装左右拖拽把手逻辑，避免主逻辑文件过大
export function useWindowResizeHandles(opts?: {
  onResizeStateChange?: (isResizing: boolean) => void;
  onPreviewWidthChange?: (width: number | null) => void;
}) {
  const onResizeStateChange = opts?.onResizeStateChange;
  const onPreviewWidthChange = opts?.onPreviewWidthChange;
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const startXPosRef = useRef(0);
  const resizeDirRef = useRef<"left" | "right" | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const pendingBoundsRef = useRef<{ width: number; x: number } | null>(null);
  const lastSentRef = useRef<{ width: number; x: number } | null>(null);
  const lastPreviewWidthRef = useRef<number | null>(null);

  // 预览宽度变更去重：避免高频 mousemove 造成 React 重复渲染。
  const emitPreviewWidth = (width: number | null) => {
    if (lastPreviewWidthRef.current === width) return;
    lastPreviewWidthRef.current = width;
    onPreviewWidthChange?.(width);
  };

  const startResizing = async (e: React.MouseEvent, dir: "left" | "right") => {
    // 开始拖拽：读取窗口当前 bounds 作为基准，后续根据鼠标移动计算宽度与位置
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
    // 拖拽开始先同步内部预览宽度：让 HTML 先变化，外窗随后跟上。
    emitPreviewWidth(Math.round(bounds.width));
    // 主动通知“正在手动拖拽宽度”：用于上层暂停自动高度回流，避免宽高 IPC 互相抢写。
    onResizeStateChange?.(true);
  };

  useEffect(() => {
    const flush = () => {
      // 拖拽过程中 mousemove 频率很高：这里用 rAF + “单次在途”把 IPC 频率压到可控范围，避免拖拽卡顿
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (inFlightRef.current) return;
      const next = pendingBoundsRef.current;
      if (!next) return;

      const last = lastSentRef.current;
      if (last && last.width === next.width && last.x === next.x) {
        pendingBoundsRef.current = null;
        return;
      }

      inFlightRef.current = true;
      pendingBoundsRef.current = null;
      lastSentRef.current = next;
      void window.ipcRenderer
        ?.invoke("set-window-bounds", next)
        .catch(() => {})
        .finally(() => {
          inFlightRef.current = false;
          if (pendingBoundsRef.current) {
            rafIdRef.current = requestAnimationFrame(flush);
          }
        });
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      // 计算变化量：右侧拖拽只改变宽度，左侧拖拽同时改变宽度与 x 坐标
      const deltaX = e.screenX - startXRef.current;
      let newWidth = startWidthRef.current;
      let newX = startXPosRef.current;

      if (resizeDirRef.current === "right") {
        newWidth = startWidthRef.current + deltaX;
      } else if (resizeDirRef.current === "left") {
        newWidth = startWidthRef.current - deltaX;
        newX = startXPosRef.current + deltaX;
      }

      // 宽度限制：避免窗口过窄/过宽影响列表可读性与布局稳定性
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

      // 每次鼠标移动先更新内部预览宽度，减少外窗扩展时的右侧空白感。
      emitPreviewWidth(Math.round(newWidth));
      pendingBoundsRef.current = { width: Math.round(newWidth), x: Math.round(newX) };
      if (rafIdRef.current == null) rafIdRef.current = requestAnimationFrame(flush);
    };

    const handleMouseUp = () => {
      // 结束拖拽：还原 cursor，并清理拖拽方向
      if (isResizingRef.current) {
        isResizingRef.current = false;
        resizeDirRef.current = null;
        document.body.style.cursor = "";
      }
      // 鼠标抬起时强制提交最后一帧，避免“视觉宽度”与“窗口真实宽度”偶发不同步。
      const finalBounds = pendingBoundsRef.current;
      pendingBoundsRef.current = null;
      if (finalBounds) {
        lastSentRef.current = finalBounds;
        void window.ipcRenderer?.invoke("set-window-bounds", finalBounds).catch(() => {});
      }
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      // 拖拽结束后清空预览宽度，恢复默认自适应布局。
      emitPreviewWidth(null);
      onResizeStateChange?.(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      emitPreviewWidth(null);
      onResizeStateChange?.(false);
    };
  }, [onResizeStateChange, onPreviewWidthChange]);

  return { startResizing };
}
