import { SettingsViewImpl } from "./settings/SettingsViewImpl";

// 入口组件：保持对外导出路径稳定，内部实现拆分到 settings 目录
export function SettingsView() {
  return <SettingsViewImpl />;
}
