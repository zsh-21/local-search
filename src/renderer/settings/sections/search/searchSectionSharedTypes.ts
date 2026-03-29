import type { KeyboardEvent, ReactNode } from "react";
import type { AppSettings } from "../../../appTypes";
import type { NumericStepOptions } from "../../numericInputStepper";

/** 搜索分区提示浮层载荷 */
export type TooltipPayload = {
  kind: "plain" | "info";
  text: string;
  example?: string;
  left: number;
  top: number;
  placement: "top" | "bottom";
  anchor: { left: number; right: number; top: number; bottom: number };
  arrowLeft: number;
};

/** 排序信号键 */
export type RankingSignalKey = keyof AppSettings["searchRanking"]["signalWeights"];

/** Frecency 键 */
export type RankingFrecencyKey = keyof AppSettings["searchRanking"]["frecency"];

/** 排序字段说明 */
export type RankingFieldHelp = {
  title: string;
  text: string;
  example: string;
};

/** 数字输入键盘步进处理器 */
export type NumberInputKeydownHandler = (
  event: KeyboardEvent<HTMLInputElement>,
  options: NumericStepOptions,
) => void;

/** 标题 + 信息图标渲染函数 */
export type LabelWithInfoRenderer = (label: string, help: RankingFieldHelp) => ReactNode;
