import { useEffect, useMemo, useRef, useState } from "react";
import { login, refreshUserByToken, User } from "../api";
import { AppSettings, DEFAULT_SETTINGS } from "../appTypes";
import { MEMBERSHIP_CHANGED_EVENT, getStoredTokenFromLocalStorage, isUserMember, refreshUserStatusSilently } from "../membership";
import {
  FS_LAST_LOGIN_ACCOUNT_KEY,
  FS_LAST_LOGIN_PASSWORD_KEY,
  FS_TOKEN_KEY,
  FS_USER_KEY,
  THEME_COLOR_OPTIONS,
  THEME_STYLE_OPTIONS,
} from "../constants/initialValues";
import { applyMembershipRestrictionsToSettings, getSearchTypeOptions, useSettings } from "../settingsStore";

// 设置页控制器：集中管理 draft/保存、会员与登录态、toast，以及默认类型下拉等复杂交互状态
export type SettingsTabKey = "general" | "search" | "shortcuts" | "appearance" | "account";
// 账号缓存 key 已抽离：便于你统一管理 localStorage 命名与后续迁移
const LAST_LOGIN_ACCOUNT_KEY = FS_LAST_LOGIN_ACCOUNT_KEY;
const LAST_LOGIN_PASSWORD_KEY = FS_LAST_LOGIN_PASSWORD_KEY;

function getLastLoginAccount() {
  try {
    return localStorage.getItem(LAST_LOGIN_ACCOUNT_KEY) || "";
  } catch {
    return "";
  }
}

function getLastLoginPassword() {
  try {
    return localStorage.getItem(LAST_LOGIN_PASSWORD_KEY) || "";
  } catch {
    return "";
  }
}

export function useSettingsController() {
  const { settings, loaded } = useSettings();

  // draft 用于承载“未保存的设置修改”，避免直接改动全局 settings 导致其他窗口立即变化
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [error, setErrorState] = useState("");
  const [maximized, setMaximized] = useState(false);
  const [activeKey, setActiveKey] = useState<SettingsTabKey>("account");
  const [newTypeExt, setNewTypeExt] = useState("");
  const readySentRef = useRef(false);

  useEffect(() => {
    // 当全局 settings 更新（主进程保存后广播）时，同步刷新 draft
    setDraft(settings);
  }, [
    settings.autoStart,
    settings.searchShortcut,
    settings.settingsShortcut,
    settings.theme,
    settings.uiFontFamily,
    settings.historyLimit,
    settings.defaultSearchTypeId,
    settings.customSearchTypes,
    settings.searchTypeOrder,
    settings.disabledSearchTypeIds,
    settings.ignoredPaths,
    settings.showResultPath,
    settings.accentColor,
    settings.enableEffect,
    settings.effectType,
    settings.backgroundImagePath,
    settings.backgroundImageOpacity,
  ]);

  const isDraftSynced = useMemo(() => {
    const arrEq = (a: string[], b: string[]) =>
      a.length === b.length && a.every((x, i) => x === b[i]);
    return (
      draft.autoStart === settings.autoStart &&
      draft.searchShortcut === settings.searchShortcut &&
      draft.settingsShortcut === settings.settingsShortcut &&
      draft.theme === settings.theme &&
      draft.uiFontFamily === settings.uiFontFamily &&
      draft.historyLimit === settings.historyLimit &&
      draft.defaultSearchTypeId === settings.defaultSearchTypeId &&
      arrEq(draft.customSearchTypes || [], settings.customSearchTypes || []) &&
      arrEq(draft.searchTypeOrder || [], settings.searchTypeOrder || []) &&
      arrEq(draft.disabledSearchTypeIds || [], settings.disabledSearchTypeIds || []) &&
      arrEq(draft.ignoredPaths || [], settings.ignoredPaths || []) &&
      draft.keepStateOnClose === settings.keepStateOnClose &&
      draft.showResultPath === settings.showResultPath &&
      draft.enableHistory === settings.enableHistory &&
      draft.accentColor === settings.accentColor &&
      draft.enableEffect === settings.enableEffect &&
      draft.effectType === settings.effectType &&
      draft.backgroundImagePath === settings.backgroundImagePath &&
      draft.backgroundImageOpacity === settings.backgroundImageOpacity
    );
  }, [draft, settings]);

  useEffect(() => {
    // 与主进程握手：等设置加载完成且 draft 与 settings 一致后，通知主进程可以显示窗口
    if (!loaded) return;
    if (!isDraftSynced) return;
    if (readySentRef.current) return;
    readySentRef.current = true;
    window.ipcRenderer?.invoke("settings-view-ready");
  }, [loaded, isDraftSynced]);

  const applyThemePreview = (theme: AppSettings["theme"], accentColor: string) => {
    // 主题预览即时应用到 document：保存前也能看到真实效果
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--fs-accent", accentColor);
    const r = parseInt(accentColor.slice(1, 3), 16);
    const g = parseInt(accentColor.slice(3, 5), 16);
    const b = parseInt(accentColor.slice(5, 7), 16);
    document.documentElement.style.setProperty("--fs-accent-soft", `rgba(${r}, ${g}, ${b}, 0.1)`);
    document.documentElement.style.setProperty("--fs-dots", `rgba(${r}, ${g}, ${b}, 0.2)`);
    document.documentElement.style.setProperty("--fs-glow", `rgba(${r}, ${g}, ${b}, 0.15)`);

    document.documentElement.classList.add("theme-anim");
    window.setTimeout(() => {
      document.documentElement.classList.remove("theme-anim");
    }, 240);
  };

  const applyFontPreview = (fontFamily: string) => {
    const next = typeof fontFamily === "string" && fontFamily.trim() ? fontFamily.trim() : settings.uiFontFamily;
    document.documentElement.style.setProperty("--fs-font-sans", next);
  };

  useEffect(() => {
    // 设置窗口每次打开时重置到“账号页”，并刷新一次订阅状态
    const handler = () => {
      void refreshUserStatusSilently({ onUser: (nextUser) => setUser(nextUser) });
      setDraft(settings);
      setError("");
      setActiveKey("account");
      setNewTypeExt("");
      applyThemePreview(settings.theme, settings.accentColor);
      applyFontPreview(settings.uiFontFamily);
    };
    window.ipcRenderer?.on("settings-window-opened", handler as any);
    return () => {
      window.ipcRenderer?.off("settings-window-opened", handler as any);
    };
  }, [settings]);

  const onClose = () => {
    // 取消关闭：丢弃草稿并回到账号页，避免误保存
    setError("");
    setDraft(settings);
    setActiveKey("account");
    setNewTypeExt("");
    applyThemePreview(settings.theme, settings.accentColor);
    applyFontPreview(settings.uiFontFamily);
    window.ipcRenderer?.invoke("hide-window");
  };

  const onToggleMax = async () => {
    const resp = (await window.ipcRenderer?.invoke("toggle-maximize")) as
      | { maximized: boolean }
      | undefined;
    if (typeof resp?.maximized === "boolean") setMaximized(resp.maximized);
  };

  const save = async () => {
    setError("");
    // 保存前做会员降级：非会员的高级选项会被统一回退
    const nextDraft = applyMembershipRestrictionsToSettings(draft, isUserMember(user));
    const resp = (await window.ipcRenderer?.invoke("save-settings", nextDraft)) as
      | { ok: boolean; message?: string }
      | undefined;
    if (resp?.ok === false) {
      setError(resp.message || "设置保存失败");
      showToast(resp.message || "设置保存失败", "error");
      return;
    }
    applyThemePreview(nextDraft.theme, nextDraft.accentColor);
    applyFontPreview(nextDraft.uiFontFamily);
    // 保存后不自动关闭设置窗口：仅提示成功，关闭由用户主动点击右上角完成
    showToast("保存成功", "success");
  };

  const typeOptions = useMemo(
    () => getSearchTypeOptions(draft.customSearchTypes || [], draft.searchTypeOrder),
    [draft.customSearchTypes, draft.searchTypeOrder],
  );

  const [defaultTypeMenuOpen, setDefaultTypeMenuOpen] = useState(false);
  const [defaultTypeActiveIndex, setDefaultTypeActiveIndex] = useState<number>(() => {
    const idx = typeOptions.findIndex((x) => x.id === (draft.defaultSearchTypeId || "all"));
    return idx >= 0 ? idx : 0;
  });
  const defaultTypeSelectRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 切换设置面板时，自动关闭下拉菜单
    setDefaultTypeMenuOpen(false);
  }, [activeKey]);

  useEffect(() => {
    if (!defaultTypeMenuOpen) return;
    // 菜单打开时将键盘高亮定位到当前默认类型，便于上下键操作
    const idx = typeOptions.findIndex((x) => x.id === (draft.defaultSearchTypeId || "all"));
    setDefaultTypeActiveIndex(idx >= 0 ? idx : 0);
  }, [defaultTypeMenuOpen, draft.defaultSearchTypeId, typeOptions]);

  useEffect(() => {
    if (!defaultTypeMenuOpen) return;
    // 点击下拉之外关闭菜单，避免菜单悬浮影响交互
    const onMouseDown = (e: MouseEvent) => {
      const el = defaultTypeSelectRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setDefaultTypeMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [defaultTypeMenuOpen]);

  const currentDefaultTypeLabel = useMemo(() => {
    const id = draft.defaultSearchTypeId || "all";
    return typeOptions.find((x) => x.id === id)?.label || "所有文件";
  }, [draft.defaultSearchTypeId, typeOptions]);

  const pickDefaultTypeByIndex = (index: number) => {
    const next = typeOptions[index];
    if (!next) return;
    setDraft({ ...draft, defaultSearchTypeId: next.id });
    setError("");
    setDefaultTypeMenuOpen(false);
  };

  const moveTypeId = (list: string[], fromId: string, toId: string, position: "before" | "after") => {
    const fromIndex = list.indexOf(fromId);
    let toIndex = list.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) return list;

    const next = list.slice();
    const [item] = next.splice(fromIndex, 1);
    toIndex = next.indexOf(toId);
    if (position === "after") next.splice(toIndex + 1, 0, item);
    else next.splice(toIndex, 0, item);
    return next;
  };

  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem(FS_USER_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const isMember = useMemo(() => isUserMember(user), [user]);
  const [loginForm, setLoginForm] = useState(() => ({ account: getLastLoginAccount(), password: getLastLoginPassword() }));
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [toast, setToast] = useState<null | { kind: "success" | "error" | "info"; message: string }>(null);
  const toastTimerRef = useRef<number | null>(null);

  const clearAvatarSettingIfNeeded = async () => {
    // 未登录时清空头像：头像属于“账号相关展示”，避免退出登录后仍显示上次账号的头像
    try {
      setDraft((prev) => {
        if (!prev.customAvatarPath) return prev;
        return { ...prev, customAvatarPath: "" };
      });

      // 仅当已保存的 settings 里有头像路径时才写盘，避免无意义的设置写入
      if (!settings.customAvatarPath) return;

      const next = { ...settings, customAvatarPath: "" };
      await window.ipcRenderer?.invoke("save-settings", next);
    } catch {
      // 清理头像属于兜底行为：失败时不阻塞主流程
    }
  };

  function showToast(message: string, kind: "success" | "error" | "info" = "info") {
    // toast 只保留一个：重复触发时先清理旧定时器，避免叠加闪烁
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ kind, message });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2000);
  }

  const setError = (msg: string) => {
    // 所有异常/非法操作需要有即时反馈：除了页面内错误文案外，同时弹一个“警告提示”
    setErrorState(msg);
    if (msg) showToast(msg, "info");
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const clearLoginState = () => {
    // 清理本地登录态并广播：用于跨窗口刷新会员状态
    setUser(null);
    localStorage.removeItem(FS_USER_KEY);
    localStorage.removeItem(FS_TOKEN_KEY);
    window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
    setLoginForm((prev) => ({ ...prev, account: getLastLoginAccount(), password: getLastLoginPassword() }));

    // 退出登录后同步清空头像：避免“未登录仍显示头像”的困惑
    void clearAvatarSettingIfNeeded();
  };

  useEffect(() => {
    const handler = () => {
      const saved = localStorage.getItem(FS_USER_KEY);
      const nextUser = saved ? (JSON.parse(saved) as User) : null;
      setUser(nextUser);
      if (!nextUser) {
        setLoginForm((prev) => ({ ...prev, account: getLastLoginAccount(), password: getLastLoginPassword() }));
      }
    };
    window.addEventListener(MEMBERSHIP_CHANGED_EVENT, handler as EventListener);
    return () => window.removeEventListener(MEMBERSHIP_CHANGED_EVENT, handler as EventListener);
  }, []);

  useEffect(() => {
    // 启动兜底：如果没有 token 但 settings 里残留头像路径，则自动清理
    if (!loaded) return;
    if (getStoredTokenFromLocalStorage()) return;
    if (!settings.customAvatarPath) return;
    void clearAvatarSettingIfNeeded();
  }, [loaded, settings.customAvatarPath]);

  const doRefreshStatus = async () => {
    // 防并发刷新：避免重复点击导致多次请求与状态覆盖
    if (isRefreshingStatus) return;
    if (!getStoredTokenFromLocalStorage()) return;
    setIsRefreshingStatus(true);
    try {
      const token = getStoredTokenFromLocalStorage();
      const [next] = await Promise.all([
        refreshUserByToken(token),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      if (!next) {
        showToast("状态更新失败，请重新登录", "error");
        clearLoginState();
        return;
      }
      setUser(next.user);
      localStorage.setItem(FS_USER_KEY, JSON.stringify(next.user));
      localStorage.setItem(FS_TOKEN_KEY, next.token);
      window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
      showToast("已更新", "success");
    } catch {
      showToast("状态更新失败，请重新登录", "error");
      clearLoginState();
    } finally {
      setIsRefreshingStatus(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const account = (loginForm.account || "").trim();
    if (account) {
      localStorage.setItem(LAST_LOGIN_ACCOUNT_KEY, account);
    }
    if (loginForm.password) {
      localStorage.setItem(LAST_LOGIN_PASSWORD_KEY, loginForm.password);
    }
    if (!account || !loginForm.password) {
      setLoginError("请输入账号和密码");
      showToast("请输入账号和密码", "info");
      return;
    }
    setIsLoggingIn(true);
    setLoginError("");

    try {
      const data = await login(account, loginForm.password);
      setUser(data.user);
      localStorage.setItem(FS_USER_KEY, JSON.stringify(data.user));
      localStorage.setItem(FS_TOKEN_KEY, data.token);
      window.dispatchEvent(new Event(MEMBERSHIP_CHANGED_EVENT));
      setLoginForm((prev) => ({ ...prev, account, password: getLastLoginPassword() || loginForm.password }));
      showToast("登录成功", "success");
    } catch (err: any) {
      const msg = err?.message || "登录失败";
      setLoginError(msg);
      showToast(msg, "error");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (!user || isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await new Promise((r) => window.setTimeout(r, 350));
      clearLoginState();
      showToast("已退出登录", "success");
    } finally {
      setIsLoggingOut(false);
    }
  };

  // 主题色列表已抽离：便于你集中调整颜色、命名或增加新主题色
  const themeColors = THEME_COLOR_OPTIONS;
  const themeOptions = THEME_STYLE_OPTIONS;
  const fontOptions = [
    {
      id: "segoe-ui",// 👌
      label: "Segoe UI",
      value: DEFAULT_SETTINGS.uiFontFamily,
      sample: "Aa 123",
    },
    {
      id: "microsoft-yahei",// 👌
      label: "Microsoft YaHei",
      value: '"Microsoft YaHei", "Segoe UI", "Noto Sans", Arial, sans-serif',
      sample: "Aa 123",
    },
    {
      id: "pingfang-sc",// 👌
      label: "PingFang SC",
      value: '"PingFang SC", "Microsoft YaHei", "Segoe UI", Arial, sans-serif',
      sample: "Aa 123",
    }, 
    {
      id: "arial",// 👌
      label: "Arial",
      value: "Arial, \"Segoe UI\", sans-serif",
      sample: "Aa 123",
    },
    {
      id: "microsoft-yahei-ui",// 👌
      label: "Microsoft YaHei UI",
      value: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif',
      sample: "Aa 123",
    },
    {
      id: "simsun",// 👌
      label: "SimSun",
      value: '"SimSun", "Songti SC", "Microsoft YaHei", "Segoe UI", serif',
      sample: "Aa 123",
    },
    {
      id: "harmonyos-sans",
      label: "HarmonyOS Sans SC",
      value: '"HarmonyOS Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif',
      sample: "Aa 123",
    },
    // JetBrains Mono
    {
      id: "jetbrains-mono",
      label: "JetBrains Mono",
      value: '"JetBrains Mono", "Segoe UI", "Noto Sans", Arial, sans-serif',
      sample: "Aa 123",
    },
    //Fira Code
    {
      id: "fira-code",
      label: "Fira Code",
      value: '"Fira Code", "Segoe UI", "Noto Sans", Arial, sans-serif',
      sample: "Aa 123",
    },
  ];

  const formatDateTime = (value: unknown) => {
    if (!value) return "";
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
  };

  return {
    settings,
    loaded,
    draft,
    setDraft,
    error,
    setError,
    maximized,
    activeKey,
    setActiveKey,
    newTypeExt,
    setNewTypeExt,
    onClose,
    onToggleMax,
    save,
    applyThemePreview,
    applyFontPreview,
    typeOptions,
    moveTypeId,
    defaultTypeMenuOpen,
    setDefaultTypeMenuOpen,
    defaultTypeActiveIndex,
    setDefaultTypeActiveIndex,
    defaultTypeSelectRef,
    currentDefaultTypeLabel,
    pickDefaultTypeByIndex,
    user,
    isMember,
    isRefreshingStatus,
    doRefreshStatus,
    loginForm,
    setLoginForm,
    isLoggingIn,
    loginError,
    handleLogin,
    isLoggingOut,
    handleLogout,
    toast,
    themeColors,
    themeOptions,
    fontOptions,
    formatDateTime,
  };
}
