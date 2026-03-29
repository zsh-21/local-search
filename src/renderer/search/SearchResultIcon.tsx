import type { AppItem } from "../appTypes";
import {
  IconCalc,
  IconFile,
  IconFolder,
  IconSettings,
} from "../components/icons/SettingsIcons";

/** 可识别为图片预览的扩展名集合 */
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "ico", "svg"]);

/** 判断路径是否为图片文件 */
function isImageFilePath(targetPath: string) {
  const ext = (targetPath.split(".").pop() || "").toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** 组合图标样式类名 */
function buildIconClassName(icon: string | undefined, extra?: string) {
  const classes = ["result-icon"];
  if (extra) classes.push(extra);
  if (icon && icon.startsWith("data:image/svg+xml")) classes.push("svg-icon");
  return classes.join(" ");
}

/** 判断条目是否属于计算器结果 */
function isCalcLikeItem(item: AppItem, isCalcMode: boolean) {
  if (item.type === "calc") return true;
  if (!isCalcMode) return false;
  const candidates = [item.description, item.path, item.name];
  return candidates.some((text) => typeof text === "string" && text.trim().startsWith("="));
}

/** 统一渲染结果左侧图标 */
export function SearchResultIcon(props: {
  item: AppItem;
  isCalcMode: boolean;
  calculatorIconDataUrl: string;
  iconByKey: Record<string, string>;
}) {
  const { item, isCalcMode, calculatorIconDataUrl, iconByKey } = props;
  const iconData =
    (typeof item.iconKey === "string" && item.iconKey ? iconByKey[item.iconKey.toLowerCase()] : "") ||
    item.icon ||
    "";

  if (isCalcLikeItem(item, isCalcMode)) {
    if (calculatorIconDataUrl) {
      return <img className={buildIconClassName(calculatorIconDataUrl)} src={calculatorIconDataUrl} alt="" />;
    }
    return <IconCalc size={40} className="result-icon" />;
  }

  if (item.type === "folder") return <IconFolder size={40} className="result-icon" />;
  if (item.type === "app") {
    if (!iconData) return <span className="result-icon placeholder fallback-icon fallback-app-icon" aria-hidden="true" />;
    return <img className={buildIconClassName(iconData)} src={iconData} alt="" />;
  }
  if (item.type === "settings") return <IconSettings size={40} className="result-icon" />;
  if (item.type === "file") {
    if (iconData && isImageFilePath(item.path || "")) return <img className="result-icon image-preview" src={iconData} alt="" />;
    if (iconData) return <img className={buildIconClassName(iconData)} src={iconData} alt="" />;
    return <IconFile size={40} className="result-icon" />;
  }
  return <span className="result-icon placeholder fallback-icon fallback-generic-icon" aria-hidden="true" />;
}
