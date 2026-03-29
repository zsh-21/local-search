import { useLayoutEffect, useState, type RefObject } from "react";

/** 动态计算底部提示对容器的偏移补偿 */
export function useSearchFooterOffset(containerRef: RefObject<HTMLDivElement>) {
  const [footerOffsetPx, setFooterOffsetPx] = useState(0);

  useLayoutEffect(() => {
    let rafId = 0;
    const measureFooterOffset = () => {
      const container = containerRef.current;
      if (!container) return;
      const footerEl = container.querySelector(".list-bottom-info") as HTMLElement | null;
      if (!footerEl) return void setFooterOffsetPx((prev) => (prev === 0 ? prev : 0));
      const nextOffset = Math.max(0, Math.round(window.innerHeight - container.scrollHeight));
      setFooterOffsetPx((prev) => (prev === nextOffset ? prev : nextOffset));
    };
    const scheduleMeasure = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        measureFooterOffset();
      });
    };
    const container = containerRef.current;
    const resizeObserver = container && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => scheduleMeasure()) : null;
    if (resizeObserver && container) resizeObserver.observe(container);
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [containerRef]);

  return footerOffsetPx;
}
