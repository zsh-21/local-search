import { Scanner } from './scanner';
import type { FileIndexEntry } from '../../fileIndex';
import { SystemDetector } from '../systemDetector';

/**
 * USN 日志扫描器 (Native Bridge)
 * 对应文档：优先级 1 & 2 (原生插件 + NTFS)
 * 
 * 核心逻辑：
 * 1. 依赖原生模块 (node-ffi-napi) 调用 Windows API (FSCTL_READ_USN_JOURNAL)
 * 2. 极速获取文件变更记录与全量文件列表
 * 3. 必须在检测到 hasNativeSupport 为 true 时才启用
 */
export class UsnScanner implements Scanner {
  name = 'UsnScanner';

  constructor(
    private isIgnored: (path: string) => boolean
  ) {}

  async scan(
    roots: string[], 
    onProgress: (entry: FileIndexEntry) => void | Promise<void>,
    shouldStop: () => boolean
  ): Promise<void> {
    const detector = SystemDetector.getInstance();
    // 快速失败：当前未集成原生 USN 能力时，不做重型探测，直接降级递归扫描。
    if (!detector.hasNativeSupport()) {
      throw new Error('当前环境不支持原生模块，无法使用 USN 扫描');
    }
    // 按盘符分组处理
    const drives = new Set(roots.map(r => r.substring(0, 2).toUpperCase()));
    
    for (const drive of drives) {
      if (shouldStop()) break;

      // TODO: 此处需通过 ffi-napi 调用 CreateFile/DeviceIoControl
      // 当前项目尚未实现原生扫描，保留 USN 可用性探测后统一回退。
      const supported = await detector.checkUsnSupport(drive);
      if (!supported) {
        throw new Error(`驱动器 ${drive} 不支持或未启用 USN 日志`);
      }
      throw new Error('Native module implementation pending.');
    }
  }
}
