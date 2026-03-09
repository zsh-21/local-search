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
    const info = await detector.detect();

    // 严格检查：无原生支持时禁止运行，直接抛出异常触发降级
    if (!info.hasNativeSupport) {
      throw new Error('当前环境不支持原生模块，无法使用 USN 扫描');
    }
    
    // 按盘符分组处理
    const drives = new Set(roots.map(r => r.substring(0, 2).toUpperCase()));
    
    for (const drive of drives) {
        if (shouldStop()) break;
        
        // 检查 USN 日志是否可用
        const supported = await detector.checkUsnSupport(drive);
        if (!supported) {
            throw new Error(`驱动器 ${drive} 不支持或未启用 USN 日志`);
        }

        // TODO: 此处需通过 ffi-napi 调用 CreateFile/DeviceIoControl
        // 目前项目未集成原生模块，因此在此处显式抛出异常，
        // 确保流程正确回退到 RecursiveScanner (优先级 3)
        
        console.warn(`[UsnScanner] 尚未集成原生模块，降级到递归扫描: ${drive}`);
        throw new Error("Native module implementation pending.");
    }
  }
}
