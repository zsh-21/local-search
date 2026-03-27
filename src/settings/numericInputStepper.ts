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

// 统一数值夹取：保证数值落在范围内
function clamp(value: number, min?: number, max?: number) {
  let next = value;
  if (Number.isFinite(min as number)) next = Math.max(min as number, next);
  if (Number.isFinite(max as number)) next = Math.min(max as number, next);
  return next;
}

// 获取数字的小数精度：用于步进对齐
function getNumberPrecision(value: number) {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) {
    const [base, expPart] = text.split("e-");
    const exp = Number(expPart);
    const decimalDigits = (base.split(".")[1] || "").length;
    return Number.isFinite(exp) ? exp + decimalDigits : decimalDigits;
  }
  const dotIndex = text.indexOf(".");
  if (dotIndex < 0) return 0;
  return text.length - dotIndex - 1;
}

// 按指定精度四舍五入：避免浮点累加误差
function roundToPrecision(value: number, precision: number) {
  if (!Number.isFinite(value)) return 0;
  if (precision <= 0) return Math.round(value);
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

// 统一步进后的数值精度：整数强制取整，小数保留指定精度
function normalizePrecision(value: number, integer: boolean, precision = 4) {
  if (integer) return Math.round(value);
  const safePrecision = Math.max(0, Math.min(10, precision));
  return roundToPrecision(value, safePrecision);
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

  const rawBaseStep = options.step ?? (options.integer ? 1 : 0.1);
  const baseStep =
    Number.isFinite(rawBaseStep) && rawBaseStep > 0 ? rawBaseStep : options.integer ? 1 : 0.1;
  const multiplier = event.shiftKey ? options.shiftMultiplier ?? 10 : 1;
  const direction = isIncreaseKey ? 1 : -1;

  const origin = 0;
  const stepPrecision = Math.max(
    getNumberPrecision(baseStep),
    getNumberPrecision(Number.isFinite(options.min as number) ? Number(options.min) : 0)
  );
  const currentUnit = Math.round((current - origin) / baseStep);
  const alignedCurrent = origin + currentUnit * baseStep;
  const nextRaw = alignedCurrent + direction * baseStep * multiplier;

  const nextValue = normalizePrecision(
    clamp(nextRaw, options.min, options.max),
    Boolean(options.integer),
    stepPrecision
  );

  options.onValueChange(nextValue);
  return true;
}
