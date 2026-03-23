export function parseDrivePrefix(raw: string) {
  const s = typeof raw === "string" ? raw.trim() : "";
  const m = s.match(/^([a-zA-Z])\s*(?::|\uFF1A)\s*(?![\\/])/);
  if (!m) return { term: s, drive: "" };
  const drive = (m[1] || "").toLowerCase();
  if (drive === "p") return { term: s, drive: "" };
  const term = s.slice(m[0].length).trim();
  return { term, drive };
}

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
    const prefixMatch = normalizedInput.match(/^\s*([a-zA-Z])\s*(?::|\uFF1A)\s*(?![\\/])/);
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
