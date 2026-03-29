import { AppItem } from "../appTypes";

type CalcHistoryRecord = { expression: string; result: string; lastUsed: number };
type CalcHistoryRawRecord = { expression?: unknown; result?: unknown; lastUsed?: unknown };

const CALC_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

function ensureArity(name: string, args: number[], min: number, max = min) {
  if (args.length < min || args.length > max) {
    throw new Error(`Function ${name} expects ${min}${min === max ? "" : `-${max}`} arguments`);
  }
}

function ensureMinArity(name: string, args: number[], min: number) {
  if (args.length < min) throw new Error(`Function ${name} expects at least ${min} arguments`);
}

function callCalcFunction(name: string, args: number[]) {
  const key = name.toLowerCase();
  switch (key) {
    case "sin":
      ensureArity(key, args, 1);
      return Math.sin(args[0]);
    case "cos":
      ensureArity(key, args, 1);
      return Math.cos(args[0]);
    case "tan":
      ensureArity(key, args, 1);
      return Math.tan(args[0]);
    case "log":
      ensureArity(key, args, 1, 2);
      return args.length === 1 ? Math.log10(args[0]) : Math.log(args[0]) / Math.log(args[1]);
    case "ln":
      ensureArity(key, args, 1);
      return Math.log(args[0]);
    case "sqrt":
      ensureArity(key, args, 1);
      return Math.sqrt(args[0]);
    case "abs":
      ensureArity(key, args, 1);
      return Math.abs(args[0]);
    case "pow":
      ensureArity(key, args, 2);
      return Math.pow(args[0], args[1]);
    case "min":
      ensureMinArity(key, args, 1);
      return Math.min(...args);
    case "max":
      ensureMinArity(key, args, 1);
      return Math.max(...args);
    case "round":
      ensureArity(key, args, 1, 2);
      if (args.length === 1) return Math.round(args[0]);
      return Math.round(args[0] * Math.pow(10, args[1])) / Math.pow(10, args[1]);
    case "floor":
      ensureArity(key, args, 1);
      return Math.floor(args[0]);
    case "ceil":
      ensureArity(key, args, 1);
      return Math.ceil(args[0]);
    default:
      throw new Error(`Unsupported function: ${name}`);
  }
}

function evaluateCalcExpression(rawExpr: string) {
  const source = (rawExpr || "").replace(/\s+/g, "");
  if (!source) return null;

  let index = 0;
  const peek = () => source[index] || "";
  const consume = (ch: string) => {
    if (source[index] === ch) {
      index += 1;
      return true;
    }
    return false;
  };

  const parseNumber = () => {
    const rest = source.slice(index);
    const match = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("Invalid number");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("Invalid number");
    return value;
  };

  const parseIdentifier = () => {
    const rest = source.slice(index);
    const match = rest.match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (!match) throw new Error("Invalid identifier");
    index += match[0].length;
    return match[0];
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    while (true) {
      if (consume("+")) value += parseTerm();
      else if (consume("-")) value -= parseTerm();
      else break;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parsePower();
    while (true) {
      if (consume("*")) value *= parsePower();
      else if (consume("/")) value /= parsePower();
      else if (consume("%")) value %= parsePower();
      else break;
    }
    return value;
  };

  const parsePower = (): number => {
    const left = parseUnary();
    if (consume("^")) return Math.pow(left, parsePower());
    return left;
  };

  const parseUnary = (): number => {
    if (consume("+")) return parseUnary();
    if (consume("-")) return -parseUnary();
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    if (consume("(")) {
      const value = parseExpression();
      if (!consume(")")) throw new Error("Missing closing parenthesis");
      return value;
    }

    const ch = peek();
    if (/[0-9.]/.test(ch)) return parseNumber();
    if (/[a-zA-Z_]/.test(ch)) {
      const id = parseIdentifier();
      if (consume("(")) {
        const args: number[] = [];
        if (!consume(")")) {
          while (true) {
            args.push(parseExpression());
            if (consume(")")) break;
            if (!consume(",")) throw new Error("Invalid argument separator");
          }
        }
        return callCalcFunction(id, args);
      }
      const constValue = CALC_CONSTANTS[id.toLowerCase()];
      if (typeof constValue !== "number") throw new Error("Unsupported identifier");
      return constValue;
    }

    throw new Error("Unexpected token");
  };

  try {
    const value = parseExpression();
    if (index !== source.length) return null;
    if (!Number.isFinite(value) || Number.isNaN(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function formatCalcNumber(value: number) {
  const normalized = Number.parseFloat(value.toPrecision(15));
  if (Object.is(normalized, -0)) return "0";
  return `${normalized}`;
}

function createCalcItem(expression: string, result: string): AppItem {
  return {
    name: result,
    path: expression,
    type: "calc",
    description: `= ${expression}`,
  };
}

export function buildCalcItem(queryTerm: string): AppItem | null {
  const trimmed = (queryTerm || "").trim();
  if (!trimmed.startsWith("=")) return null;
  const expression = trimmed.slice(1).trim();
  if (!expression) return null;
  const result = evaluateCalcExpression(expression);
  if (result == null) return null;
  return createCalcItem(expression, formatCalcNumber(result));
}

export function parseCalcMode(rawQuery: string) {
  const trimmed = (rawQuery || "").trim();
  const isCalcMode = trimmed.startsWith("=");
  const expression = isCalcMode ? trimmed.slice(1).trim() : "";
  return { isCalcMode, expression };
}

export function normalizeCalcHistoryPayload(payload: unknown): CalcHistoryRecord[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((it) => {
      const raw = it && typeof it === "object" ? (it as CalcHistoryRawRecord) : {};
      return {
        expression: typeof raw.expression === "string" ? raw.expression.trim() : "",
        result: typeof raw.result === "string" ? raw.result.trim() : "",
        lastUsed: typeof raw.lastUsed === "number" ? raw.lastUsed : 0,
      };
    })
    .filter((it) => it.expression && it.result)
    .sort((a, b) => b.lastUsed - a.lastUsed);
}

export function mapCalcHistoryToItems(records: CalcHistoryRecord[]): AppItem[] {
  return records.map((it) => createCalcItem(it.expression, it.result));
}
