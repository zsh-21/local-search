export type MembershipControlledFeatureKey =
  | "themeColor"
  | "defaultSearchType"
  | "customSuffix"
  | "searchTypeOrder";

export type MembershipControlledFeature = {
  key: MembershipControlledFeatureKey;
  label: string;
  description: string;
};

// 会员管控功能配置：加入这里的功能在非会员时需要关闭/置灰
export const MEMBERSHIP_CONTROLLED_FEATURES: MembershipControlledFeature[] = [
  {
    key: "themeColor",
    label: "主题颜色设置",
    description: "设置主题色（Accent Color）",
  },
  {
    key: "defaultSearchType",
    label: "默认类型的指定",
    description: "设置默认搜索类型（例如：所有文件/文件/自定义类型）",
  },
  {
    key: "customSuffix",
    label: "自定义新增后缀",
    description: "新增自定义后缀类型（例如：.docx）",
  },
  {
    key: "searchTypeOrder",
    label: "类型顺序调整",
    description: "调整搜索类型在主界面的展示顺序",
  },
];
