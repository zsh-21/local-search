// 盘符前缀支持三种写法：
// - C:
// - C: |
// - C：|
// 并保持对路径输入（如 C:\Windows）的排除，避免把绝对路径误判成盘符筛选。
const DRIVE_PREFIX_RE = /^\s*([a-zA-Z])\s*(?::|\uFF1A)\s*(?:\|\s*)?(?![\\/])/;

// 解析输入中的盘符筛选前缀，并返回剥离后的查询词
export function parseDrivePrefix(raw: string) {
  const s = typeof raw === "string" ? raw.trim() : "";
  const m = s.match(DRIVE_PREFIX_RE);
  if (!m) return { term: s, drive: "" };
  const drive = (m[1] || "").toLowerCase();
  if (drive === "p") return { term: s, drive: "" };
  const term = s.slice(m[0].length).trim();
  return { term, drive };
}

// 生成“输入补全幽灵文本”：在盘符筛选存在时也保持补全正确
export function resolveGhostCandidateByInput(rawInput: string, candidateName: string) {
  const normalizedInput = typeof rawInput === "string" ? rawInput : "";
  const normalizedName = typeof candidateName === "string" ? candidateName.trim() : "";
  if (!normalizedName) return "";
  const parsed = parseDrivePrefix(normalizedInput);
  if (parsed.drive) {
    const inputTerm = parsed.term;
    const termLower = inputTerm.toLocaleLowerCase();
    const nameLower = normalizedName.toLocaleLowerCase();
    if (!termLower || !nameLower.startsWith(termLower) || normalizedName.length <= inputTerm.length) {
      return "";
    }
    const prefixMatch = normalizedInput.match(DRIVE_PREFIX_RE);
    const prefix = prefixMatch
      ? normalizedInput.slice(0, prefixMatch[0].length)
      : `${parsed.drive}:`;
    return `${prefix}${normalizedName}`;
  }
  const inputLower = normalizedInput.toLocaleLowerCase();
  const nameLower = normalizedName.toLocaleLowerCase();
  if (!nameLower.startsWith(inputLower) || normalizedName.length <= normalizedInput.length) return "";
  return normalizedName;
}
