import { useEffect, useRef } from "react";

export const ParticleBackground = ({ enabled, type }: { enabled: boolean; type: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const resizeHandlerRef = useRef<(() => void) | null>(null);
  const mouseMoveHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const shouldRun = enabled && (type === "particles" || type === "warp");
    if (!shouldRun) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (resizeHandlerRef.current) {
        window.removeEventListener("resize", resizeHandlerRef.current);
        resizeHandlerRef.current = null;
      }
      if (mouseMoveHandlerRef.current) {
        window.removeEventListener("mousemove", mouseMoveHandlerRef.current);
        mouseMoveHandlerRef.current = null;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let matrixFontSize = 14;
    let matrixColumns = 0;
    let matrixY: number[] = [];
    let matrixSpeed: number[] = [];

    let warpStars: Array<{
      x: number;
      y: number;
      z: number;
      speed: number;
      px: number;
      py: number;
    }> = [];

    const mouse = {
      x: 0,
      y: 0,
      active: false,
    };

    const getThemeColorRGB = () => {
      const style = getComputedStyle(document.documentElement);
      const hex = style.getPropertyValue("--fs-accent").trim();
      let r = 56, g = 189, b = 248; // 默认天际蓝
      if (hex.startsWith("#")) {
        const bigint = parseInt(hex.slice(1), 16);
        r = (bigint >> 16) & 255;
        g = (bigint >> 8) & 255;
        b = bigint & 255;
      }
      return { r, g, b };
    };

    const getThemeBgRGB = () => {
      const style = getComputedStyle(document.documentElement);
      const hex = style.getPropertyValue("--fs-bg").trim();
      let r = 15, g = 23, b = 42;
      if (hex.startsWith("#")) {
        const bigint = parseInt(hex.slice(1), 16);
        r = (bigint >> 16) & 255;
        g = (bigint >> 8) & 255;
        b = bigint & 255;
      }
      return { r, g, b };
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const initMatrix = () => {
      const w = Math.max(1, canvas.width);
      matrixFontSize = w < 520 ? 12 : 14;
      matrixColumns = Math.ceil(w / matrixFontSize);
      matrixY = Array.from({ length: matrixColumns }, () => Math.random() * canvas.height);
      matrixSpeed = Array.from({ length: matrixColumns }, () => 2.2 + Math.random() * 4.2);
    };

    const initWarp = () => {
      warpStars = [];
      const depth = Math.max(canvas.width, canvas.height);
      const count = 220;
      for (let i = 0; i < count; i++) {
        const z = Math.random() * depth + 1;
        warpStars.push({
          x: (Math.random() * 2 - 1) * canvas.width,
          y: (Math.random() * 2 - 1) * canvas.height,
          z,
          speed: 18 + Math.random() * 26,
          px: 0,
          py: 0,
        });
      }
    };

    const draw = () => {
      const bg = getThemeBgRGB();

      if (type === "warp") {
        const { r, g, b } = getThemeColorRGB();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const depth = Math.max(canvas.width, canvas.height);
        const scale = 720;

        for (const s of warpStars) {
          s.z -= s.speed;
          if (s.z <= 1) {
            s.x = (Math.random() * 2 - 1) * canvas.width;
            s.y = (Math.random() * 2 - 1) * canvas.height;
            s.z = depth;
            s.speed = 18 + Math.random() * 26;
            s.px = 0;
            s.py = 0;
          }

          const k = scale / s.z;
          const x = cx + s.x * k;
          const y = cy + s.y * k;

          if (x < -50 || x > canvas.width + 50 || y < -50 || y > canvas.height + 50) {
            s.x = (Math.random() * 2 - 1) * canvas.width;
            s.y = (Math.random() * 2 - 1) * canvas.height;
            s.z = depth;
            s.speed = 18 + Math.random() * 26;
            s.px = 0;
            s.py = 0;
            continue;
          }

          if (!s.px && !s.py) {
            s.px = x;
            s.py = y;
          }

          const t = 1 - s.z / depth;
          const alpha = Math.max(0, Math.min(0.95, t * 0.95));
          ctx.lineWidth = Math.max(0.6, t * 2.4);
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(s.px, s.py);
          ctx.lineTo(x, y);
          ctx.stroke();

          s.px = x;
          s.py = y;
        }

        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      ctx.fillStyle = `rgba(${bg.r}, ${bg.g}, ${bg.b}, 0.16)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const glyphs = "01{}[]()<>/\\\\|+-*=.:;,_$#@!~^";
      ctx.textBaseline = "top";
      ctx.font = `${matrixFontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
      ctx.globalCompositeOperation = "source-over";

      for (let i = 0; i < matrixColumns; i++) {
        const x = i * matrixFontSize;
        const y = matrixY[i] || 0;
        const near = mouse.active ? Math.max(0, 1 - Math.abs(x - mouse.x) / 240) : 0;
        const speed = (matrixSpeed[i] || 3) * (1 + near * 0.9);

        const head = glyphs[(Math.random() * glyphs.length) | 0] || "0";
        ctx.fillStyle = `rgba(240, 248, 255, ${0.35 + near * 0.25})`;
        ctx.fillText(head, x, y);

        ctx.shadowBlur = 0;
        ctx.shadowColor = "transparent";
        ctx.fillStyle = `rgba(240, 248, 255, ${0.08 + near * 0.10})`;
        for (let k = 1; k <= 4; k++) {
          const ch = glyphs[(Math.random() * glyphs.length) | 0] || "1";
          ctx.fillText(ch, x, y - k * matrixFontSize);
        }

        matrixY[i] = y + speed;
        if (matrixY[i] > canvas.height + 80 + Math.random() * 1200) {
          matrixY[i] = -Math.random() * canvas.height * 0.6;
          matrixSpeed[i] = 2.2 + Math.random() * 4.2;
        }
      }

      ctx.globalCompositeOperation = "source-over";
      rafRef.current = requestAnimationFrame(draw);
    };

    resize();
    if (type === "warp") initWarp();
    else initMatrix();
    draw();

    if (type === "particles") {
      const onMouseMove = (e: MouseEvent) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouse.active = true;
      };
      mouseMoveHandlerRef.current = onMouseMove;
      window.addEventListener("mousemove", onMouseMove);
    }

    const onResize = () => {
      resize();
      if (type === "warp") initWarp();
      else initMatrix();
    };
    resizeHandlerRef.current = onResize;
    window.addEventListener("resize", onResize);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      window.removeEventListener("resize", onResize);
      if (resizeHandlerRef.current === onResize) resizeHandlerRef.current = null;
      if (mouseMoveHandlerRef.current) {
        window.removeEventListener("mousemove", mouseMoveHandlerRef.current);
        mouseMoveHandlerRef.current = null;
      }
    };
  }, [enabled, type]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: -1,
        opacity: enabled && (type === "particles" || type === "warp") ? 0.6 : 0,
      }}
    />
  );
};
