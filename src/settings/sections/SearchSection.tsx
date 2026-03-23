import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppSettings } from "../../appTypes";
import { IconInfo } from "../../components/icons/SettingsIcons";
import { RESULT_ACTION_OPTIONS } from "../../constants/initialValues";
import { getSearchTypeOptions } from "../../settingsStore";
import { handleNumericStepperKeyDown } from "../numericInputStepper";
import { SearchSectionBasics } from "./search/SearchSectionBasics";
import { SearchSectionRanking } from "./search/SearchSectionRanking";
import { SearchSectionTypeAndActions } from "./search/SearchSectionTypeAndActions";

type TooltipPayload = {
  kind: "plain" | "info";
  text: string;
  example?: string;
  left: number;
  top: number;
  placement: "top" | "bottom";
  anchor: { left: number; right: number; top: number; bottom: number };
  arrowLeft: number;
};

type RankingSignalKey = keyof AppSettings["searchRanking"]["signalWeights"];
type RankingFrecencyKey = keyof AppSettings["searchRanking"]["frecency"];

type RankingFieldHelp = {
  title: string;
  text: string;
  example: string;
};

const RANKING_SIGNAL_HELP: Record<RankingSignalKey, RankingFieldHelp> = {
  match: {
    title: "匹配度权重",
    text: "决定名称匹配信号在总分中的占比。",
    example: "例如：从 40 提高到 60，关键词更精准的结果会更靠前。",
  },
  frequency: {
    title: "频率权重",
    text: "决定“常用次数”对排序的影响。",
    example: "例如：提高后，打开次数高的应用会更靠前。",
  },
  recency: {
    title: "最近时间权重",
    text: "决定“最近使用时间”对排序的影响。",
    example: "例如：提高后，刚打开过的文件更容易排在前面。",
  },
  fileMtime: {
    title: "文件时间权重",
    text: "决定文件结果的“最近修改时间”影响。",
    example: "例如：提高后，最近修改的文档会更靠前。",
  },
};

const RANKING_FRECENCY_HELP: Record<RankingFrecencyKey, RankingFieldHelp> = {
  decayFactor: {
    title: "衰减因子",
    text: "决定最近信号随时间下降的速度。",
    example: "例如：0.01 调到 0.03 后，一周前记录会更快后移。",
  },
  frequencyWeight: {
    title: "频率放大",
    text: "决定频率信号的放大系数。",
    example: "例如：1.0 调到 1.8 后，高频结果会更稳定靠前。",
  },
};

const RANKING_TYPE_PRIORITY_HELP: RankingFieldHelp = {
  title: "类型优先级",
  text: "用于调制静态匹配分，同等条件下数值越高越靠前。",
  example: "例如：把“应用”从 8 调到 10 后，应用结果整体更靠前。",
};

export function SearchSection({
  error,
  draft,
  setDraft,
  setError,
  newTypeExt,
  setNewTypeExt,
  isMember,
  membershipBadge,
  typeOptions,
  defaultTypeMenuOpen,
  setDefaultTypeMenuOpen,
  defaultTypeActiveIndex,
  setDefaultTypeActiveIndex,
  defaultTypeSelectRef,
  currentDefaultTypeLabel,
  pickDefaultTypeByIndex,
  moveTypeId,
}: {
  error: string;
  draft: AppSettings;
  setDraft: (next: AppSettings) => void;
  setError: (msg: string) => void;
  newTypeExt: string;
  setNewTypeExt: (v: string) => void;
  isMember: boolean;
  membershipBadge: ReactNode;
  typeOptions: { id: string; label: string }[];
  defaultTypeMenuOpen: boolean;
  setDefaultTypeMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  defaultTypeActiveIndex: number;
  setDefaultTypeActiveIndex: (v: number | ((prev: number) => number)) => void;
  defaultTypeSelectRef: React.RefObject<HTMLDivElement>;
  currentDefaultTypeLabel: string;
  pickDefaultTypeByIndex: (idx: number) => void;
  moveTypeId: (list: string[], fromId: string, toId: string, position: "before" | "after") => string[];
}) {
  const [newIgnoredPath, setNewIgnoredPath] = useState("");
  const [searchWindowInitialWidthText, setSearchWindowInitialWidthText] = useState(String(draft.searchWindowInitialWidth));
  const [searchWindowMaxHeightText, setSearchWindowMaxHeightText] = useState(String(draft.searchWindowMaxHeight));
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipPayload | null>(null);

  useEffect(() => {
    setSearchWindowInitialWidthText(String(draft.searchWindowInitialWidth));
  }, [draft.searchWindowInitialWidth]);

  useEffect(() => {
    setSearchWindowMaxHeightText(String(draft.searchWindowMaxHeight));
  }, [draft.searchWindowMaxHeight]);

  useEffect(() => {
    if (!tooltip) return;
    const hide = () => setTooltip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("mousedown", hide, true);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("mousedown", hide, true);
    };
  }, [tooltip]);

  useLayoutEffect(() => {
    if (!tooltip) return;
    const el = tooltipRef.current;
    if (!el) return;
    const gap = 10;
    const padding = 12;
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;

    const rect = tooltip.anchor;
    const tipRect = el.getBoundingClientRect();
    const tipW = tipRect.width || 0;
    const tipH = tipRect.height || 0;

    let placement: "top" | "bottom" = tooltip.placement;
    if (placement === "top" && rect.top - gap - tipH < padding) placement = "bottom";
    if (placement === "bottom" && rect.bottom + gap + tipH > viewportH - padding) placement = "top";

    const left = Math.min(Math.max(padding, rect.left), Math.max(padding, viewportW - padding - tipW));
    const top = placement === "top" ? rect.top - gap - tipH : rect.bottom + gap;

    const anchorCenter = (rect.left + rect.right) / 2;
    const arrowLeft = Math.min(Math.max(14, anchorCenter - left), Math.max(14, tipW - 14));

    setTooltip((prev) => {
      if (!prev) return prev;
      if (prev.left === left && prev.top === top && prev.placement === placement && prev.arrowLeft === arrowLeft) return prev;
      return { ...prev, left, top, placement, arrowLeft };
    });
  }, [tooltip?.text, tooltip?.example, tooltip?.anchor.left, tooltip?.anchor.right, tooltip?.anchor.top, tooltip?.anchor.bottom, tooltip?.placement]);

  const showTooltipByRect = (text: string, rect: DOMRect) => {
    const placement: "top" | "bottom" = rect.top > (window.innerHeight || 0) * 0.55 ? "top" : "bottom";
    setTooltip({
      kind: "plain",
      text,
      left: 12,
      top: 12,
      placement,
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      arrowLeft: 14,
    });
  };

  const showInfoTooltipByRect = (text: string, example: string, rect: DOMRect) => {
    const placement: "top" | "bottom" = rect.top > (window.innerHeight || 0) * 0.55 ? "top" : "bottom";
    setTooltip({
      kind: "info",
      text,
      example,
      left: 12,
      top: 12,
      placement,
      anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      arrowLeft: 14,
    });
  };

  const resultActionOptions: { id: AppSettings["resultActionButtons"][number]; label: string; note?: string }[] = [...RESULT_ACTION_OPTIONS];
  const selectedActionIds = Array.isArray(draft.resultActionButtons) ? draft.resultActionButtons : [];

  const toggleAction = (id: AppSettings["resultActionButtons"][number]) => {
    if (!isMember) {
      setError("该功能订阅可用");
      return;
    }
    const exists = selectedActionIds.includes(id);
    if (exists) {
      setDraft({ ...draft, resultActionButtons: selectedActionIds.filter((x) => x !== id) });
      setError("");
      return;
    }
    if (selectedActionIds.length >= 3) {
      setError("右侧按钮最多只能选择 3 个");
      return;
    }
    setDraft({ ...draft, resultActionButtons: [...selectedActionIds, id] });
    setError("");
  };

  const moveAction = (id: AppSettings["resultActionButtons"][number], dir: "up" | "down") => {
    if (!isMember) {
      setError("该功能订阅可用");
      return;
    }
    const idx = selectedActionIds.indexOf(id);
    if (idx < 0) return;
    const next = selectedActionIds.slice();
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= next.length) return;
    const tmp = next[target];
    next[target] = next[idx];
    next[idx] = tmp;
    setDraft({ ...draft, resultActionButtons: next });
    setError("");
  };

  const clampInt = (v: any, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  const normalizeIgnoredPath = (v: string) => v.replace(/\//g, "\\").trim().replace(/[\\]+$/g, "");
  const ignoredPaths = Array.isArray(draft.ignoredPaths) ? draft.ignoredPaths : [];
  const addIgnoredPath = () => {
    const raw = newIgnoredPath.trim();
    const normalized = normalizeIgnoredPath(raw);
    if (!normalized) {
      setError("请输入要忽略的路径");
      return;
    }
    const exists = ignoredPaths.some((p) => normalizeIgnoredPath(p).toLowerCase() === normalized.toLowerCase());
    if (exists) {
      setError("该路径已存在");
      return;
    }
    setDraft({ ...draft, ignoredPaths: [...ignoredPaths, raw] });
    setNewIgnoredPath("");
    setError("");
  };

  const disabledTypeIds = Array.isArray(draft.disabledSearchTypeIds) ? draft.disabledSearchTypeIds : [];
  const isTypeDisabled = (id: string) => id !== "all" && disabledTypeIds.includes(id);
  const toggleTypeEnabled = (id: string) => {
    if (!id || id === "all") return;
    const disabled = isTypeDisabled(id);
    const nextDisabled = disabled ? disabledTypeIds.filter((x) => x !== id) : [...disabledTypeIds, id];
    const nextDefault = !disabled && draft.defaultSearchTypeId === id ? "all" : draft.defaultSearchTypeId;
    setDraft({ ...draft, disabledSearchTypeIds: nextDisabled, defaultSearchTypeId: nextDefault });
    setError("");
  };

  const ranking = draft.searchRanking;
  const rankingTypeRows: Array<{ key: Exclude<keyof AppSettings["searchRanking"]["typePriority"], "web" | "plugin">; label: string }> = [
    { key: "app", label: "应用" },
    { key: "command", label: "系统命令" },
    { key: "settings", label: "设置" },
    { key: "file", label: "文件" },
    { key: "folder", label: "文件夹" },
    { key: "image", label: "图片" },
    { key: "video", label: "视频" },
  ];

  const normalizeSignalWeights = (weights: AppSettings["searchRanking"]["signalWeights"]) => {
    const match = Math.max(0, Number(weights.match) || 0);
    const frequency = Math.max(0, Number(weights.frequency) || 0);
    const recency = Math.max(0, Number(weights.recency) || 0);
    const fileMtime = Math.max(0, Number(weights.fileMtime) || 0);
    const sum = match + frequency + recency + fileMtime;
    if (!Number.isFinite(sum) || sum <= 0) {
      return { match: 40, frequency: 30, recency: 20, fileMtime: 10 };
    }
    return {
      match: Number(((match / sum) * 100).toFixed(4)),
      frequency: Number(((frequency / sum) * 100).toFixed(4)),
      recency: Number(((recency / sum) * 100).toFixed(4)),
      fileMtime: Number(((fileMtime / sum) * 100).toFixed(4)),
    };
  };

  const updateRanking = (next: AppSettings["searchRanking"]) => {
    setDraft({
      ...draft,
      searchRanking: {
        signalWeights: normalizeSignalWeights(next.signalWeights),
        frecency: {
          decayFactor: Math.min(1, Math.max(0.0001, Number(next.frecency.decayFactor) || 0.01)),
          frequencyWeight: Math.min(10, Math.max(0, Number(next.frecency.frequencyWeight) || 0)),
        },
        typePriority: {
          app: Math.min(10, Math.max(1, Math.round(next.typePriority.app))),
          command: Math.min(10, Math.max(1, Math.round(next.typePriority.command))),
          settings: Math.min(10, Math.max(1, Math.round(next.typePriority.settings))),
          file: Math.min(10, Math.max(1, Math.round(next.typePriority.file))),
          folder: Math.min(10, Math.max(1, Math.round(next.typePriority.folder))),
          image: Math.min(10, Math.max(1, Math.round(next.typePriority.image))),
          video: Math.min(10, Math.max(1, Math.round(next.typePriority.video))),
          web: Math.min(10, Math.max(1, Math.round(next.typePriority.web))),
          plugin: Math.min(10, Math.max(1, Math.round(next.typePriority.plugin))),
        },
      },
    });
    setError("");
  };

  const resetRankingToDefault = () => {
    updateRanking({
      signalWeights: { match: 40, frequency: 30, recency: 20, fileMtime: 10 },
      frecency: { decayFactor: 0.01, frequencyWeight: 1 },
      typePriority: {
        app: 10,
        command: 9,
        settings: 9,
        file: 8,
        folder: 8,
        image: 8,
        video: 8,
        web: 7,
        plugin: 6,
      },
    });
  };

  const handleNumberInputKeyDown = (
    e: Parameters<typeof handleNumericStepperKeyDown>[0],
    options: Parameters<typeof handleNumericStepperKeyDown>[1],
  ) => {
    const handled = handleNumericStepperKeyDown(e, options);
    if (handled) return;
    if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
  };

  const renderLabelWithInfo = (label: string, help: RankingFieldHelp) => (
    <span className="ranking-label-wrap">
      <span>{label}</span>
      <button
        type="button"
        className="ranking-info-btn"
        aria-label={`${help.title}说明`}
        onMouseEnter={(e) => showInfoTooltipByRect(help.text, help.example, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setTooltip(null)}
        onFocus={(e) => showInfoTooltipByRect(help.text, help.example, e.currentTarget.getBoundingClientRect())}
        onBlur={() => setTooltip(null)}
      >
        <IconInfo size={14} variant="duotone" />
      </button>
    </span>
  );

  return (
    <div className="settings-content">
      <SearchSectionBasics
        draft={draft}
        setDraft={setDraft}
        setError={setError}
        membershipBadge={membershipBadge}
        isMember={isMember}
        defaultTypeMenuOpen={defaultTypeMenuOpen}
        setDefaultTypeMenuOpen={setDefaultTypeMenuOpen}
        defaultTypeActiveIndex={defaultTypeActiveIndex}
        setDefaultTypeActiveIndex={setDefaultTypeActiveIndex}
        defaultTypeSelectRef={defaultTypeSelectRef}
        currentDefaultTypeLabel={currentDefaultTypeLabel}
        typeOptions={typeOptions}
        pickDefaultTypeByIndex={pickDefaultTypeByIndex}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
        searchWindowInitialWidthText={searchWindowInitialWidthText}
        setSearchWindowInitialWidthText={setSearchWindowInitialWidthText}
        searchWindowMaxHeightText={searchWindowMaxHeightText}
        setSearchWindowMaxHeightText={setSearchWindowMaxHeightText}
        clampInt={clampInt}
        newIgnoredPath={newIgnoredPath}
        setNewIgnoredPath={setNewIgnoredPath}
        ignoredPaths={ignoredPaths}
        addIgnoredPath={addIgnoredPath}
        showTooltipByRect={showTooltipByRect}
        setTooltip={setTooltip}
        tooltip={tooltip}
        tooltipRef={tooltipRef}
      />

      <SearchSectionRanking
        ranking={ranking}
        rankingTypeRows={rankingTypeRows}
        rankingSignalHelp={RANKING_SIGNAL_HELP}
        rankingFrecencyHelp={RANKING_FRECENCY_HELP}
        rankingTypePriorityHelp={RANKING_TYPE_PRIORITY_HELP}
        renderLabelWithInfo={renderLabelWithInfo}
        updateRanking={updateRanking}
        resetRankingToDefault={resetRankingToDefault}
        handleNumberInputKeyDown={handleNumberInputKeyDown}
      />

      <SearchSectionTypeAndActions
        draft={draft}
        setDraft={setDraft}
        setError={setError}
        newTypeExt={newTypeExt}
        setNewTypeExt={setNewTypeExt}
        isMember={isMember}
        membershipBadge={membershipBadge}
        typeOptions={typeOptions}
        isTypeDisabled={isTypeDisabled}
        toggleTypeEnabled={toggleTypeEnabled}
        moveTypeId={moveTypeId}
        resultActionOptions={resultActionOptions}
        selectedActionIds={selectedActionIds}
        toggleAction={toggleAction}
        moveAction={moveAction}
      />

      {error ? <div className="settings-error">{error}</div> : null}
    </div>
  );
}
