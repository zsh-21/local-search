import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number;
};

function BaseIcon({ size = 18, children, viewBox = "0 0 24 24", ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

// 设置导航图标：统一放到独立目录，避免业务组件内堆叠大段 SVG。
export function IconGeneral(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.2v2.1m0 13.4v2.1M3.2 12h2.1m13.4 0h2.1M5.8 5.8l1.5 1.5m9.4 9.4 1.5 1.5m0-12.4-1.5 1.5m-9.4 9.4-1.5 1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconShortcuts(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="3.5" y="6" width="17" height="12" rx="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.8 10.4h2.5m3.1 0h2.5M7.8 13.9h8.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconAppearance(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5A6.2 6.2 0 0 1 12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </BaseIcon>
  );
}

export function IconAccount(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="8" r="3.3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 20a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconPower(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3.5v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6.7 6.8a7.5 7.5 0 1 0 10.6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconState(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4.5 6.5h15m-15 5h15m-15 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconHistory(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4.5 4.6v4h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8.5v4l2.8 1.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </BaseIcon>
  );
}

export function IconPin(props: IconProps) {
  return (
    <BaseIcon {...props} viewBox="0 0 1024 1024">
      <path d="M405.333333 430.933333l136.533334-136.533333-29.866667-29.866667L605.866667 170.666667l273.066666 273.066666-89.6 89.6-29.866666-29.866666-140.8 136.533333 59.733333 59.733333-89.6 89.6L256 460.8l89.6-89.6 59.733333 59.733333z m-89.6 29.866667l273.066667 273.066667 29.866667-29.866667-59.733334-64 200.533334-200.533333 29.866666 29.866666 29.866667-29.866666-209.066667-209.066667-29.866666 29.866667 29.866666 29.866666-200.533333 200.533334-59.733333-59.733334-34.133334 29.866667z m55.466667 192l29.866667 29.866667-200.533334 200.533333-29.866666-34.133333 200.533333-196.266667z" fill="currentColor"></path>
    </BaseIcon>
  );
}

export function IconPinOff(props: IconProps) {
  return (
    <BaseIcon {...props} viewBox="0 0 1024 1024">
      <path d="M405.333333 430.933333l136.533334-136.533333-29.866667-29.866667L605.866667 170.666667l273.066666 273.066666-89.6 89.6-29.866666-29.866666-140.8 136.533333 59.733333 59.733333-89.6 89.6L256 460.8l89.6-89.6 59.733333 59.733333z m-89.6 29.866667l273.066667 273.066667 29.866667-29.866667-59.733334-64 200.533334-200.533333 29.866666 29.866666 29.866667-29.866666-209.066667-209.066667-29.866666 29.866667 29.866666 29.866666-200.533333 200.533334-59.733333-59.733334-34.133334 29.866667z m55.466667 192l29.866667 29.866667-200.533334 200.533333-29.866666-34.133333 200.533333-196.266667z" fill="currentColor"></path>
      <path   stroke="currentColor" strokeWidth="80" strokeLinecap="round"></path>
    </BaseIcon>
  );
}

