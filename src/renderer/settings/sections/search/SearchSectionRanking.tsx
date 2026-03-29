import type { AppSettings } from "../../../appTypes";
import type {
  LabelWithInfoRenderer,
  NumberInputKeydownHandler,
  RankingFieldHelp,
  RankingFrecencyKey,
  RankingSignalKey,
} from "./searchSectionSharedTypes";
import { SearchSectionRankingNumericRow } from "./SearchSectionRankingNumericRow";
import { SearchSectionRankingTypePriorityList } from "./SearchSectionRankingTypePriorityList";

type SearchSectionRankingProps = {
  ranking: AppSettings["searchRanking"];
  rankingTypeRows: Array<{
    key: Exclude<keyof AppSettings["searchRanking"]["typePriority"], "web" | "plugin">;
    label: string;
  }>;
  rankingSignalHelp: Record<RankingSignalKey, RankingFieldHelp>;
  rankingFrecencyHelp: Record<RankingFrecencyKey, RankingFieldHelp>;
  rankingTypePriorityHelp: RankingFieldHelp;
  renderLabelWithInfo: LabelWithInfoRenderer;
  updateRanking: (next: AppSettings["searchRanking"]) => void;
  resetRankingToDefault: () => void;
  handleNumberInputKeyDown: NumberInputKeydownHandler;
};

/** 排序参数分区 */
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

      <SearchSectionRankingNumericRow
        label={renderLabelWithInfo("匹配度权重", rankingSignalHelp.match)}
        value={ranking.signalWeights.match}
        min={0}
        step={0.1}
        integer={false}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        onValueChange={(nextValue) => updateRanking({ ...ranking, signalWeights: { ...ranking.signalWeights, match: Math.max(0, nextValue) } })}
      />
      <SearchSectionRankingNumericRow
        label={renderLabelWithInfo("频率权重", rankingSignalHelp.frequency)}
        value={ranking.signalWeights.frequency}
        min={0}
        step={0.1}
        integer={false}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        onValueChange={(nextValue) => updateRanking({ ...ranking, signalWeights: { ...ranking.signalWeights, frequency: Math.max(0, nextValue) } })}
      />
      <SearchSectionRankingNumericRow
        label={renderLabelWithInfo("最近时间权重", rankingSignalHelp.recency)}
        value={ranking.signalWeights.recency}
        min={0}
        step={0.1}
        integer={false}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        onValueChange={(nextValue) => updateRanking({ ...ranking, signalWeights: { ...ranking.signalWeights, recency: Math.max(0, nextValue) } })}
      />
      <SearchSectionRankingNumericRow
        label={renderLabelWithInfo("文件时间权重", rankingSignalHelp.fileMtime)}
        value={ranking.signalWeights.fileMtime}
        min={0}
        step={0.1}
        integer={false}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        onValueChange={(nextValue) => updateRanking({ ...ranking, signalWeights: { ...ranking.signalWeights, fileMtime: Math.max(0, nextValue) } })}
      />
      <SearchSectionRankingNumericRow
        label={renderLabelWithInfo("衰减因子", rankingFrecencyHelp.decayFactor)}
        value={ranking.frecency.decayFactor}
        min={0.0001}
        max={1}
        step={0.1}
        integer={false}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        onValueChange={(nextValue) => updateRanking({ ...ranking, frecency: { ...ranking.frecency, decayFactor: nextValue } })}
      />
      <SearchSectionRankingNumericRow
        label={renderLabelWithInfo("频率放大", rankingFrecencyHelp.frequencyWeight)}
        value={ranking.frecency.frequencyWeight}
        min={0}
        max={10}
        step={0.1}
        integer={false}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        onValueChange={(nextValue) => updateRanking({ ...ranking, frecency: { ...ranking.frecency, frequencyWeight: nextValue } })}
      />

      <div className="settings-hint ranking-type-hint">
        {renderLabelWithInfo("类型优先级（1-10，数值越大越优先）", rankingTypePriorityHelp)}
      </div>
      <SearchSectionRankingTypePriorityList
        ranking={ranking}
        rankingTypeRows={rankingTypeRows}
        updateRanking={updateRanking}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
      />
      <div className="form-row">
        <div className="form-label">恢复默认</div>
        <button type="button" className="small-btn ghost" onClick={resetRankingToDefault}>
          重置排序参数
        </button>
      </div>
    </div>
  );
}
