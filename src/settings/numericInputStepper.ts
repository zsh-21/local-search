import type { KeyboardEvent } from "react";

type NumericStepOptions = {
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  shiftMultiplier?: number;
  fallbackValue?: number;
  onValueChange: (nextValue: number) => void;
};

function clamp(value: number, min?: number, max?: number) {
  let next = value;
  if (Number.isFinite(min as number)) next = Math.max(min as number, next);
  if (Number.isFinite(max as number)) next = Math.min(max as number, next);
  return next;
}

function normalizePrecision(value: number, integer: boolean) {
  if (integer) return Math.round(value);
  // 小数步进统一保留 4 位，避免 0.1 连续累加出现浮点误差
  return Number(value.toFixed(4));
}

// 统一处理数字输入框的键盘步进：支持 ↑/→ 增，↓/← 减，Shift 加速
export function handleNumericStepperKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  options: NumericStepOptions
) {
  const key = event.key;
  const isIncreaseKey = key === "ArrowUp" || key === "ArrowRight";
  const isDecreaseKey = key === "ArrowDown" || key === "ArrowLeft";
  if (!isIncreaseKey && !isDecreaseKey) return false;

  event.preventDefault();

  const rawText = (event.currentTarget.value || "").trim();
  const rawValue = Number(rawText);
  const current = Number.isFinite(rawValue) ? rawValue : options.fallbackValue ?? 0;
  const baseStep = options.step ?? (options.integer ? 1 : 0.1);
  const multiplier = event.shiftKey ? options.shiftMultiplier ?? 10 : 1;
  const delta = baseStep * multiplier * (isIncreaseKey ? 1 : -1);

  const nextValue = normalizePrecision(
    clamp(current + delta, options.min, options.max),
    Boolean(options.integer)
  );

  options.onValueChange(nextValue);
  return true;
}
