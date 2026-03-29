import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getCalcHistoryPath } from "../constants/storagePaths";

export type CalcHistoryItem = {
  expression: string;
  result: string;
  lastUsed: number;
};
type CalcHistoryRawItem = {
  expression?: unknown;
  result?: unknown;
  lastUsed?: unknown;
};

const CALC_HISTORY_PATH = getCalcHistoryPath();
const CALC_HISTORY_LIMIT = 50;

function normalizeExpression(raw: string) {
  return typeof raw === "string" ? raw.trim() : "";
}

export function loadCalcHistory(): CalcHistoryItem[] {
  try {
    if (!existsSync(CALC_HISTORY_PATH)) return [];
    const raw = JSON.parse(readFileSync(CALC_HISTORY_PATH, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    // 统一清洗表达式与结果，避免脏数据影响渲染层。
    const items = raw
      .map((it) => {
        const record = it && typeof it === "object" ? (it as CalcHistoryRawItem) : {};
        return {
          expression: normalizeExpression(record.expression ? String(record.expression) : ""),
          result: String(record.result || "").trim(),
          lastUsed: typeof record.lastUsed === "number" ? record.lastUsed : 0,
        };
      })
      .filter((it) => it.expression.length > 0 && it.result.length > 0);
    items.sort((a, b) => b.lastUsed - a.lastUsed);
    return items.slice(0, CALC_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveCalcHistory(items: CalcHistoryItem[]) {
  try {
    writeFileSync(CALC_HISTORY_PATH, JSON.stringify(items));
  } catch {}
}

export function recordCalcHistoryItem(input: { expression: string; result: string }) {
  const expression = normalizeExpression(input.expression);
  const result = String(input.result || "").trim();
  if (!expression || !result) return;

  const now = Date.now();
  const current = loadCalcHistory();
  // 相同表达式保留最新一条，避免历史里出现重复堆叠。
  const next: CalcHistoryItem[] = [
    { expression, result, lastUsed: now },
    ...current.filter((it) => normalizeExpression(it.expression) !== expression),
  ].slice(0, CALC_HISTORY_LIMIT);
  saveCalcHistory(next);
}

export function deleteCalcHistoryItem(expressionRaw: string) {
  const expression = normalizeExpression(expressionRaw);
  if (!expression) return false;
  const current = loadCalcHistory();
  const next = current.filter((it) => normalizeExpression(it.expression) !== expression);
  saveCalcHistory(next);
  return true;
}
