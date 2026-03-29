import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';

/** 路径恢复期望类型。 */
export type PathRecoveryExpectedType = 'file' | 'folder' | 'any';

/** 路径恢复结果。 */
export type PathRecoveryResult = {
  /** 最终可用路径。 */
  resolvedPath: string;
  /** 文件或目录名。 */
  name: string;
  /** 是否为目录。 */
  isDirectory: boolean;
  /** 最近时间戳。 */
  timeMs: number;
  /** 是否由同目录同名候选恢复。 */
  recovered: boolean;
};

/** 文件状态类型，避免在时间戳读取时使用宽泛类型。 */
type FsStat = Stats;

/** 安全读取文件状态。 */
async function readStatSafe(targetPath: string) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

/** 归一化 Windows 风格路径。 */
function normalizeWinPath(rawPath: string) {
  return String(rawPath || '').replace(/\//g, '\\').trim();
}

/** 提取文件时间戳。 */
function pickTimeMs(st: FsStat | null) {
  if (!st) return 0;
  return Math.max(st.mtimeMs || 0, st.birthtimeMs || 0);
}

/** 尝试解析原路径或同目录同名不同后缀路径。 */
export async function tryResolveExistingOrRenamedPath(
  rawPath: string,
  options?: { expectedType?: PathRecoveryExpectedType; maxEntries?: number },
): Promise<PathRecoveryResult | null> {
  /** 先归一化输入路径，避免混用斜杠影响比较。 */
  const normalized = normalizeWinPath(rawPath);
  if (!normalized) return null;

  /** 期望类型默认允许文件和目录。 */
  const expectedType = options?.expectedType || 'any';

  /** 同目录扫描上限，避免单次回补过重。 */
  const maxEntries = Math.max(100, Math.min(10_000, Number(options?.maxEntries) || 2_000));

  /** 先校验原路径本身。 */
  const directStat = await readStatSafe(normalized);
  if (directStat) {
    const isDirectory = directStat.isDirectory();
    if (expectedType === 'file' && isDirectory) return null;
    if (expectedType === 'folder' && !isDirectory) return null;
    return {
      resolvedPath: normalized,
      name: path.basename(normalized),
      isDirectory,
      timeMs: pickTimeMs(directStat),
      recovered: false,
    };
  }

  /** 原路径不存在时，尝试在父目录里找同名候选。 */
  const parentDir = path.dirname(normalized);
  if (!parentDir || !existsSync(parentDir)) return null;

  /** 提取目标文件名信息。 */
  const parsed = path.parse(normalized);
  const targetBaseLower = String(parsed.base || '').toLowerCase();
  const targetStemLower = String(parsed.name || '').toLowerCase();
  if (!targetStemLower) return null;

  /** 读取父目录条目。 */
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(parentDir, { withFileTypes: true });
  } catch {
    return null;
  }

  /** 记录最优候选。 */
  let bestPath = '';
  let bestIsDirectory = false;
  let bestTimeMs = -1;
  let visited = 0;

  for (const entry of entries) {
    if (!entry?.name) continue;
    visited += 1;
    if (visited > maxEntries) break;

    const entryBaseLower = String(entry.name).toLowerCase();
    if (entryBaseLower === targetBaseLower) continue;
    const entryStemLower = path.parse(entry.name).name.toLowerCase();
    if (entryStemLower !== targetStemLower) continue;

    const candidatePath = path.join(parentDir, entry.name);
    const st = await readStatSafe(candidatePath);
    if (!st) continue;

    const isDirectory = st.isDirectory();
    if (expectedType === 'file' && isDirectory) continue;
    if (expectedType === 'folder' && !isDirectory) continue;

    const timeMs = pickTimeMs(st);
    if (timeMs > bestTimeMs) {
      bestTimeMs = timeMs;
      bestPath = candidatePath;
      bestIsDirectory = isDirectory;
    }
  }

  if (!bestPath) return null;
  return {
    resolvedPath: bestPath,
    name: path.basename(bestPath),
    isDirectory: bestIsDirectory,
    timeMs: Math.max(0, bestTimeMs),
    recovered: true,
  };
}
