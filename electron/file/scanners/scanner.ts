import type { FileIndexEntry } from '../../fileIndex';

export interface ScanResult {
  entries: FileIndexEntry[];
  partial: boolean;
}

/**
 * 扫描器接口定义
 * 所有具体扫描策略（递归、USN 等）均需实现此接口
 */
export interface Scanner {
  /**
   * 执行扫描任务
   * @param roots 待扫描的根路径列表
   * @param onProgress 扫描到一个文件/目录时的回调（支持异步）
   * @param shouldStop 是否应立即停止扫描的检查函数
   */
  scan(
    roots: string[], 
    onProgress: (entry: FileIndexEntry) => void | Promise<void>,
    shouldStop: () => boolean
  ): Promise<void>;
  
  /**
   * 扫描器名称，用于日志与调试
   */
  name: string;
}
