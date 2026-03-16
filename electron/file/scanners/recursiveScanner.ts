import fs from 'node:fs/promises';
import path from 'node:path';
import { Scanner } from './scanner';
import type { FileIndexEntry } from '../../fileIndex';
import { shouldIndexFile, normalizeDrive, classifyKind, shouldSkipDirName, shouldSkipFileName } from '../utils';

/**
 * 递归扫描�?(Pure JS Fallback)
 * 对应文档：优先级 3 & 4 (无原生插�?�?NTFS/降级兜底)
 * 
 * 核心逻辑�?
 * 1. 使用 fs.opendir 遍历目录
 * 2. 内部实现并发队列 (Concurrency=8) 以提�?SSD 扫描速度
 * 3. 严格遵循 ignore 规则与目录过滤策�?
 */
export class RecursiveScanner implements Scanner {
  name = 'RecursiveScanner';

  constructor(
    private isIgnored: (path: string) => boolean,
    // 常用扩展名集合：用于“同目录内优先回调这些文件”，让用户更早搜到常用文�?代码�?
    private preferredFileExts: Set<string> = new Set<string>()
  ) {}

  async scan(
    roots: string[], 
    onProgress: (entry: FileIndexEntry) => void | Promise<void>,
    shouldStop: () => boolean,
    isSSD: boolean = true // 默认假设�?SSD 以启用较高并发，针对 HDD 会降�?
  ): Promise<void> {
    // 动态并发控制：SSD 推荐 10-14，HDD 推荐 2-4
    // 在索引期间，过高的并发在 HDD 上会导致机械磁头频繁寻道，反而变慢并导致系统卡顿
    const CONCURRENCY = isSSD ? 4 : 1; 
    // 索引优先级策略：
    // 1) 先处理非 C 盘（Windows�?
    // 2) 同一盘符内先处理浅层目录�?~4 层），再逐步深入�?~8 层，以此类推�?
    // 3) 在同一层级内按盘符轮转（D/E/.../C），避免某个盘符独占扫描资源
    const normalizeRoot = (p: string) => {
      const raw = typeof p === 'string' ? p.trim() : '';
      if (!raw) return '';
      const s = raw.replace(/\//g, '\\');
      return s.endsWith('\\') ? s : `${s}\\`;
    };
    const driveKeyOf = (p: string) => {
      const m = String(p || '').replace(/\//g, '\\').match(/^([a-zA-Z]):\\/);
      return m ? `${m[1].toUpperCase()}:` : 'UNC';
    };
    const drivePriorityOf = (driveKey: string) => {
      if (process.platform !== 'win32') return 0;
      return driveKey.toUpperCase() === 'C:' ? 10_000 : 0;
    };
    const sortedRoots = roots.map(normalizeRoot).filter(Boolean).sort((a, b) => {
      const da = driveKeyOf(a);
      const db = driveKeyOf(b);
      const pa = drivePriorityOf(da);
      const pb = drivePriorityOf(db);
      if (pa !== pb) return pa - pb;
      return da.localeCompare(db);
    });

    const drivesOrder = Array.from(new Set(sortedRoots.map(driveKeyOf)));
    const driveQueues = new Map<string, Array<{ dir: string; depth: number }>>();
    const driveDeferred = new Map<string, Array<{ dir: string; depth: number }>>();
    for (const d of drivesOrder) {
      driveQueues.set(d, []);
      driveDeferred.set(d, []);
    }
    for (const r of sortedRoots) {
      const dk = driveKeyOf(r);
      driveQueues.get(dk)?.push({ dir: r, depth: 0 });
    }

    const FIRST_BAND_MAX_DEPTH = 4;
    const BAND_STEP = 4;

    // 使用 Promise 包装并发处理流程，确保所有任务完成后才返�?
    return new Promise<void>((resolve) => {
      const scanOneDrive = (driveKey: string, bandMaxDepth: number) => {
        const queue = driveQueues.get(driveKey) || [];
        const deferred = driveDeferred.get(driveKey) || [];
        let active = 0;
        let completed = false;
        let resolveDone: (() => void) | null = null;

        const schedule = () => {
          if (completed) return;
          if (shouldStop()) {
            completed = true;
            resolve();
            resolveDone?.();
            return;
          }
          if (queue.length === 0 && active === 0) {
            completed = true;
            resolveDone?.();
            return;
          }
          while (active < CONCURRENCY && queue.length > 0) {
            const it = queue.shift();
            if (!it) continue;
            if (this.isIgnored(it.dir)) continue;
            active++;
            this.processDirectory(it.dir, onProgress, shouldStop)
              .then((subdirs) => {
                if (!subdirs) return;
                const nextDepth = it.depth + 1;
                for (const d of subdirs) {
                  if (nextDepth <= bandMaxDepth) queue.push({ dir: d, depth: nextDepth });
                  else deferred.push({ dir: d, depth: nextDepth });
                }
              })
              .catch(() => {})
              .finally(() => {
                active--;
                schedule();
              });
          }
        };

        return new Promise<void>((r) => {
          resolveDone = r;
          schedule();
        });
      };

      const scanBands = async () => {
        let bandMaxDepth = FIRST_BAND_MAX_DEPTH;
        while (!shouldStop()) {
          let didAny = false;

          for (const driveKey of drivesOrder) {
            const q = driveQueues.get(driveKey);
            if (!q || q.length === 0) continue;
            didAny = true;
            // 逐盘符执行：确保在当前深度带内，按盘符优先级完成浅层扫描
            await scanOneDrive(driveKey, bandMaxDepth);
            if (shouldStop()) break;
          }

          if (!didAny) break;

          // 切换到下一深度带：�?deferred 作为下一�?queue 继续扫描
          let anyNext = false;
          for (const driveKey of drivesOrder) {
            const nextQueue = driveDeferred.get(driveKey) || [];
            driveQueues.set(driveKey, nextQueue);
            driveDeferred.set(driveKey, []);
            if (nextQueue.length > 0) anyNext = true;
          }
          if (!anyNext) break;
          bandMaxDepth += BAND_STEP;
        }

        resolve();
      };

      void scanBands();
    });
  }

  /**
   * 处理单个目录
   * @returns 子目录路径列�?(用于后续递归)
   */
  private async processDirectory(
      current: string, 
      onProgress: (entry: FileIndexEntry) => void | Promise<void>,
      shouldStop: () => boolean
  ): Promise<string[] | null> {
    if (shouldStop()) return null;

    let dir;
    try {
        dir = await fs.opendir(current);
    } catch {
        return null;
    }

    const subdirs: string[] = [];

    try {
        const entries: Array<{ dirent: any; fullPath: string; isDirectory: boolean; ext: string }> = [];
        for await (const dirent of dir) {
            if (shouldStop()) break;
            // 符号链接可能导致死循环或指向外部，简单起见跳�?
            if (dirent.isSymbolicLink()) continue;

            const fullPath = path.join(current, dirent.name);
            if (this.isIgnored(fullPath)) continue;

            const isDirectory = dirent.isDirectory();
            const ext = isDirectory ? '' : path.extname(dirent.name).toLowerCase();
            entries.push({ dirent, fullPath, isDirectory, ext });
        }
        // 目录项排序：
        // - 先目录后文件：更快铺开浅层目录结构，配合“深度带”能更快覆盖多盘符顶�?
        // - 文件按常用扩展名优先：让常用文档/代码/程序更早入库，提升“边建边搜”体�?
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          if (!a.isDirectory && !b.isDirectory) {
            const ap = this.preferredFileExts.has(a.ext) ? 0 : 1;
            const bp = this.preferredFileExts.has(b.ext) ? 0 : 1;
            if (ap !== bp) return ap - bp;
          }
          return a.dirent.name.localeCompare(b.dirent.name);
        });

        for (const it of entries) {
          if (shouldStop()) break;
          const dirent = it.dirent;
          const fullPath = it.fullPath;
          if (it.isDirectory) {
            if (shouldSkipDirName(dirent.name)) continue;
            await onProgress({
              path: fullPath,
              name: dirent.name,
              isDirectory: true,
              kind: 'folder',
              ext: '',
              drive: normalizeDrive(fullPath),
              pinyin: '',
              initials: '',
            });
            subdirs.push(fullPath);
          } else {
            const ext = it.ext;
            if (shouldSkipFileName(dirent.name)) continue;
            if (shouldIndexFile(false, ext)) {
              await onProgress({
                path: fullPath,
                name: dirent.name,
                isDirectory: false,
                kind: classifyKind(false, ext),
                ext,
                drive: normalizeDrive(fullPath),
                pinyin: '',
                initials: '',
              });
            }
          }
        }
    } finally {
        try { await dir.close(); } catch {}
    }
    
    return subdirs;
  }
}





