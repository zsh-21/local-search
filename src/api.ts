
export const API_BASE_URL = "http://localhost:3001";

export interface User {
  id: string;
  nickname: string;
  phone: string;
  email: string;
  avatarText: string;
  theme: "light" | "dark";
  primaryColor: string;
  // 会员到期时间（ISO 字符串）；后端仅在存在记录时返回
  memberExpiresAt?: string;
  role?: string;
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
  } | null;
  message: string;
}

type ApiRequestResult = {
  ok: boolean;
  status: number;
  statusText: string;
  data: any;
};

async function requestJson(url: string, options: any): Promise<ApiRequestResult> {
  const result = (await window.ipcRenderer.invoke("login-request", { url, options })) as ApiRequestResult;
  return result;
}

function normalizeUserFromLoginData(data: { token: string; user: User; membership?: { expiresAt: string } }): User {
  return {
    ...data.user,
    memberExpiresAt: data.user.memberExpiresAt ?? data.membership?.expiresAt,
  };
}

export async function login(account: string, password: string): Promise<{ token: string; user: User }> {
  try {
    const result = await requestJson(`${API_BASE_URL}/api/exe/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account, password }),
    });

    if (!result.ok) {
      throw new Error(result.statusText || `HTTP error! status: ${result.status}`);
    }

    const responseData: LoginResponse = result.data;

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

    const responseData: RefreshResponse = result.data;
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
