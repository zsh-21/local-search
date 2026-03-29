import type { JSX } from "react";
import type { SettingsTabKey, useSettingsController } from "./useSettingsController";

/** 设置页控制器类型 */
export type SettingsController = ReturnType<typeof useSettingsController>;

/** 设置侧栏导航项 */
export type SettingsNavItem = {
  key: Exclude<SettingsTabKey, "account">;
  label: string;
  icon: JSX.Element;
};

/** 分区标题元信息 */
export type SettingsSectionMeta = {
  title: string;
  desc: string;
};
