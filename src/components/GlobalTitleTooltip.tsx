import { useEffect, useLayoutEffect, useRef, useState } from "react";

type TooltipState = {
  name: string;
  address: string;
  left: number;
  top: number;
};

const ORIGINAL_TITLE_ATTR = "data-fs-original-title";
const TITLE_DELAY_ATTR = "data-title-delay";
const TITLE_NO_SCROLL_ATTR = "data-title-no-scroll";
const SCROLL_SUPPRESS_MS = 420;

function pickTitleTarget(from: EventTarget | null) {
  if (!(from instanceof Element)) return null;
  const el = from.closest("[title], [data-fs-original-title]") as HTMLElement | null;
  if (!el) return null;
  const title = (el.getAttribute("title") || el.getAttribute(ORIGINAL_TITLE_ATTR) || "").trim();
  if (!title) return null;
  return el;
}

export function GlobalTitleTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const tooltipStateRef = useRef<TooltipState | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const scrollSuppressUntilRef = useRef(0);
  const mouseRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const tipSizeRef = useRef({ w: 0, h: 0 });

  const clearShowTimer = () => {
    if (showTimerRef.current != null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };

  const clearRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const restoreTitle = (el: HTMLElement | null) => {
    if (!el) return;
    const original = el.getAttribute(ORIGINAL_TITLE_ATTR);
    if (original == null) return;
    el.setAttribute("title", original);
    el.removeAttribute(ORIGINAL_TITLE_ATTR);
  };

  const calcPosition = (x: number, y: number) => {
    const offset = 12;
    const padding = 8;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const w = tipSizeRef.current.w || 120;
    const h = tipSizeRef.current.h || 30;

    let left = x + offset;
    let top = y + offset;

    if (left + w + padding > vw) left = x - offset - w;
    if (left < padding) left = padding;

    if (top + h + padding > vh) top = y - offset - h;
    if (top < padding) top = padding;

    return { left, top };
  };

  const updateTooltipPosition = () => {
    if (!tooltipStateRef.current) return;
    if (!activeRef.current) return;
    clearRaf();
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const { x, y } = mouseRef.current;
      const next = calcPosition(x, y);
      setTooltip((prev) => (prev ? { ...prev, ...next } : prev));
    });
  };

  const hideTooltip = () => {
    clearShowTimer();
    clearRaf();
    if (activeRef.current) {
      restoreTitle(activeRef.current);
    }
    activeRef.current = null;
    setTooltip(null);
  };

  const scheduleTooltipFor = (el: HTMLElement, immediate = false) => {
    if (activeRef.current && activeRef.current !== el) {
      restoreTitle(activeRef.current);
      activeRef.current = null;
      setTooltip(null);
    }
    clearShowTimer();

    const rawTitle = (el.getAttribute("title") || el.getAttribute(ORIGINAL_TITLE_ATTR) || "").trim();
    if (!rawTitle) return;

    if (!el.hasAttribute(ORIGINAL_TITLE_ATTR)) {
      el.setAttribute(ORIGINAL_TITLE_ATTR, rawTitle);
      el.removeAttribute("title");
    }
    activeRef.current = el;

    const delayRaw = Number.parseInt(el.getAttribute(TITLE_DELAY_ATTR) || "500", 10);
    const delay = immediate ? 0 : Number.isFinite(delayRaw) && delayRaw > 0 ? delayRaw : 0;
    const hideWhileScroll = el.getAttribute(TITLE_NO_SCROLL_ATTR) === "true";

    const show = () => {
      if (activeRef.current !== el) return;
      if (hideWhileScroll && Date.now() < scrollSuppressUntilRef.current) return;

      const name = (el.getAttribute(ORIGINAL_TITLE_ATTR) || "").trim();
      if (!name) return;
      const rawAddress = (el.getAttribute("data-title-address") || "").trim();
      const { x, y } = mouseRef.current;
      const pos = calcPosition(x, y);

      setTooltip({
        name,
        address: rawAddress,
        left: pos.left,
        top: pos.top,
      });
    };

    if (delay > 0) {
      showTimerRef.current = window.setTimeout(show, delay);
      return;
    }

    show();
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      if (tooltipStateRef.current) updateTooltipPosition();
    };

    const onMouseOver = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      const target = pickTitleTarget(e.target);
      if (!target) return;
      scheduleTooltipFor(target);
    };

    const onMouseOut = (e: MouseEvent) => {
      const active = activeRef.current;
      if (!active) return;
      const related = e.relatedTarget as Node | null;
      if (related && active.contains(related)) return;
      hideTooltip();
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = pickTitleTarget(e.target);
      if (!target) return;
      scheduleTooltipFor(target, true);
    };

    const onFocusOut = (e: FocusEvent) => {
      const active = activeRef.current;
      if (!active) return;
      const related = e.relatedTarget as Node | null;
      if (related && active.contains(related)) return;
      hideTooltip();
    };

    const suppressOnScroll = () => {
      scrollSuppressUntilRef.current = Date.now() + SCROLL_SUPPRESS_MS;
      hideTooltip();
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseover", onMouseOver, true);
    document.addEventListener("mouseout", onMouseOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("wheel", suppressOnScroll, true);
    window.addEventListener("scroll", suppressOnScroll, true);
    window.addEventListener("resize", hideTooltip);

    return () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseover", onMouseOver, true);
      document.removeEventListener("mouseout", onMouseOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("wheel", suppressOnScroll, true);
      window.removeEventListener("scroll", suppressOnScroll, true);
      window.removeEventListener("resize", hideTooltip);
      hideTooltip();
    };
  }, []);

  useLayoutEffect(() => {
    tooltipStateRef.current = tooltip;
    if (!tooltip) return;
    const el = tooltipRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    tipSizeRef.current = { w: rect.width || 0, h: rect.height || 0 };
    updateTooltipPosition();
  }, [tooltip?.name, tooltip?.address]);

  if (!tooltip) return null;

  return (
    <div
      ref={tooltipRef}
      className="fs-title-tooltip"
      data-has-address={tooltip.address ? "true" : "false"}
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      <div className="fs-title-tooltip-name">{tooltip.name}</div>
      {tooltip.address ? <div className="fs-title-tooltip-address">{tooltip.address}</div> : null}
    </div>
  );
}
