
export const API_BASE_URL = "http://localhost:3001";

export interface User {
  id: string;
  nickname: string;
  phone: string;
  email: string;
  avatarText: string;
  theme: "light" | "dark";
  primaryColor: string;
  role?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoginResponse {
  code: number;
  data: {
    token: string;
    user: User;
  } | null;
  message: string;
}

export async function login(account: string, password: string): Promise<{ token: string; user: User }> {
  try {
    const result = await window.ipcRenderer.invoke('login-request', {
      url: `${API_BASE_URL}/api/exe/login`,
      options: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ account, password }),
      },
    });

    if (!result.ok) {
      throw new Error(result.statusText || `HTTP error! status: ${result.status}`);
    }

    const responseData: LoginResponse = result.data;

    if (responseData.code === 0 && responseData.data) {
      return responseData.data;
    } else {
      throw new Error(responseData.message || "登录失败");
    }
  } catch (error) {
    console.error("Login error:", error);
    throw error;
  }
}
