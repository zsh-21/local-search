import fs from 'node:fs/promises';
import path from 'node:path';
import { Scanner } from './scanner';
import type { FileIndexEntry } from '../../fileIndex';
import { shouldIndexFile, normalizeDrive, classifyKind, shouldSkipDirName } from '../utils';

/**
 * 递归扫描器 (Pure JS Fallback)
 * 对应文档：优先级 3 & 4 (无原生插件/非 NTFS/降级兜底)
 * 
 * 核心逻辑：
 * 1. 使用 fs.opendir 遍历目录
 * 2. 内部实现并发队列 (Concurrency=8) 以提升 SSD 扫描速度
 * 3. 严格遵循 ignore 规则与目录过滤策略
 */
export class RecursiveScanner implements Scanner {
  name = 'RecursiveScanner';

  constructor(
    private isIgnored: (path: string) => boolean
  ) {}

  async scan(
    roots: string[], 
    onProgress: (entry: FileIndexEntry) => void | Promise<void>,
    shouldStop: () => boolean
  ): Promise<void> {
    const CONCURRENCY = 8; // 并发读取目录数，针对 SSD 优化
    const queue: string[] = [...roots];
    let active = 0;
    let completed = false;

    // 使用 Promise 包装并发处理流程，确保所有任务完成后才返回
    return new Promise<void>((resolve, reject) => {
        const processNext = () => {
            if (shouldStop()) {
                resolve();
                return;
            }

            // 队列为空且无活跃任务，说明扫描结束
            if (queue.length === 0 && active === 0) {
                if (!completed) {
                    completed = true;
                    resolve();
                }
                return;
            }

            // 调度任务直到达到并发上限
            while (active < CONCURRENCY && queue.length > 0) {
                const current = queue.shift();
                if (!current) continue;
                
                if (this.isIgnored(current)) {
                    continue;
                }

                active++;
                this.processDirectory(current, onProgress, shouldStop)
                    .then((subdirs) => {
                        if (subdirs) {
                            // 将子目录加入队列继续扫描
                            for (const d of subdirs) queue.push(d);
                        }
                    })
                    .catch(() => {
                        // 忽略单个目录的读取错误 (如权限不足)，保证整体扫描不中断
                    }) 
                    .finally(() => {
                        active--;
                        processNext();
                    });
            }
        };

        processNext();
    });
  }

  /**
   * 处理单个目录
   * @returns 子目录路径列表 (用于后续递归)
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
        for await (const dirent of dir) {
            if (shouldStop()) break;
            // 符号链接可能导致死循环或指向外部，简单起见跳过
            if (dirent.isSymbolicLink()) continue;

            const fullPath = path.join(current, dirent.name);
            if (this.isIgnored(fullPath)) continue;

            const isDirectory = dirent.isDirectory();
            
            if (isDirectory) {
                // 过滤特定目录 (node_modules, .git 等)
                if (shouldSkipDirName(dirent.name)) continue;
                
                await onProgress({
                    path: fullPath,
                    name: dirent.name,
                    isDirectory: true,
                    kind: 'folder',
                    ext: '',
                    drive: normalizeDrive(fullPath),
                    pinyin: '', // 稍后由 tokenizer 填充
                    initials: '' 
                });
                subdirs.push(fullPath);
            } else {
                const ext = path.extname(dirent.name).toLowerCase();
                // 仅索引特定类型文件
                if (shouldIndexFile(false, ext)) {
                    await onProgress({
                        path: fullPath,
                        name: dirent.name,
                        isDirectory: false,
                        kind: classifyKind(false, ext),
                        ext,
                        drive: normalizeDrive(fullPath),
                        pinyin: '',
                        initials: ''
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
