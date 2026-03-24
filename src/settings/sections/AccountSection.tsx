import { useEffect, useRef, useState } from "react";
import { AppSettings } from "../../appTypes";
import { getStoredTokenFromLocalStorage } from "../../membership";
import { User } from "../../api";
import { THEME_STYLE_OPTIONS } from "../../constants/initialValues";
import { IconRefresh } from "../../components/icons/SettingsIcons";

// 账号分区：登录/退出、会员状态展示、刷新状态入口
export function AccountSection({
  user,
  isMember,
  draft,
  setDraft,
  setError,
  isRefreshingStatus,
  doRefreshStatus,
  isLoggingOut,
  handleLogout,
  loginForm,
  setLoginForm,
  isLoggingIn,
  loginError,
  handleLogin,
  formatDateTime,
}: {
  user: User | null;
  isMember: boolean;
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  isRefreshingStatus: boolean;
  doRefreshStatus: () => void;
  isLoggingOut: boolean;
  handleLogout: () => void;
  loginForm: { account: string; password: string };
  setLoginForm: (v: { account: string; password: string }) => void;
  isLoggingIn: boolean;
  loginError: string;
  handleLogin: (e: React.FormEvent) => void | Promise<void>;
  formatDateTime: (v: unknown) => string;
}) {
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const themeLabelMap = new Map(THEME_STYLE_OPTIONS.map((item) => [item.id, item.label]));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarDataUrl, setAvatarDataUrl] = useState("");
  const requestIdRef = useRef(0);
  const avatarRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 头像展示使用 dataUrl：避免直接使用 file:// 导致渲染侧加载失败或跨域限制
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const p = typeof draft.customAvatarPath === "string" ? draft.customAvatarPath.trim() : "";
    if (!p) {
      setAvatarDataUrl("");
      return;
    }
    window.ipcRenderer
      ?.invoke("get-image-data-url", p)
      .then((resp: any) => {
        if (requestIdRef.current !== requestId) return;
        if (resp?.ok && typeof resp.dataUrl === "string") setAvatarDataUrl(resp.dataUrl);
      })
      .catch(() => {});
  }, [draft.customAvatarPath]);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    // 点击头像以外区域关闭弹层：符合“点击空白处关闭”的交互预期
    const onMouseDown = (e: MouseEvent) => {
      const el = avatarRootRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      setAvatarMenuOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [avatarMenuOpen]);

  const getRemainingTimeText = (expiresAt?: string) => {
    if (!expiresAt) return "";
    const end = new Date(expiresAt).getTime();
    const now = Date.now();
    const diff = end - now;
    if (diff <= 0) return "";
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    return `${days}天${hours}小时`;
  };

  return (
    <div className="settings-content">
      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">账号信息</div>
        {/* 账号分区补充说明，清晰交代登录与会员信息的展示范围。 */}
        <div className="settings-hint">展示登录状态、会员到期信息与头像设置入口。</div>
        {user ? (
          <div className="account-profile">
            <div className="profile-header">
              <div ref={avatarRootRef} style={{ position: "relative" }}>
                <button
                  type="button"
                  className="avatar-placeholder"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // 点击头像弹出“自定义头像”操作框：选择本地图片/取消自定义
                    setAvatarMenuOpen((v) => !v);
                  }}
                  aria-label="头像设置"
                  title="自定义头像"
                >
                  {avatarDataUrl ? (
                    <img className="avatar-img" src={avatarDataUrl} alt="" />
                  ) : (
                    user.avatarText || user.nickname?.slice(0, 1).toUpperCase()
                  )}
                </button>
                {avatarMenuOpen ? (
                  <div className="avatar-menu" onMouseDown={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="small-btn"
                      onClick={async () => {
                        // 通过主进程弹出文件选择：与“背景图片选择”保持一致
                        setError("");
                        const resp = (await window.ipcRenderer?.invoke("select-avatar-image")) as
                          | { ok: boolean; path?: string; message?: string }
                          | undefined;
                        if (!resp?.ok) {
                          setError(resp?.message || "选择图片失败");
                          return;
                        }
                        const p = typeof resp.path === "string" ? resp.path : "";
                        if (!p) {
                          setAvatarMenuOpen(false);
                          return;
                        }
                        setDraft({ ...draft, customAvatarPath: p });
                        setAvatarMenuOpen(false);
                      }}
                    >
                      选择本地图片
                    </button>
                    <button
                      type="button"
                      className="small-btn ghost"
                      disabled={!draft.customAvatarPath}
                      onClick={() => {
                        // 取消自定义头像：回落到原有“文字头像/默认逻辑”
                        setDraft({ ...draft, customAvatarPath: "" });
                        setAvatarMenuOpen(false);
                        setError("");
                      }}
                    >
                      取消自定义
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} />
                  </div>
                ) : null}
              </div>
              <div className="profile-info">
                <div className="profile-name">{user.nickname || user.phone || user.email}</div>
                <div className="profile-status-row">
                  <div className="profile-status">已登录</div>
                </div>
              </div>
              <button
                type="button"
                className="profile-refresh-btn"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void doRefreshStatus();
                }}
                disabled={!getStoredTokenFromLocalStorage() || isRefreshingStatus}
                aria-label="刷新状态"
                title="刷新状态"
              >
                {/* 刷新按钮复用统一图标，状态动画仍由现有 spin 样式控制。 */}
                {/* 刷新图标使用双色叠层：与设置页其他图标保持统一；旋转动画仍由 className 控制。 */}
                <IconRefresh size={22} variant="duotone" className={isRefreshingStatus ? "spin-anim" : ""} />
              </button>
            </div>

            <div className="account-details">
              <div className="account-detail-row">
                <div className="account-detail-key">会员状态</div>
                <div className="account-detail-val">
                  {isMember ? (
                    <>
                      {isMember && (
                        <div className="profile-vip-tag">
                          {user.plan === "trial" ? "试用中" : "已订阅"}
                        </div>
                      )}
                      {user.memberExpiresAt && (
                        <span className="vip-remaining-time" style={{ marginLeft: 8, fontSize: 13, opacity: 0.8 }}>
                          还剩 {getRemainingTimeText(user.memberExpiresAt)}
                        </span>
                      )}
                    </>
                  ) : (
                    "非会员/已过期"
                  )}
                </div>
              </div>
              {user.phone ? (
                <div className="account-detail-row">
                  <div className="account-detail-key">手机号</div>
                  <div className="account-detail-val">{user.phone}</div>
                </div>
              ) : null}
              {user.email ? (
                <div className="account-detail-row">
                  <div className="account-detail-key">邮箱</div>
                  <div className="account-detail-val">{user.email}</div>
                </div>
              ) : null}
              {formatDateTime(user.createdAt) ? (
                <div className="account-detail-row">
                  <div className="account-detail-key">创建时间</div>
                  <div className="account-detail-val">{formatDateTime(user.createdAt)}</div>
                </div>
              ) : null}
              {user.memberExpiresAt ? (
                <div className="account-detail-row">
                  <div className="account-detail-key">会员到期</div>
                  <div className="account-detail-val">{formatDateTime(user.memberExpiresAt)}</div>
                </div>
              ) : null}
              {draft.theme ? (
                <div className="account-detail-row">
                  <div className="account-detail-key">主题模式</div>
                  <div className="account-detail-val">{themeLabelMap.get(draft.theme) || draft.theme}</div>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="settings-cancel logout-btn"
              onClick={handleLogout}
              disabled={isLoggingOut}
            >
              {isLoggingOut ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" />
                  退出中...
                </>
              ) : (
                "退出登录"
              )}
            </button>
          </div>
        ) : (
          <form className="login-form" onSubmit={handleLogin}>
            <div className="form-row">
              <div className="form-label">账号</div>
              <input
                type="text"
                className="text-input"
                value={loginForm.account}
                onChange={(e) => setLoginForm({ ...loginForm, account: e.target.value })}
                placeholder="请输入手机号/邮箱/昵称"
              />
            </div>
            <div className="form-row">
              <div className="form-label">密码</div>
              <input
                type="password"
                className="text-input"
                value={loginForm.password}
                onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                placeholder="请输入密码"
              />
            </div>
            {loginError && <div className="settings-error">{loginError}</div>}
            <div className="form-actions">
              <button
                type="submit"
                className="settings-confirm login-btn"
                disabled={isLoggingIn}
              >
                {isLoggingIn ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    登录中...
                  </>
                ) : (
                  "登录"
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
