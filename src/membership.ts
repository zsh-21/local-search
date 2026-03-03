import { useEffect, useState } from "react";
import { refreshUserByToken, User } from "./api";

// 会员/订阅状态：本地 token/user 读取、静默刷新、跨窗口同步事件
export const MEMBERSHIP_CHANGED_EVENT = "fs-membership-changed";

export function getStoredTokenFromLocalStorage(): string {
  return (localStorage.getItem("fs_token") || "").trim();
}

export async function refreshUserStatusSilently(opts?: { onUser?: (user: User) => void }): Promise<void> {
  const token = getStoredTokenFromLocalStorage();
  if (!token) return;

  try {
    const next = await refreshUserByToken(token);
    if (!next) return;
    localStorage.setItem("fs_user", JSON.stringify(next.user));
    localStorage.setItem("fs_token", next.token);
    window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
    opts?.onUser?.(next.user);
  } catch {
    return;
  }
}

export function getStoredUserFromLocalStorage(): User | null {
  try {
    const raw = localStorage.getItem("fs_user");
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function isUserMember(user: User | null): boolean {
  const expiresAt = user?.memberExpiresAt;
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

export function useStoredMembership(): boolean {
  const [isMember, setIsMember] = useState(() => isUserMember(getStoredUserFromLocalStorage()));

  useEffect(() => {
    const refresh = () => setIsMember(isUserMember(getStoredUserFromLocalStorage()));

    window.addEventListener("storage", refresh);
    window.addEventListener(MEMBERSHIP_CHANGED_EVENT, refresh as EventListener);

    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(MEMBERSHIP_CHANGED_EVENT, refresh as EventListener);
    };
  }, []);

  return isMember;
}
