/**
 * 统一管理主进程的 setTimeout 定时任务：
 * - 按 key 防重复
 * - 支持统一清理
 * - 提供活跃计数
 */
export class SafeTimeoutRegistry {
  /** 活跃定时器映射表 */
  private readonly timerMap = new Map<string, ReturnType<typeof setTimeout>>();

  /** 按 key 调度单次定时任务 */
  schedule(key: string, delayMs: number, task: () => void | Promise<void>) {
    /** 空 key 保护 */
    if (!key) return;
    /** 归一化后的延迟时间 */
    const normalizedDelayMs = Math.max(0, Math.floor(Number(delayMs) || 0));

    /** 同 key 防重复：调度前先取消旧任务 */
    this.cancel(key);
    /** 新定时器句柄 */
    const timer = setTimeout(() => {
      /** 执行前先移除句柄，保持计数准确 */
      this.timerMap.delete(key);
      void task();
    }, normalizedDelayMs);
    this.timerMap.set(key, timer);
  }

  /** 取消指定 key 的定时任务 */
  cancel(key: string) {
    /** 目标定时器句柄 */
    const timer = this.timerMap.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.timerMap.delete(key);
  }

  /** 取消全部定时任务 */
  cancelAll() {
    /** 清理所有活跃句柄 */
    for (const timer of this.timerMap.values()) {
      clearTimeout(timer);
    }
    this.timerMap.clear();
  }

  /** 获取活跃定时器数量 */
  getActiveCount() {
    return this.timerMap.size;
  }
}
