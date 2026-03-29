/** IPC 通用响应结构：用于跨进程返回统一成功态 */
export interface IpcOkResponse {
  /** 请求是否成功 */
  ok: boolean;
}

/** IPC 搜索请求附加参数 */
export interface IpcSearchFilesOptions {
  /** 当前搜索类型标识 */
  searchTypeId?: string;
  /** 当前搜索会话标识 */
  searchSessionId?: string;
  /** 当前限定盘符 */
  drive?: string;
}

/** IPC 登录代理请求参数 */
export interface IpcLoginRequestPayload {
  /** 登录目标地址 */
  url: string;
  /** fetch 请求配置 */
  options: unknown;
}
