import { useEffect, useRef, useState } from "react";

type ScannerProps = { className?: string };

const scanner = {
  speed: 0.34,
  sweepSpeed: 0.18,
  sweepWidth: 1.25,
  sweepFalloff: 7.5,
  scale: 1.35,
  frequency: 1.65,
  ripple: 0.12,
  bandDensity: 8,
  lineSharpness: 4.5,
  glow: 0.14,
  scanDirection: "vertical",
  colorSpread: 0.55,
  brightness: 1.08,
  contrast: 1.05,
  softness: 1.75,
  vignette: 0.28,
  scanline: true,
  grain: true,
  grainIntensity: 0.025,
  opacity: 0.74,
  mouseInteraction: true,
  mouseRadius: 0.46,
  mouseStrength: 0.25,
} as const;

function paint(canvas: HTMLCanvasElement, time: number, pointer: { x: number; y: number } | null) {
  const context = canvas.getContext("2d");
  if (!context) return false;
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(1, Math.floor(bounds.width * dpr));
  const height = Math.max(1, Math.floor(bounds.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tokens = getComputedStyle(document.documentElement);
  const elapsed = time / 1000;
  const sweep = ((elapsed * scanner.sweepSpeed) % 1) * bounds.height;
  const background = context.createLinearGradient(0, 0, 0, bounds.height);
  background.addColorStop(0, tokens.getPropertyValue("--rp-bg-surface"));
  background.addColorStop(1, tokens.getPropertyValue("--rp-bg-field"));
  context.fillStyle = background;
  context.fillRect(0, 0, bounds.width, bounds.height);

  for (let y = 0; y < bounds.height; y += 2) {
    const normalized = y / bounds.height;
    const wave = Math.sin(normalized * Math.PI * scanner.bandDensity * scanner.frequency + elapsed * scanner.speed * 5);
    const sweepDistance = Math.abs(y - sweep) / Math.max(1, bounds.height * 0.18);
    const sweepLight = Math.exp(-sweepDistance * scanner.sweepFalloff);
    const pointerDistance = pointer
      ? Math.hypot((bounds.width * pointer.x - bounds.width / 2) / bounds.width, (y - bounds.height * pointer.y) / bounds.height)
      : 1;
    const pointerLight = pointer ? Math.max(0, 1 - pointerDistance / scanner.mouseRadius) * scanner.mouseStrength : 0;
    const alpha = Math.max(0, wave * 0.15 + sweepLight * 0.3 + pointerLight) * scanner.opacity;
    context.globalAlpha = alpha;
    context.strokeStyle = y % 8 === 0 ? tokens.getPropertyValue("--rp-color-scanner-2") : tokens.getPropertyValue("--rp-color-scanner-1");
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(bounds.width, y + Math.sin(elapsed + normalized * 12) * scanner.ripple * 10);
    context.stroke();
  }
  const sheen = context.createRadialGradient(bounds.width * 0.78, bounds.height * 0.2, 0, bounds.width * 0.78, bounds.height * 0.2, bounds.width * 0.7);
  sheen.addColorStop(0, tokens.getPropertyValue("--rp-color-scanner-3"));
  sheen.addColorStop(1, tokens.getPropertyValue("--rp-color-transparent"));
  context.globalAlpha = scanner.glow;
  context.fillStyle = sheen;
  context.fillRect(0, 0, bounds.width, bounds.height);
  context.globalAlpha = 1;
  return true;
}

/** React Bits Scanner-inspired local integration using the frozen Paper Signal props. */
export function Scanner({ className = "" }: ScannerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number>(0);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.getContext) {
      setAvailable(false);
      return;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarsePointer = window.matchMedia("(pointer: coarse)");
    const draw = (time: number) => {
      if (document.hidden) return;
      const isAvailable = paint(canvas, time, coarsePointer.matches ? null : pointerRef.current);
      setAvailable(isAvailable);
      if (!reduceMotion.matches && isAvailable) frameRef.current = requestAnimationFrame(draw);
    };
    const restart = () => {
      cancelAnimationFrame(frameRef.current);
      draw(performance.now());
    };
    const visibility = () => {
      if (!document.hidden) restart();
    };
    const resizeObserver = new ResizeObserver(restart);
    resizeObserver.observe(canvas);
    reduceMotion.addEventListener("change", restart);
    document.addEventListener("visibilitychange", visibility);
    restart();
    return () => {
      cancelAnimationFrame(frameRef.current);
      resizeObserver.disconnect();
      reduceMotion.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return (
    <div
      className={`scanner ${available ? "" : "scanner--fallback"} ${className}`}
      aria-hidden="true"
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        pointerRef.current = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
      }}
      onPointerLeave={() => {
        pointerRef.current = null;
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
