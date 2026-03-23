type SearchSectionRankingProps = {
  ranking: any;
  rankingTypeRows: Array<{ key: string; label: string }>;
  rankingSignalHelp: any;
  rankingFrecencyHelp: any;
  rankingTypePriorityHelp: any;
  renderLabelWithInfo: (label: string, help: any) => React.ReactNode;
  updateRanking: (next: any) => void;
  resetRankingToDefault: () => void;
  handleNumberInputKeyDown: (e: any, options: any) => void;
};

export function SearchSectionRanking({
  ranking,
  rankingTypeRows,
  rankingSignalHelp,
  rankingFrecencyHelp,
  rankingTypePriorityHelp,
  renderLabelWithInfo,
  updateRanking,
  resetRankingToDefault,
  handleNumberInputKeyDown,
}: SearchSectionRankingProps) {
  return (
    <div className="settings-group">
      <div className="settings-group-title">结果排序</div>
      <div className="settings-hint">调整静态匹配、Frecency 与类型优先级，保存时信号权重会自动归一化到总和 100。</div>

      <div className="form-row">
        <div className="form-label">{renderLabelWithInfo("匹配度权重", rankingSignalHelp.match)}</div>
        <input
          type="text"
          className="text-input"
          inputMode="decimal"
          value={String(ranking.signalWeights.match)}
          onChange={(e) => {
            const n = Number(e.target.value.trim());
            if (!Number.isFinite(n)) return;
            updateRanking({
              ...ranking,
              signalWeights: { ...ranking.signalWeights, match: Math.max(0, n) },
            });
          }}
          onKeyDown={(e) =>
            handleNumberInputKeyDown(e, {
              min: 0,
              integer: false,
              step: 0.1,
              fallbackValue: ranking.signalWeights.match,
              onValueChange: (nextValue: number) =>
                updateRanking({
                  ...ranking,
                  signalWeights: { ...ranking.signalWeights, match: Math.max(0, nextValue) },
                }),
            })
          }
        />
      </div>

      <div className="form-row">
        <div className="form-label">{renderLabelWithInfo("频率权重", rankingSignalHelp.frequency)}</div>
        <input
          type="text"
          className="text-input"
          inputMode="decimal"
          value={String(ranking.signalWeights.frequency)}
          onChange={(e) => {
            const n = Number(e.target.value.trim());
            if (!Number.isFinite(n)) return;
            updateRanking({
              ...ranking,
              signalWeights: { ...ranking.signalWeights, frequency: Math.max(0, n) },
            });
          }}
          onKeyDown={(e) =>
            handleNumberInputKeyDown(e, {
              min: 0,
              integer: false,
              step: 0.1,
              fallbackValue: ranking.signalWeights.frequency,
              onValueChange: (nextValue: number) =>
                updateRanking({
                  ...ranking,
                  signalWeights: { ...ranking.signalWeights, frequency: Math.max(0, nextValue) },
                }),
            })
          }
        />
      </div>

      <div className="form-row">
        <div className="form-label">{renderLabelWithInfo("最近时间权重", rankingSignalHelp.recency)}</div>
        <input
          type="text"
          className="text-input"
          inputMode="decimal"
          value={String(ranking.signalWeights.recency)}
          onChange={(e) => {
            const n = Number(e.target.value.trim());
            if (!Number.isFinite(n)) return;
            updateRanking({
              ...ranking,
              signalWeights: { ...ranking.signalWeights, recency: Math.max(0, n) },
            });
          }}
          onKeyDown={(e) =>
            handleNumberInputKeyDown(e, {
              min: 0,
              integer: false,
              step: 0.1,
              fallbackValue: ranking.signalWeights.recency,
              onValueChange: (nextValue: number) =>
                updateRanking({
                  ...ranking,
                  signalWeights: { ...ranking.signalWeights, recency: Math.max(0, nextValue) },
                }),
            })
          }
        />
      </div>

      <div className="form-row">
        <div className="form-label">{renderLabelWithInfo("文件时间权重", rankingSignalHelp.fileMtime)}</div>
        <input
          type="text"
          className="text-input"
          inputMode="decimal"
          value={String(ranking.signalWeights.fileMtime)}
          onChange={(e) => {
            const n = Number(e.target.value.trim());
            if (!Number.isFinite(n)) return;
            updateRanking({
              ...ranking,
              signalWeights: { ...ranking.signalWeights, fileMtime: Math.max(0, n) },
            });
          }}
          onKeyDown={(e) =>
            handleNumberInputKeyDown(e, {
              min: 0,
              integer: false,
              step: 0.1,
              fallbackValue: ranking.signalWeights.fileMtime,
              onValueChange: (nextValue: number) =>
                updateRanking({
                  ...ranking,
                  signalWeights: { ...ranking.signalWeights, fileMtime: Math.max(0, nextValue) },
                }),
            })
          }
        />
      </div>

      <div className="form-row">
        <div className="form-label">{renderLabelWithInfo("衰减因子", rankingFrecencyHelp.decayFactor)}</div>
        <input
          type="text"
          className="text-input"
          inputMode="decimal"
          value={String(ranking.frecency.decayFactor)}
          onChange={(e) => {
            const n = Number(e.target.value.trim());
            if (!Number.isFinite(n)) return;
            updateRanking({
              ...ranking,
              frecency: { ...ranking.frecency, decayFactor: n },
            });
          }}
          onKeyDown={(e) =>
            handleNumberInputKeyDown(e, {
              min: 0.0001,
              max: 1,
              integer: false,
              step: 0.1,
              fallbackValue: ranking.frecency.decayFactor,
              onValueChange: (nextValue: number) =>
                updateRanking({
                  ...ranking,
                  frecency: { ...ranking.frecency, decayFactor: nextValue },
                }),
            })
          }
        />
      </div>

      <div className="form-row">
        <div className="form-label">{renderLabelWithInfo("频率放大", rankingFrecencyHelp.frequencyWeight)}</div>
        <input
          type="text"
          className="text-input"
          inputMode="decimal"
          value={String(ranking.frecency.frequencyWeight)}
          onChange={(e) => {
            const n = Number(e.target.value.trim());
            if (!Number.isFinite(n)) return;
            updateRanking({
              ...ranking,
              frecency: { ...ranking.frecency, frequencyWeight: n },
            });
          }}
          onKeyDown={(e) =>
            handleNumberInputKeyDown(e, {
              min: 0,
              max: 10,
              integer: false,
              step: 0.1,
              fallbackValue: ranking.frecency.frequencyWeight,
              onValueChange: (nextValue: number) =>
                updateRanking({
                  ...ranking,
                  frecency: { ...ranking.frecency, frequencyWeight: nextValue },
                }),
            })
          }
        />
      </div>

      <div className="settings-hint ranking-type-hint">
        {renderLabelWithInfo("类型优先级（1-10，数值越大越优先）", rankingTypePriorityHelp)}
      </div>

      <div className="action-config-list">
        {rankingTypeRows.map((row) => (
          <div key={row.key} className="action-config-row checked">
            <div className="action-config-left">
              <span className="action-config-label">{row.label}</span>
            </div>
            <div className="action-config-right" style={{ minWidth: 140 }}>
              <input
                type="text"
                className="text-input"
                inputMode="numeric"
                value={String(ranking.typePriority[row.key])}
                onChange={(e) => {
                  const n = Number(e.target.value.trim());
                  if (!Number.isFinite(n)) return;
                  updateRanking({
                    ...ranking,
                    typePriority: { ...ranking.typePriority, [row.key]: n },
                  });
                }}
                onKeyDown={(e) =>
                  handleNumberInputKeyDown(e, {
                    min: 1,
                    max: 10,
                    integer: true,
                    step: 1,
                    fallbackValue: ranking.typePriority[row.key],
                    onValueChange: (nextValue: number) =>
                      updateRanking({
                        ...ranking,
                        typePriority: { ...ranking.typePriority, [row.key]: nextValue },
                      }),
                  })
                }
              />
            </div>
          </div>
        ))}
      </div>

      <div className="form-row">
        <div className="form-label">恢复默认</div>
        <button type="button" className="small-btn ghost" onClick={resetRankingToDefault}>
          重置排序参数
        </button>
      </div>
    </div>
  );
}
