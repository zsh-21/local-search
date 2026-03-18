import { useEffect, useMemo, useRef, useState } from "react";

export function BackgroundImage({ path, opacity }: { path: string; opacity: number }) {
  const normalizedPath = useMemo(() => (typeof path === "string" ? path.trim() : ""), [path]);
  const normalizedOpacity = useMemo(() => {
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) return 0;
    return Math.min(1, Math.max(0, opacity));
  }, [opacity]);

  const [dataUrl, setDataUrl] = useState<string>("");
  const [tone, setTone] = useState<"none" | "light" | "dark">("none");
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    if (!normalizedPath) {
      setDataUrl("");
      return;
    }

    window.ipcRenderer
      ?.invoke("get-image-data-url", normalizedPath)
      .then((resp: any) => {
        if (requestIdRef.current !== requestId) return;
        if (resp?.ok && typeof resp.dataUrl === "string" && resp.dataUrl) {
          setDataUrl(resp.dataUrl);
        }
      })
      .catch(() => {});
  }, [normalizedPath]);

  useEffect(() => {
    let cancelled = false;
    // 仅在背景图可见时采样亮度：用于动态调整文字与阴影对比度。
    if (!normalizedPath || normalizedOpacity <= 0 || !dataUrl) {
      setTone("none");
      return;
    }
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          setTone("none");
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let lumaTotal = 0;
        let pxCount = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const alpha = pixels[i + 3] / 255;
          if (alpha <= 0) continue;
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          // 感知亮度算法：更接近人眼对 RGB 权重的真实感受。
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          lumaTotal += luma;
          pxCount += 1;
        }
        if (pxCount === 0) {
          setTone("none");
          return;
        }
        const avgLuma = lumaTotal / pxCount;
        setTone(avgLuma >= 152 ? "light" : "dark");
      } catch {
        setTone("none");
      }
    };
    img.onerror = () => {
      if (!cancelled) setTone("none");
    };
    img.src = dataUrl;
    return () => {
      cancelled = true;
    };
  }, [dataUrl, normalizedOpacity, normalizedPath]);

  useEffect(() => {
    const root = document.documentElement;
    // 根据图片亮度同步根变量：主题变量仍是主来源，这里只做可读性增量修正。
    if (!normalizedPath || normalizedOpacity <= 0 || !dataUrl || tone === "none") {
      root.dataset.bgTone = "none";
      root.style.removeProperty("--fs-adaptive-text");
      root.style.removeProperty("--fs-adaptive-muted");
      root.style.removeProperty("--fs-adaptive-shadow");
      root.style.removeProperty("--fs-bg-overlay-alpha");
      return;
    }

    root.dataset.bgTone = tone;
    if (tone === "light") {
      root.style.setProperty("--fs-adaptive-text", "#0f172a");
      root.style.setProperty("--fs-adaptive-muted", "rgba(15, 23, 42, 0.74)");
      root.style.setProperty("--fs-adaptive-shadow", "0 1px 8px rgba(255, 255, 255, 0.45)");
      root.style.setProperty("--fs-bg-overlay-alpha", `${Math.min(0.48, 0.2 + normalizedOpacity * 0.24)}`);
      return;
    }

    root.style.setProperty("--fs-adaptive-text", "#f8fafc");
    root.style.setProperty("--fs-adaptive-muted", "rgba(241, 245, 249, 0.82)");
    root.style.setProperty("--fs-adaptive-shadow", "0 1px 10px rgba(2, 6, 23, 0.65)");
    root.style.setProperty("--fs-bg-overlay-alpha", `${Math.min(0.42, 0.14 + normalizedOpacity * 0.2)}`);
  }, [dataUrl, normalizedOpacity, normalizedPath, tone]);

  if (!normalizedPath || normalizedOpacity <= 0 || !dataUrl) return null;

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: -3,
          opacity: normalizedOpacity,
          transition: "opacity 120ms ease",
          backgroundImage: `url("${dataUrl}")`,
          backgroundRepeat: "no-repeat",
          // 背景图居中填充：窗口尺寸变化时保持视觉稳定，不出现偏移跳动。
          backgroundPosition: "center",
          backgroundSize: "cover",
        }}
      />
      <div
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: -2,
          transition: "background 120ms ease",
          // 亮图时增加暗遮罩，暗图时增加轻微提亮，保证文字在不同图片上都可读。
          background:
            tone === "light"
              ? "linear-gradient(rgba(2, 6, 23, var(--fs-bg-overlay-alpha, 0.28)), rgba(2, 6, 23, var(--fs-bg-overlay-alpha, 0.28)))"
              : "linear-gradient(rgba(255, 255, 255, calc(var(--fs-bg-overlay-alpha, 0.2) * 0.22)), rgba(255, 255, 255, calc(var(--fs-bg-overlay-alpha, 0.2) * 0.22)))",
        }}
      />
    </>
  );
}
