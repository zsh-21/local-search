import type { ReactNode } from "react";
import type { NumberInputKeydownHandler } from "./searchSectionSharedTypes";

/** 排序参数数字输入行 */
export function SearchSectionRankingNumericRow(props: {
  label: ReactNode;
  value: number;
  min: number;
  max?: number;
  step: number;
  integer: boolean;
  handleNumberInputKeyDown: NumberInputKeydownHandler;
  onValueChange: (nextValue: number) => void;
}) {
  return (
    <div className="form-row">
      <div className="form-label">{props.label}</div>
      <input
        type="text"
        className="text-input"
        inputMode={props.integer ? "numeric" : "decimal"}
        value={String(props.value)}
        onChange={(e) => {
          const n = Number(e.target.value.trim());
          if (!Number.isFinite(n)) return;
          props.onValueChange(n);
        }}
        onKeyDown={(e) =>
          props.handleNumberInputKeyDown(e, {
            min: props.min,
            max: props.max,
            integer: props.integer,
            step: props.step,
            fallbackValue: props.value,
            onValueChange: props.onValueChange,
          })
        }
      />
    </div>
  );
}
