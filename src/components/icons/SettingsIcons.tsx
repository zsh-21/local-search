import type { ReactNode } from "react";

type IconProps = {
  size?: number;
  className?: string;
  // 图标渲染变体：
  // - mono：单色（用于搜索面板，保持克制不花哨）
  // - duotone：双色叠层（用于设置界面，增强层次感但不引入复杂多色 SVG）
  variant?: "mono" | "duotone";
};

const ICONFONT_SPRITE = "/iconfont-icons/sprite.svg";

type BaseIconProps = IconProps & {
  symbolId: string;
  viewBox?: string;
  children?: ReactNode;
};

function BaseIcon({
  size = 18,
  className,
  symbolId,
  viewBox,
  children,
  variant = "mono",
}: BaseIconProps) {
  const href = `${ICONFONT_SPRITE}#${symbolId}`;
  const isDuotone = variant === "duotone";

  return (
    <svg
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      // 统一补默认 viewBox：避免某些图标在不同容器里因缺省 viewBox 而出现缩放不一致。
      viewBox={viewBox || "0 0 1024 1024"}
      style={{
        display: "block",
        // 颜色完全交给 CSS 控制（currentColor）：
        // 1) 设置页/搜索页跟随主题的 --fs-muted/--fs-accent；
        // 2) 搜索面板图标更克制，不再被“每个图标固定颜色”打散风格。
        fill: "currentColor",
        stroke: "none",
        flex: "0 0 auto",
      }}
    >
      {isDuotone ? (
        <>
          {/* 双色底层：用轻微位移 + 半透明形成第二层颜色，增强设置界面的层次感。 */}
          <use
            href={href}
            xlinkHref={href}
            style={{
              // 次色默认取强调色与 muted 的混合：保证亮/暗主题下都能看见两种颜色。
              color: "var(--fs-icon-duotone-secondary, color-mix(in srgb, var(--fs-accent) 62%, var(--fs-muted) 38%))",
              opacity: 0.62,
              transform: "translate(1px, 1px)",
              transformOrigin: "center",
            }}
          />
          {/* 主色：继续跟随 currentColor（由容器 CSS 控制 muted/active）。 */}
          <use href={href} xlinkHref={href} style={{ color: "currentColor" }} />
        </>
      ) : (
        <use href={href} xlinkHref={href} style={{ color: "currentColor" }} />
      )}
      {children}
    </svg>
  );
}

// 通用页签图标：使用语义清晰的单色图标，颜色由导航栏 CSS 控制（默认 muted，选中态 accent）。
export function IconGeneral(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-jichu" />;
}

// 搜索页与搜索框图标：搜索面板强调“不过度花哨”，因此统一用 currentColor 渲染。
export function IconSearch(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-sousuo" />;
}

// 快捷键/流程相关图标：用更直观的“快捷键/键盘”语义图标替换旧图标。
export function IconShortcuts(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-liucheng" />;
}

// 外观页图标：统一风格为单色，避免不同页面出现“彩色图标系统”的割裂感。
export function IconAppearance(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-shaixuan" />;
}

// 账号/用户类图标：形状识别优先，颜色交给 CSS。
export function IconAccount(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-renyuan1" />;
}

// 启停/状态类图标：替换为真正的“电源/开关”图标，避免语义误导。
export function IconPower(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-zhongzhi" />;
}

// 状态趋势或最近使用相关图标：保留折线图样式，适合状态类说明。
export function IconState(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-quxian" />;
}

// 历史/版本类图标：用历史/时间语义图标，颜色交给 CSS（保持统一）。
export function IconHistory(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-banben" />;
}

// 通用说明信息图标：在设置页内用于“提示/说明”场景，保留清晰的青色。
export function IconInfo(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-jichuxinxi" />;
}

// 设置页和搜索结果里的设置入口图标：统一使用同一套彩色资源，减少页面间视觉割裂。
export function IconSettings(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-shezhi" />;
}

// 文件夹/结果列表图标：用明确的文件夹图标替换旧的“报告”占位，提升语义直觉。
export function IconFolder(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-folder" />;
}

// 路径复制图标：替换为真正的“复制”图标，降低学习成本。
export function IconCopyPath(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-copy" />;
}

// 打开所在目录图标：用“打开文件夹”图标表达动作差异，避免与普通文件夹混淆。
export function IconOpenFolder(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-folder-open" />;
}

// 管理员运行图标：用“盾牌”表达权限/安全语义，避免与“辅助”概念混在一起。
export function IconRunAsAdmin(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-shield" />;
}

// 删除历史图标：保留警示感更强的红色，避免误操作。
export function IconDeleteHistory(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-trash" />;
}

// 清空输入图标：用“清空/关闭”图标表达更直接（和搜索框右侧动作一致）。
export function IconClear(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-clear" />;
}

// 刷新图标：用于账号状态刷新，保留明显的蓝色旋转语义。
export function IconRefresh(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-refresh" />;
}

// 官方链接图标：用于“访问官网”按钮，保留清晰的外链提示。
export function IconOfficialLink(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-link" />;
}

// 固定窗口图标：替换为“钉住”图标，更符合“面板固定”的心智模型。
export function IconPin(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-pin" />;
}

// 取消固定：与“固定”使用同一个图标，通过按钮的 active 样式（高亮/取消高亮）来表达状态。
// 这样可以保证两态图标视觉完全一致，用户只需要看颜色即可判断当前是否固定。
export function IconPinOff(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-pin" />;
}

// 命令行/终端图标：用于设置页“命令”类型预览，替换内联 SVG，保证风格统一。
export function IconCommand(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-command" />;
}

// 通用文件图标：用于少数“占位/回退”场景，避免继续内联 SVG。
export function IconFile(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-file" />;
}

// 计算器图标：用于搜索面板“计算”回退展示，避免继续内联 SVG。
export function IconCalc(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-calc" />;
}

// 向上箭头：用于“回到顶部”按钮，替换内联 SVG，统一用 iconfont sprite 管理。
export function IconChevronUp(props: IconProps) {
  return <BaseIcon {...props} symbolId="l-icon-chevron-up" />;
}
