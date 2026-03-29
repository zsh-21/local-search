import type { AppSettings } from "../../../appTypes";
import type { NumberInputKeydownHandler } from "./searchSectionSharedTypes";

/** 类型优先级列表 */
export function SearchSectionRankingTypePriorityList(props: {
  ranking: AppSettings["searchRanking"];
  rankingTypeRows: Array<{
    key: Exclude<keyof AppSettings["searchRanking"]["typePriority"], "web" | "plugin">;
    label: string;
  }>;
  updateRanking: (next: AppSettings["searchRanking"]) => void;
  handleNumberInputKeyDown: NumberInputKeydownHandler;
}) {
  return (
    <div className="action-config-list">
      {props.rankingTypeRows.map((row) => (
        <div key={row.key} className="action-config-row checked">
          <div className="action-config-left">
            <span className="action-config-label">{row.label}</span>
          </div>
          <div className="action-config-right" style={{ minWidth: 140 }}>
            <input
              type="text"
              className="text-input"
              inputMode="numeric"
              value={String(props.ranking.typePriority[row.key])}
              onChange={(e) => {
                const n = Number(e.target.value.trim());
                if (!Number.isFinite(n)) return;
                props.updateRanking({
                  ...props.ranking,
                  typePriority: { ...props.ranking.typePriority, [row.key]: n },
                });
              }}
              onKeyDown={(e) =>
                props.handleNumberInputKeyDown(e, {
                  min: 1,
                  max: 10,
                  integer: true,
                  step: 1,
                  fallbackValue: props.ranking.typePriority[row.key],
                  onValueChange: (nextValue: number) =>
                    props.updateRanking({
                      ...props.ranking,
                      typePriority: { ...props.ranking.typePriority, [row.key]: nextValue },
                    }),
                })
              }
            />
          </div>
        </div>
      ))}
    </div>
  );
}
