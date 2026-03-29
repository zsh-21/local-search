import {
  FS_LAST_LOGIN_ACCOUNT_KEY,
  FS_LAST_LOGIN_PASSWORD_KEY,
} from "../constants/initialValues";

/** 字体选项结构 */
type FontOption = {
  id: string;
  label: string;
  value: string;
  sample: string;
};

/** 最近一次登录账号存储键 */
export const LAST_LOGIN_ACCOUNT_KEY = FS_LAST_LOGIN_ACCOUNT_KEY;

/** 最近一次登录密码存储键 */
export const LAST_LOGIN_PASSWORD_KEY = FS_LAST_LOGIN_PASSWORD_KEY;

/** 读取最近一次登录账号 */
export function getLastLoginAccount() {
  try {
    return localStorage.getItem(LAST_LOGIN_ACCOUNT_KEY) || "";
  } catch {
    return "";
  }
}

/** 读取最近一次登录密码 */
export function getLastLoginPassword() {
  try {
    return localStorage.getItem(LAST_LOGIN_PASSWORD_KEY) || "";
  } catch {
    return "";
  }
}

/** 设置页可选字体列表 */
export const SETTINGS_FONT_OPTIONS: FontOption[] = [
  {
    id: "microsoft-yahei",
    label: "Microsoft YaHei",
    value: '"Microsoft YaHei", "Segoe UI", "Noto Sans", Arial, sans-serif',
    sample: "Aa 123",
  },
  {
    id: "segoe-ui",
    label: "Segoe UI",
    value: '"Segoe UI", "Segoe UI Variable", "SegoeUI", "Noto Sans", "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
    sample: "Aa 123",
  },
  {
    id: "pingfang-sc",
    label: "PingFang SC",
    value: '"PingFang SC", "Microsoft YaHei", "Segoe UI", Arial, sans-serif',
    sample: "Aa 123",
  },
  {
    id: "arial",
    label: "Arial",
    value: 'Arial, "Segoe UI", sans-serif',
    sample: "Aa 123",
  },
  {
    id: "microsoft-yahei-ui",
    label: "Microsoft YaHei UI",
    value: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif',
    sample: "Aa 123",
  },
  {
    id: "simsun",
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
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    value: '"JetBrains Mono", "Segoe UI", "Noto Sans", Arial, sans-serif',
    sample: "Aa 123",
  },
  {
    id: "fira-code",
    label: "Fira Code",
    value: '"Fira Code", "Segoe UI", "Noto Sans", Arial, sans-serif',
    sample: "Aa 123",
  },
];
