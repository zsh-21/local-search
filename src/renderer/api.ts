import { API_BASE_URL } from "./constants/initialValues";
import { IPC_GET_DEVICE_ID, IPC_LOGIN_REQUEST } from "../shared/ipc/channels";

// 默认后端地址已抽离：便于你集中调整与后续做环境切换
export { API_BASE_URL };

// 用户结构：由后端返回，前端仅做展示与会员判断
export interface User {
  id: string;
  nickname: string;
  phone: string;
  email: string;
  avatarText: string;
  // 主题字段与本地设置保持同一集合，避免登录后主题回显出现未知值。
  theme:
    | "dark"
    | "vector"
    | "noir"
    | "oxide"
    | "mac"
    | "blueprint"
    | "paper";
  primaryColor: string;
  // 会员到期时间（ISO 字符串）；后端仅在存在记录时返回
  memberExpiresAt?: string;
  plan?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoginResponse {
  code: number;
  data: {
    token: string;
    user: User;
    // 兼容文档中的 membership 返回：有效会员才会携带
    membership?: {
      expiresAt: string;
    };
    config?: {
      maxDevices: number;
    };
  } | null;
  message: string;
}

export interface RefreshResponse {
  code: number;
  data: {
    token: string;
    user: User;
    membership?: {
      expiresAt: string;
    };
    config?: {
      maxDevices: number;
    };
  } | null;
  message: string;
}

type ApiRequestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
};

/**
 * 从未知响应载荷中提取 message 字段
 */
function readMessageFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

/**
 * 通过主进程代理发起 JSON 请求
 */
async function requestJson(url: string, options: RequestInit): Promise<ApiRequestResult> {
  // 通过主进程代理请求：避免渲染进程跨域/证书等限制，并统一复用 fetch 能力
  const result = (await window.ipcRenderer.invoke(IPC_LOGIN_REQUEST, { url, options })) as ApiRequestResult;
  return result;
}

function normalizeUserFromLoginData(data: { token: string; user: User; membership?: { expiresAt: string } }): User {
  // 兼容不同接口的会员字段：后端可能返回 membership.expiresAt 或 user.memberExpiresAt
  return {
    ...data.user,
    memberExpiresAt: data.user.memberExpiresAt ?? data.membership?.expiresAt,
  };
}

export async function login(account: string, password: string): Promise<{ token: string; user: User }> {
  try {
    const deviceId = await window.ipcRenderer.invoke<string>(IPC_GET_DEVICE_ID);
    // 登录接口：成功返回 token 与 user；失败抛错交给 UI 统一提示
    const result = await requestJson(`${API_BASE_URL}/api/exe/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account, password, deviceId }),
    });

    if (!result.ok) {
      const errorMsg = readMessageFromPayload(result.data);
      if (result.status === 403) {
        throw new Error(errorMsg || "该账号已在两台设备登录，请退出其他设备后重试");
      }
      throw new Error(errorMsg || result.statusText || `HTTP error! status: ${result.status}`);
    }

    const responseData = result.data as LoginResponse;

    if (responseData.code === 0 && responseData.data) {
      return { token: responseData.data.token, user: normalizeUserFromLoginData(responseData.data) };
    } else {
      throw new Error(responseData.message || "登录失败");
    }
  } catch (error) {
    console.error("Login error:", error);
    throw error;
  }
}

function normalizeBearerToken(token: string): string {
  // 统一 Authorization 格式：允许传入纯 token 或 Bearer token
  const trimmed = (token || "").trim();
  if (!trimmed) return "";
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export async function refreshUserByToken(oldToken: string): Promise<{ token: string; user: User } | null> {
  // 通过 EXE 刷新接口获取最新用户信息与最新 Token（失败时静默返回 null）
  const auth = normalizeBearerToken(oldToken);
  if (!auth) return null;

  try {
    const result = await requestJson(`${API_BASE_URL}/api/exe/refresh`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!result.ok) return null;

    const responseData = result.data as RefreshResponse;
    if (responseData.code === 0 && responseData.data) {
      return {
        token: responseData.data.token,
        user: normalizeUserFromLoginData(responseData.data),
      };
    }
    return null;
  } catch {
    return null;
  }
}
