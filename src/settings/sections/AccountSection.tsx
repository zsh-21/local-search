import { AppSettings } from "../../appTypes";
import { getStoredTokenFromLocalStorage } from "../../membership";
import { User } from "../../api";

// 账号分区：登录/退出、会员状态展示、刷新状态入口
export function AccountSection({
  user,
  isMember,
  draft,
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
  return (
    <div className="settings-content">
      <div className="settings-group">
        <div className="settings-group-title">账号信息</div>
        {user ? (
          <div className="account-profile">
            <div className="profile-header">
              <div className="avatar-placeholder">
                {user.avatarText || user.nickname?.slice(0, 1).toUpperCase()}
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
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  className={isRefreshingStatus ? "spin-anim" : ""}
                >
                  <path
                    d="M20 12a8 8 0 1 1-2.34-5.66"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                  <path
                    d="M20 4v6h-6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div className="account-details">
              <div className="account-detail-row">
                <div className="account-detail-key">会员状态</div>
                <div className="account-detail-val">
                  {isMember ? (
                    <>
                      {isMember && <div className="profile-vip-tag">已订阅</div>}
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
                  <div className="account-detail-val">{draft.theme}</div>
                </div>
              ) : null}
              {draft.accentColor ? (
                <div className="account-detail-row">
                  <div className="account-detail-key">主题色</div>
                  <div className="account-detail-val">
                    <span
                      className="account-color-swatch"
                      style={{ background: draft.accentColor }}
                      aria-hidden="true"
                    />
                    <span className="account-color-text">{draft.accentColor}</span>
                  </div>
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
