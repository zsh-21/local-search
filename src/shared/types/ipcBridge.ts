/** 渲染进程暴露的安全 IPC 桥接接口 */
export interface SafeIpcRendererBridge {
  /** 订阅事件 */
  on<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => void,
  ): void;
  /** 取消事件订阅 */
  off<TArgs extends unknown[]>(
    channel: string,
    listener?: (event: unknown, ...args: TArgs) => void,
  ): void;
  /** 移除某通道全部监听器 */
  removeAllListeners(channel: string): void;
  /** 单向发送消息 */
  send(channel: string, ...args: unknown[]): void;
  /** 双向请求消息 */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
}
