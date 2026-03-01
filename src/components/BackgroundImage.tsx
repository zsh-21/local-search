import { useEffect, useMemo, useRef, useState } from "react";

export function BackgroundImage({ path, opacity }: { path: string; opacity: number }) {
  const normalizedPath = useMemo(() => (typeof path === "string" ? path.trim() : ""), [path]);
  const normalizedOpacity = useMemo(() => {
    if (typeof opacity !== "number" || !Number.isFinite(opacity)) return 0;
    return Math.min(1, Math.max(0, opacity));
  }, [opacity]);

  const [dataUrl, setDataUrl] = useState<string>("");
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

  if (!normalizedPath || normalizedOpacity <= 0 || !dataUrl) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: -2,
        opacity: normalizedOpacity,
        transition: "opacity 120ms ease",
        backgroundImage: `url("${dataUrl}")`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
        backgroundSize: "cover",
      }}
    />
  );
}
