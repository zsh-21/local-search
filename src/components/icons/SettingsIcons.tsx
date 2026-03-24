import type { ReactNode } from "react";
type IconProps = {
  size?: number;
  className?: string;
  variant?: "mono" | "duotone";
};
const ICONFONT_SPRITE = "/iconfont-icons/sprite.svg";
const C = {
  blue: "#2f88ff",
  blueDark: "#1e62d0",
  cyan: "#38d4ff",
  teal: "#1fc8aa",
  green: "#37c48f",
  orange: "#ff8a00",
  yellow: "#ffd24c",
  red: "#ef4d5b",
  rose: "#ff7c98",
  purple: "#7a6cff",
  lavender: "#a78bfa",
  gray: "#e6ebf2",
  grayMid: "#c6ced9",
  grayDark: "#7b8794",
  slate: "#4b5563",
  ink: "#253041",
  white: "#ffffff",
};
const STROKE = {
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const COLOR_ICON_TRANSFORM = "translate(12 12) scale(1.16) translate(-12 -12)";
function SvgIcon({
  size = 18,
  className,
  viewBox = "0 0 24 24",
  children,
}: {
  size?: number;
  className?: string;
  viewBox?: string;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      {children}
    </svg>
  );
}
function SpriteIcon({
  size = 18,
  className,
  symbolId,
  viewBox,
}: {
  size?: number;
  className?: string;
  symbolId: string;
  viewBox: string;
}) {
  const href = `${ICONFONT_SPRITE}#${symbolId}`;
  return (
    <SvgIcon size={size} className={className} viewBox={viewBox}>
      {/* 设置和固定按钮按产品要求继续使用原始 sprite，保证语义和旧版交互认知一致。 */}
      <use href={href} xlinkHref={href} fill="currentColor" />
    </SvgIcon>
  );
}
function ModeIcon({
  size,
  className,
  variant = "duotone",
  viewBox,
  monoChildren,
  colorChildren,
}: {
  size?: number;
  className?: string;
  variant?: "mono" | "duotone";
  viewBox?: string;
  monoChildren?: ReactNode;
  colorChildren: ReactNode;
}) {
  return (
    <SvgIcon size={size} className={className} viewBox={viewBox}>
      {variant === "mono" ? monoChildren ?? colorChildren : <g transform={COLOR_ICON_TRANSFORM}>{colorChildren}</g>}
    </SvgIcon>
  );
}
export function IconGeneral({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      monoChildren={<path d="M12 3 4 9.7v10.8c0 .8.6 1.5 1.5 1.5h4.1v-5.6h4.8V22h4.1c.8 0 1.5-.7 1.5-1.5V9.7z" fill="currentColor" />}
      colorChildren={
        <>
          <path d="M4.5 10.3 12 4l7.5 6.3-1.6 1.8L12 7.2 6.1 12.1z" fill={C.orange} />
          <path d="M6.7 10.4h10.6v8.1c0 .9-.7 1.6-1.6 1.6H8.3c-.9 0-1.6-.7-1.6-1.6z" fill={C.gray} />
          <path d="M10.1 20.1v-4.8c0-.7.6-1.3 1.3-1.3h1.3c.7 0 1.3.6 1.3 1.3v4.8z" fill={C.slate} />
          <rect x="14.4" y="12.4" width="1.7" height="3.1" rx=".5" fill={C.cyan} />
        </>
      }
    />
  );
}
export function IconSearch({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      monoChildren={
        <>
          <circle cx="10.3" cy="10.3" r="4.9" fill="none" stroke="currentColor" strokeWidth="2" {...STROKE} />
          <path d="m14.1 14.1 4.7 4.7" fill="none" stroke="currentColor" strokeWidth="2" {...STROKE} />
        </>
      }
      colorChildren={
        <>
          <circle cx="10.2" cy="10.2" r="4.9" fill={C.blue} />
          <circle cx="10.2" cy="10.2" r="2.3" fill={C.cyan} opacity=".32" />
          <circle cx="10.2" cy="10.2" r="4.9" fill="none" stroke="#8cdfff" strokeWidth=".75" />
          <path d="m14.2 14.2 4.8 4.8" fill="none" stroke={C.cyan} strokeWidth="2.4" {...STROKE} />
        </>
      }
    />
  );
}
export function IconShortcuts({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="3.2" y="6.1" width="17.6" height="11.8" rx="3" fill={C.blueDark} />
          <rect x="4.4" y="7.4" width="15.2" height="9.2" rx="2.2" fill={C.cyan} />
          <g fill={C.white} opacity=".95">
            <rect x="6.1" y="9.1" width="2.2" height="1.8" rx=".5" />
            <rect x="9.1" y="9.1" width="2.2" height="1.8" rx=".5" />
            <rect x="12.1" y="9.1" width="2.2" height="1.8" rx=".5" />
            <rect x="15.1" y="9.1" width="2.2" height="1.8" rx=".5" />
            <rect x="6.1" y="12.2" width="6.1" height="1.8" rx=".5" />
            <rect x="13.1" y="12.2" width="4.2" height="1.8" rx=".5" />
          </g>
        </>
      }
    />
  );
}
export function IconAppearance({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <path d="m14 4.3 5.6 5.6-7.3 7.3-5.6-5.6z" fill={C.grayDark} />
          <path d="m13.5 4.8 5.3 5.3" fill="none" stroke={C.gray} strokeWidth="1" {...STROKE} />
          <path d="M6.7 18.6c0-2.1 1.5-3.8 4-4.3-.6 3-2.3 5.2-5.1 5.9-.9.2-1.7-.6-1.5-1.5.2-1.2 1.3-2.3 2.6-3z" fill={C.orange} />
          <path d="M7.4 18.7c.6-.2 1.1-.6 1.4-1.1" fill="none" stroke={C.yellow} strokeWidth="1" {...STROKE} />
        </>
      }
    />
  );
}
export function IconAccount({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <circle cx="12" cy="8.1" r="4.2" fill={C.teal} />
          <path d="M5.1 19c0-3.4 3-5.9 6.9-5.9s6.9 2.5 6.9 5.9c0 1-.8 1.8-1.8 1.8H6.9c-1 0-1.8-.8-1.8-1.8z" fill={C.green} />
        </>
      }
    />
  );
}
export function IconPower({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <circle cx="12" cy="12.3" r="6.6" fill="none" stroke={C.blue} strokeWidth="2.1" />
          <path d="M12 4.6v6.1" fill="none" stroke={C.orange} strokeWidth="2.1" {...STROKE} />
          <path d="M7.8 7.4a6.7 6.7 0 0 0-1.9 4.8c0 3.4 2.7 6.1 6.1 6.1 3.3 0 6.1-2.7 6.1-6.1 0-1.9-.8-3.6-2-4.7" fill="none" stroke="#7eb6ff" strokeWidth="1.1" opacity=".5" {...STROKE} />
        </>
      }
    />
  );
}
export function IconState({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="4.2" y="4.4" width="15.6" height="15.2" rx="3.2" fill={C.blueDark} />
          <rect x="5.4" y="5.7" width="13.2" height="12.6" rx="2.4" fill="#33bfff" />
          <path d="m7.3 14.2 3-3 2.2 2 4.1-4.2" fill="none" stroke={C.white} strokeWidth="2" {...STROKE} />
          <circle cx="16.7" cy="9.1" r="1.1" fill={C.white} />
        </>
      }
    />
  );
}
export function IconHistory({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <circle cx="12" cy="12" r="7.8" fill={C.blue} />
          <path d="M12 4.2a7.8 7.8 0 0 1 7.1 4.5H4.9A7.8 7.8 0 0 1 12 4.2Z" fill={C.cyan} opacity=".55" />
          <path d="M12 4.2v15.6M4.2 12h15.6" fill="none" stroke="#9fe6ff" strokeWidth=".8" opacity=".7" />
          <circle cx="8.4" cy="15.7" r="4.2" fill={C.gray} />
          <path d="M8.4 13.5v2.3h1.8" fill="none" stroke={C.grayDark} strokeWidth="1.5" {...STROKE} />
        </>
      }
    />
  );
}
export function IconInfo({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <circle cx="12" cy="12" r="8.2" fill={C.blue} />
          <circle cx="12" cy="8" r="1.3" fill={C.white} />
          <rect x="11" y="10.5" width="2" height="6.3" rx="1" fill={C.white} />
          <circle cx="8.5" cy="7.2" r="2.1" fill={C.cyan} opacity=".28" />
        </>
      }
    />
  );
}
export function IconSettings({ size, className, variant }: IconProps) {
  void variant;
  return <SpriteIcon size={size} className={className} symbolId="l-icon-shezhi" viewBox="0 0 1024 1024" />;
}
export function IconFolder({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <path d="M3.8 8.1c0-1 .8-1.8 1.8-1.8h4l1.5 1.6h7.3c1 0 1.8.8 1.8 1.8v1H3.8z" fill="#ffbf33" />
          <path d="M3.8 10h16.4v7.1c0 1.4-1.1 2.5-2.5 2.5H6.3c-1.4 0-2.5-1.1-2.5-2.5z" fill={C.yellow} />
          <path d="M5.1 11.1h13.8" fill="none" stroke="#fff1b3" strokeWidth=".9" opacity=".7" {...STROKE} />
        </>
      }
    />
  );
}
export function IconCopyPath({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="7.5" y="5.3" width="9.4" height="11.6" rx="1.8" fill={C.lavender} />
          <rect x="5.1" y="7.4" width="9.4" height="11.6" rx="1.8" fill={C.purple} />
          <path d="M8.1 10.1h5.2M8.1 12.8h4.5M8.1 15.5h3.1" fill="none" stroke={C.white} strokeWidth="1.2" opacity=".92" {...STROKE} />
        </>
      }
    />
  );
}
export function IconOpenFolder({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <path d="M3.8 8.1c0-1 .8-1.8 1.8-1.8h4l1.5 1.6h7.3c1 0 1.8.8 1.8 1.8v1H3.8z" fill="#ffbf33" />
          <path d="M3.8 10h16.4v7.1c0 1.4-1.1 2.5-2.5 2.5H6.3c-1.4 0-2.5-1.1-2.5-2.5z" fill={C.yellow} />
          <path d="m10.3 14.8 2.1-2.1 2 2" fill="none" stroke={C.blue} strokeWidth="1.7" {...STROKE} />
          <path d="M12.4 12.7v5" fill="none" stroke={C.blue} strokeWidth="1.7" {...STROKE} />
        </>
      }
    />
  );
}
export function IconRunAsAdmin({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <path d="M12 4.2 18.5 6v5.3c0 4.1-2.5 7-6.5 8.5-4-1.5-6.5-4.4-6.5-8.5V6z" fill={C.grayMid} />
          <path d="M12 5.5 17.1 6.9v4.3c0 3.2-1.8 5.5-5.1 6.8-3.3-1.3-5.1-3.6-5.1-6.8V6.9z" fill={C.gray} />
          <path d="M12 5.5v12.5c3.3-1.3 5.1-3.6 5.1-6.8V6.9z" fill={C.white} opacity=".36" />
        </>
      }
    />
  );
}
export function IconDeleteHistory({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="7" y="8" width="10" height="11" rx="2" fill={C.red} />
          <rect x="6" y="6.1" width="12" height="2.2" rx="1.1" fill={C.rose} />
          <rect x="9.1" y="4.5" width="5.8" height="1.8" rx=".9" fill={C.rose} />
          <path d="M10 10.7v5.2M14 10.7v5.2" fill="none" stroke={C.white} strokeWidth="1.4" {...STROKE} />
        </>
      }
    />
  );
}
export function IconClear({ size, className }: IconProps) {
  return (
    <SvgIcon size={size} className={className}>
      <path d="M7.3 7.3 16.7 16.7M16.7 7.3l-9.4 9.4" fill="none" stroke="currentColor" strokeWidth="2" {...STROKE} />
    </SvgIcon>
  );
}
export function IconRefresh({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <path d="M18 9.3A6.8 6.8 0 0 0 6.7 7.2" fill="none" stroke={C.blue} strokeWidth="2" {...STROKE} />
          <path d="m6.8 7.3 3 .2-.5-3" fill="none" stroke={C.blue} strokeWidth="2" {...STROKE} />
          <path d="M6 14.7A6.8 6.8 0 0 0 17.3 17" fill="none" stroke={C.cyan} strokeWidth="2" {...STROKE} />
          <path d="m17.2 16.9-3-.2.5 3" fill="none" stroke={C.cyan} strokeWidth="2" {...STROKE} />
        </>
      }
    />
  );
}
export function IconOfficialLink({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="5" y="7.4" width="11.1" height="11.1" rx="2.3" fill="none" stroke={C.blue} strokeWidth="1.8" />
          <path d="M11 13 18.8 5.2" fill="none" stroke={C.cyan} strokeWidth="2" {...STROKE} />
          <path d="M13.4 5.2h5.4v5.4" fill="none" stroke={C.cyan} strokeWidth="2" {...STROKE} />
        </>
      }
    />
  );
}
export function IconPin({ size, className, variant }: IconProps) {
  void variant;
  return <SpriteIcon size={size} className={className} symbolId="l-icon-pin" viewBox="0 0 1028 1024" />;
}
export function IconPinOff({ size, className, variant }: IconProps) {
  void variant;
  return <SpriteIcon size={size} className={className} symbolId="l-icon-pin-off" viewBox="0 0 1024 1024" />;
}
export function IconCommand({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="3.6" y="5" width="16.8" height="14" rx="3" fill={C.ink} />
          <path d="m7.2 9 2.5 2.5L7.2 14" fill="none" stroke={C.cyan} strokeWidth="1.8" {...STROKE} />
          <path d="M11.7 14.2h4.5" fill="none" stroke={C.green} strokeWidth="1.8" {...STROKE} />
          <circle cx="6.3" cy="7.4" r=".8" fill={C.rose} />
          <circle cx="8.7" cy="7.4" r=".8" fill={C.yellow} />
          <circle cx="11.1" cy="7.4" r=".8" fill={C.green} />
        </>
      }
    />
  );
}
export function IconFile({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <path d="M7 4.3h6.6l4.2 4.1v11.3c0 1-.8 1.8-1.8 1.8H7c-1 0-1.8-.8-1.8-1.8V6.1c0-1 .8-1.8 1.8-1.8z" fill={C.gray} />
          <path d="M13.6 4.3v3.1c0 .8.6 1.4 1.4 1.4h2.8z" fill={C.blue} />
          <path d="M8.3 12h7.4M8.3 14.9h6.2M8.3 17.8h4" fill="none" stroke={C.grayDark} strokeWidth="1.2" {...STROKE} />
        </>
      }
    />
  );
}
export function IconCalc({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <rect x="5" y="3.8" width="14" height="16.4" rx="3" fill={C.purple} />
          <rect x="6.6" y="5.4" width="10.8" height="3.8" rx="1.2" fill="#d8e8ff" />
          <g fill={C.white} opacity=".92">
            <rect x="7" y="11" width="2.5" height="2.5" rx=".7" />
            <rect x="10.8" y="11" width="2.5" height="2.5" rx=".7" />
            <rect x="14.6" y="11" width="2.5" height="2.5" rx=".7" />
            <rect x="7" y="14.8" width="2.5" height="2.5" rx=".7" />
            <rect x="10.8" y="14.8" width="6.3" height="2.5" rx=".7" fill={C.cyan} />
          </g>
        </>
      }
    />
  );
}
export function IconChevronUp({ size, className, variant }: IconProps) {
  return (
    <ModeIcon
      size={size}
      className={className}
      variant={variant}
      colorChildren={
        <>
          <circle cx="12" cy="12" r="8.2" fill={C.blue} />
          <path d="m8.3 13.8 3.7-3.7 3.7 3.7" fill="none" stroke={C.white} strokeWidth="2" {...STROKE} />
        </>
      }
    />
  );
}
