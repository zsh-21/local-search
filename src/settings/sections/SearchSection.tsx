import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppSettings } from "../../appTypes";
import { IconInfo } from "../../components/icons/SettingsIcons";
import { RESULT_ACTION_OPTIONS } from "../../constants/initialValues";
import { getSearchTypeOptions } from "../../settingsStore";
import { TypeOrderItem } from "../../TypeOrderItem";
import { handleNumericStepperKeyDown } from "../numericInputStepper";

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
    text: "决定名称匹配信号对总分的影响比例。",
    example: "例：把匹配权重从 40 提到 60，关键词更精准的结果会更靠前。",
  },
  frequency: {
    title: "频率权重",
    text: "决定“常用次数”对排序的影响比例。",
    example: "例：频率权重提高后，打开次数高的应用会排在前面。",
  },
  recency: {
    title: "最近时间权重",
    text: "决定“最近使用时间”对排序的影响比例。",
    example: "例：最近权重更高时，刚打开过的文件会更容易顶部出现。",
  },
  fileMtime: {
    title: "文件时间权重",
    text: "决定文件类结果的“最近修改时间”影响比例。",
    example: "例：调高后，新近修改的文档会比旧文档更靠前。",
  },
};

const RANKING_FRECENCY_HELP: Record<RankingFrecencyKey, RankingFieldHelp> = {
  decayFactor: {
    title: "衰减因子",
    text: "决定最近时间信号的衰减速度，值越大衰减越快。",
    example: "例：从 0.01 调到 0.03 后，一周前的记录会更快后移。",
  },
  frequencyWeight: {
    title: "频率放大",
    text: "决定频率信号放大系数，影响高频结果的前移程度。",
    example: "例：从 1.0 调到 1.8 后，多次点击的结果会更稳定地排在前列。",
  },
};

const RANKING_TYPE_PRIORITY_HELP: RankingFieldHelp = {
  title: "类型优先级",
  text: "用于调制静态匹配分，值越大同等条件下越容易靠前。",
  example: "例：把“应用”从 8 提到 10 后，应用结果会整体更靠前。",
};

// 搜索设置分区：默认类型、自定义类型、列表显示与类型顺序（含会员禁用逻辑）
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
  const [searchWindowInitialWidthText, setSearchWindowInitialWidthText] = useState(
    String(draft.searchWindowInitialWidth),
  );
  const [searchWindowMaxHeightText, setSearchWindowMaxHeightText] = useState(
    String(draft.searchWindowMaxHeight),
  );
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

  // 搜索结果右侧按钮配置：保持未来可扩展（新增按钮只需追加选项与渲染逻辑）
  // 按钮候选项已抽离：便于你集中增删/改文案/调整 note
  const resultActionOptions: { id: AppSettings["resultActionButtons"][number]; label: string; note?: string }[] = [
    ...RESULT_ACTION_OPTIONS,
  ];
  const selectedActionIds = Array.isArray(draft.resultActionButtons) ? draft.resultActionButtons : [];

  // 勾选/取消按钮：限制最多三项，超限给出提示
  const toggleAction = (id: AppSettings["resultActionButtons"][number]) => {
    if (!isMember) {
      setError("该功能订阅可用");
      return;
    }
    const exists = selectedActionIds.includes(id);
    if (exists) {
      setDraft({
        ...draft,
        resultActionButtons: selectedActionIds.filter((x) => x !== id),
      });
      setError("");
      return;
    }
    if (selectedActionIds.length >= 3) {
      setError("右侧按钮最多只能选择 3 个");
      return;
    }
    setDraft({
      ...draft,
      resultActionButtons: [...selectedActionIds, id],
    });
    setError("");
  };

  // 上下移动顺序：仅调整已选项的展示顺序
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
  // 仅在设置 UI 隐藏 web/plugin，底层字段与存储结构保持不变以确保兼容旧配置
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
      return {
        match: 40,
        frequency: 30,
        recency: 20,
        fileMtime: 10,
      };
    }
    // 保存前先归一化，避免用户输入导致总和漂移
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
      signalWeights: {
        match: 40,
        frequency: 30,
        recency: 20,
        fileMtime: 10,
      },
      frecency: {
        decayFactor: 0.01,
        frequencyWeight: 1,
      },
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

  // 统一处理数字输入框的方向键步进与 Enter 提交：保证手输与键盘步进都可用
  const handleNumberInputKeyDown = (
    e: Parameters<typeof handleNumericStepperKeyDown>[0],
    options: Parameters<typeof handleNumericStepperKeyDown>[1],
  ) => {
    const handled = handleNumericStepperKeyDown(e, options);
    if (handled) return;
    if (e.key === "Enter") {
      (e.currentTarget as HTMLInputElement).blur();
    }
  };

  // 排序项标签统一复用说明图标：同时支持鼠标 hover 与键盘 focus 的提示触达
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
        {/* 信息提示图标使用双色叠层：与设置页其他图标保持统一的层次感。 */}
        <IconInfo size={14} variant="duotone" />
      </button>
    </span>
  );

  return (
    <div className="settings-content">
      <div className="settings-group" style={{ zIndex: defaultTypeMenuOpen ? 100 : undefined }}>
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">
          <span>默认类型</span>
          {membershipBadge}
        </div>
        {/* 默认类型补充说明，强调首次打开的默认选择与订阅限制。 */}
        <div className="settings-hint">设置搜索框初始选中的类型，每次打开面板会自动选中该项（订阅可配置）。</div>
        <div className="form-row">
          <div className="form-label">默认选择</div>
          <div className="settings-type-select type-select" ref={defaultTypeSelectRef}>
            <button
              className="type-select-btn"
              type="button"
              disabled={!isMember}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!isMember) return;
                setDefaultTypeMenuOpen((v) => !v);
              }}
              onKeyDown={(e) => {
                if (!isMember) return;
                if (e.key === "Escape") {
                  setDefaultTypeMenuOpen(false);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setDefaultTypeMenuOpen(true);
                  setDefaultTypeActiveIndex((prev) => {
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    const next = (prev + delta + typeOptions.length) % typeOptions.length;
                    return next;
                  });
                  return;
                }
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (!defaultTypeMenuOpen) setDefaultTypeMenuOpen(true);
                  else pickDefaultTypeByIndex(defaultTypeActiveIndex);
                  return;
                }
                if (e.key === "Tab") {
                  setDefaultTypeMenuOpen(false);
                }
              }}
              aria-haspopup="listbox"
              aria-expanded={defaultTypeMenuOpen}
              aria-label="默认类型选择"
              title={currentDefaultTypeLabel}
            >
              <span className="type-select-label">{currentDefaultTypeLabel}</span>
              <span className="type-select-caret">▾</span>
            </button>

            {defaultTypeMenuOpen ? (
              <div
                className="type-select-menu"
                role="listbox"
                aria-label="默认类型列表"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="type-select-menu-inner">
                  {typeOptions.map((opt, idx) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={opt.id === draft.defaultSearchTypeId}
                      className={`type-select-item ${opt.id === draft.defaultSearchTypeId ? "active" : ""} ${idx === defaultTypeActiveIndex ? "kbd-active" : ""}`}
                      onMouseMove={() => setDefaultTypeActiveIndex(idx)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        pickDefaultTypeByIndex(idx);
                      }}
                    >
                      <div className="type-select-item-left">
                        <span>{opt.label}</span>
                      </div>
                      {opt.id === draft.defaultSearchTypeId && <span className="check-mark">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">列表显示</div>
          {/* 说明文案补充影响范围，强调仅影响展示而非命中结果。 */}
          <div className="settings-hint">
            控制搜索结果列表的展示密度与条数（仅影响列表展示，不影响实际命中数量）。范围 20-100，默认 50。
          </div>
          <div className="form-row">
            <div className="form-label">展示条数</div>
            <input
              type="text"
              className="text-input"
              inputMode="numeric"
              value={String(draft.searchDisplayLimit)}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const n = raw === "" ? NaN : Number(raw);
                if (!Number.isFinite(n)) return;
                const next = Math.min(100, Math.max(20, Math.round(n)));
                setDraft({ ...draft, searchDisplayLimit: next });
                setError("");
              }}
              onKeyDown={(e) => {
                handleNumberInputKeyDown(e, {
                  min: 20,
                  max: 100,
                  integer: true,
                  step: 1,
                  fallbackValue: draft.searchDisplayLimit,
                  onValueChange: (nextValue) => {
                    setDraft({ ...draft, searchDisplayLimit: nextValue });
                    setError("");
                  },
                });
              }}
            />
          </div>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.showResultPath}
            onChange={(e) => {
              setDraft({ ...draft, showResultPath: e.target.checked });
              setError("");
            }}
          />
          <span>显示列表文件地址</span>
        </label>
        <label className="setting-row">
          <input
            type="checkbox"
            checked={draft.compactMode}
            onChange={(e) => {
              setDraft({ ...draft, compactMode: e.target.checked });
              setError("");
            }}
          />
          <span>紧凑模式</span>
        </label>
      </div>

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">搜索窗口尺寸</div>
        {/* 说明文案补充限制范围，帮助用户理解生效边界。 */}
        <div className="settings-hint">
          初始宽度用于控制搜索窗口首次打开的宽度；最大高度用于控制搜索结果展开后的最大高度。
          <br />
          宽度范围 450-1000；高度最大值不超过当前显示器可用高度，避免遮挡其他窗口。
        </div>
        <div className="form-row">
          <div className="form-label">初始宽度</div>
          <input
            type="text"
            className="text-input"
            inputMode="numeric"
            value={searchWindowInitialWidthText}
            onChange={(e) => setSearchWindowInitialWidthText(e.target.value)}
            onBlur={() => {
              const raw = searchWindowInitialWidthText.trim();
              const next = clampInt(raw, draft.searchWindowInitialWidth, 450, 1000);
              setDraft({ ...draft, searchWindowInitialWidth: next });
              setError("");
              setSearchWindowInitialWidthText(String(next));
            }}
            onKeyDown={(e) => {
              handleNumberInputKeyDown(e, {
                min: 450,
                max: 1000,
                integer: true,
                step: 1,
                fallbackValue: draft.searchWindowInitialWidth,
                onValueChange: (nextValue) => {
                  setDraft({ ...draft, searchWindowInitialWidth: nextValue });
                  setSearchWindowInitialWidthText(String(nextValue));
                  setError("");
                },
              });
            }}
          />
        </div>
        <div className="form-row">
          <div className="form-label">最大高度</div>
          <input
            type="text"
            className="text-input"
            inputMode="numeric"
            value={searchWindowMaxHeightText}
            onChange={(e) => setSearchWindowMaxHeightText(e.target.value)}
            onBlur={() => {
              const raw = searchWindowMaxHeightText.trim();
              const max = Math.max(200, Math.floor(window.screen?.availHeight || 0));
              const next = clampInt(raw, draft.searchWindowMaxHeight, 200, max);
              setDraft({ ...draft, searchWindowMaxHeight: next });
              setError("");
              setSearchWindowMaxHeightText(String(next));
            }}
            onKeyDown={(e) => {
              handleNumberInputKeyDown(e, {
                min: 200,
                max: Math.max(200, Math.floor(window.screen?.availHeight || 0)),
                integer: true,
                step: 1,
                fallbackValue: draft.searchWindowMaxHeight,
                onValueChange: (nextValue) => {
                  setDraft({ ...draft, searchWindowMaxHeight: nextValue });
                  setSearchWindowMaxHeightText(String(nextValue));
                  setError("");
                },
              });
            }}
          />
        </div>
      </div>

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">结果排序</div>
        {/* 说明文案补充排序影响范围，便于用户理解调整目的。 */}
        <div className="settings-hint">
          调整静态匹配、Frecency 与类型优先级，决定结果排序策略。信号权重保存时会自动归一化到总和 100。
        </div>
        <div className="form-row">
          <div className="form-label">{renderLabelWithInfo("匹配度权重", RANKING_SIGNAL_HELP.match)}</div>
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
                onValueChange: (nextValue) => {
                  updateRanking({
                    ...ranking,
                    signalWeights: { ...ranking.signalWeights, match: Math.max(0, nextValue) },
                  });
                },
              })
            }
          />
        </div>
        <div className="form-row">
          <div className="form-label">{renderLabelWithInfo("频率权重", RANKING_SIGNAL_HELP.frequency)}</div>
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
                onValueChange: (nextValue) => {
                  updateRanking({
                    ...ranking,
                    signalWeights: { ...ranking.signalWeights, frequency: Math.max(0, nextValue) },
                  });
                },
              })
            }
          />
        </div>
        <div className="form-row">
          <div className="form-label">{renderLabelWithInfo("最近时间权重", RANKING_SIGNAL_HELP.recency)}</div>
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
                onValueChange: (nextValue) => {
                  updateRanking({
                    ...ranking,
                    signalWeights: { ...ranking.signalWeights, recency: Math.max(0, nextValue) },
                  });
                },
              })
            }
          />
        </div>
        <div className="form-row">
          <div className="form-label">{renderLabelWithInfo("文件时间权重", RANKING_SIGNAL_HELP.fileMtime)}</div>
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
                onValueChange: (nextValue) => {
                  updateRanking({
                    ...ranking,
                    signalWeights: { ...ranking.signalWeights, fileMtime: Math.max(0, nextValue) },
                  });
                },
              })
            }
          />
        </div>
        <div className="form-row">
          <div className="form-label">{renderLabelWithInfo("衰减因子", RANKING_FRECENCY_HELP.decayFactor)}</div>
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
                onValueChange: (nextValue) => {
                  updateRanking({
                    ...ranking,
                    frecency: { ...ranking.frecency, decayFactor: nextValue },
                  });
                },
              })
            }
          />
        </div>
        <div className="form-row">
          <div className="form-label">{renderLabelWithInfo("频率放大", RANKING_FRECENCY_HELP.frequencyWeight)}</div>
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
                onValueChange: (nextValue) => {
                  updateRanking({
                    ...ranking,
                    frecency: { ...ranking.frecency, frequencyWeight: nextValue },
                  });
                },
              })
            }
          />
        </div>
        <div className="settings-hint ranking-type-hint">
          {renderLabelWithInfo("类型优先级（1-10，数值越大越优先）", RANKING_TYPE_PRIORITY_HELP)}
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
                      typePriority: {
                        ...ranking.typePriority,
                        [row.key]: n,
                      },
                    });
                  }}
                  onKeyDown={(e) =>
                    handleNumberInputKeyDown(e, {
                      min: 1,
                      max: 10,
                      integer: true,
                      step: 1,
                      fallbackValue: ranking.typePriority[row.key],
                      onValueChange: (nextValue) => {
                        updateRanking({
                          ...ranking,
                          typePriority: {
                            ...ranking.typePriority,
                            [row.key]: nextValue,
                          },
                        });
                      },
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

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">路径黑名单</div>
        {/* 说明文案补充使用场景，避免误解为删除文件。 */}
        <div className="settings-hint">
          命中前缀的路径及其子目录将被忽略（可配置多个，上不封顶），适合排除缓存或临时目录。
        </div>
        <div className="form-row">
          <div className="form-label">新增路径</div>
          <div className="input-with-btn">
            <input
              type="text"
              className="text-input"
              value={newIgnoredPath}
              placeholder="例如 D:\\Downloads 或 C:\\Users\\xxx\\AppData\\Local"
              onChange={(e) => {
                setNewIgnoredPath(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addIgnoredPath();
                }
              }}
            />
            <button type="button" className="small-btn" onClick={addIgnoredPath}>
              添加
            </button>
          </div>
        </div>
        {ignoredPaths.length > 0 ? (
          <div className="action-config-list">
            {ignoredPaths.map((p) => (
              <div key={p} className="action-config-row checked">
                <div className="action-config-left">
                  <span className="action-config-label">
                    <span
                      className="fs-ellipsis"
                      onMouseEnter={(e) => showTooltipByRect(p, (e.currentTarget as HTMLElement).getBoundingClientRect())}
                      onMouseLeave={() => setTooltip(null)}
                    >
                      {p}
                    </span>
                  </span>
                </div>
                <div className="action-config-right">
                  <button
                    type="button"
                    className="small-btn ghost"
                    onClick={() => {
                      setDraft({ ...draft, ignoredPaths: ignoredPaths.filter((x) => x !== p) });
                      setError("");
                    }}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {tooltip
        ? createPortal(
            <div
              ref={tooltipRef}
              className={`fs-tooltip-pop ${tooltip.kind === "info" ? "fs-tooltip-pop--info" : ""}`}
              data-placement={tooltip.placement}
              style={
                {
                  left: tooltip.left,
                  top: tooltip.top,
                  ["--fs-tooltip-arrow-left" as any]: `${tooltip.arrowLeft}px`,
                } as any
              }
            >
              <div className="fs-tooltip-text">{tooltip.text}</div>
              {tooltip.kind === "info" && tooltip.example ? (
                <div className="fs-tooltip-example">{tooltip.example}</div>
              ) : null}
              <div className="fs-tooltip-arrow" />
            </div>,
            document.body,
          )
        : null}

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">
          <span>自定义类型</span>
          {membershipBadge}
        </div>
        {/* 自定义类型补充说明，强调后缀格式与影响范围。 */}
        <div className="settings-hint">按文件后缀扩展自定义搜索类型，新增后会参与默认类型、排序与开关控制（订阅可配置）。</div>
        {/* 自定义类型作为高级功能：非会员保持禁用，但支持回车提交，提高录入效率 */}
        <div className="form-row">
          <div className="form-label">新增后缀</div>
          <div className="input-with-btn">
            <input
              type="text"
              className="text-input"
              value={newTypeExt}
              placeholder=".docx"
              disabled={!isMember}
              onChange={(e) => {
                setNewTypeExt(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.stopPropagation();
                if (!isMember) return;
                const ext = newTypeExt.trim().toLowerCase();
                if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
                  setError("后缀格式不合法（例如 .docx）");
                  return;
                }
                if (draft.customSearchTypes.includes(ext)) {
                  setError("该类型已存在");
                  return;
                }
                const nextCustom = [...draft.customSearchTypes, ext];
                const nextOrder = getSearchTypeOptions(nextCustom, [
                  ...(draft.searchTypeOrder || []),
                  `ext:${ext}`,
                ]).map((x) => x.id);
                setDraft({
                  ...draft,
                  customSearchTypes: nextCustom,
                  searchTypeOrder: nextOrder,
                });
                setNewTypeExt("");
                setError("");
              }}
            />
            <button
              type="button"
              className="small-btn"
              disabled={!isMember}
              onClick={() => {
                const ext = newTypeExt.trim().toLowerCase();
                if (!/^\.[a-z0-9]{1,10}$/i.test(ext)) {
                  setError("后缀格式不合法（例如 .docx）");
                  return;
                }
                if (draft.customSearchTypes.includes(ext)) {
                  setError("该类型已存在");
                  return;
                }
                const nextCustom = [...draft.customSearchTypes, ext];
                const nextOrder = getSearchTypeOptions(nextCustom, [
                  ...(draft.searchTypeOrder || []),
                  `ext:${ext}`,
                ]).map((x) => x.id);
                setDraft({
                  ...draft,
                  customSearchTypes: nextCustom,
                  searchTypeOrder: nextOrder,
                });
                setNewTypeExt("");
                setError("");
              }}
            >
              添加
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">
          <span>类型顺序</span>
          {membershipBadge}
        </div>
        {/* 类型顺序补充说明，强调拖拽与禁用对默认类型的影响。 */}
        <div className="settings-hint">可拖拽排序、启停单个类型，并自动维护默认类型可用性（订阅可配置）。</div>
        <div className="type-order-list">
          <div className="type-order-list-inner">
            {typeOptions.map((opt) => (
              <TypeOrderItem
                key={opt.id}
                id={opt.id}
                label={opt.label}
                isCustom={opt.id.startsWith("ext:")}
                orderedIds={typeOptions.map((x) => x.id)}
                disabled={!isMember}
                rightExtra={
                  opt.id === "all" ? null : (
                    <button
                      type="button"
                      className={`type-toggle-btn ${isTypeDisabled(opt.id) ? "on" : ""}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleTypeEnabled(opt.id);
                      }}
                      aria-pressed={!isTypeDisabled(opt.id)}
                      aria-label={isTypeDisabled(opt.id) ? "启用该类型" : "禁用该类型"}
                    >
                      {isTypeDisabled(opt.id) ? "开启" : "关闭"}
                    </button>
                  )
                }
                onMove={(fromId, toId, position) => {
                  if (!isMember) return;
                  const nextOrder = moveTypeId(
                    typeOptions.map((x) => x.id),
                    fromId,
                    toId,
                    position,
                  );
                  setDraft({ ...draft, searchTypeOrder: nextOrder });
                  setError("");
                }}
                onDelete={(targetId) => {
                  if (!isMember) return;
                  if (!targetId.startsWith("ext:")) return;
                  const ext = targetId.slice(4);
                  const nextCustom = (draft.customSearchTypes || []).filter(
                    (x) => x !== ext,
                  );
                  const nextDefault =
                    draft.defaultSearchTypeId === targetId
                      ? "all"
                      : draft.defaultSearchTypeId;
                  const nextOrder = getSearchTypeOptions(
                    nextCustom,
                    (draft.searchTypeOrder || []).filter((x) => x !== targetId),
                  ).map((x) => x.id);
                  setDraft({
                    ...draft,
                    customSearchTypes: nextCustom,
                    defaultSearchTypeId: nextDefault,
                    searchTypeOrder: nextOrder,
                  });
                  setError("");
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        {/* 分组标题改为纯文本展示，去掉 hover 提示入口。 */}
        <div className="settings-group-title">
          <span>结果右侧按钮</span>
          {membershipBadge}
        </div>
        {/* 说明文案补充选择建议，帮助用户控制按钮数量。 */}
        <div className="settings-hint">
          {!isMember
            ? "订阅后可自定义；非会员使用默认按钮，仍会显示常用操作。"
            : "最多显示 3 项，可调整顺序；建议保留常用操作，避免过多按钮干扰。"}
        </div>
        <div className="action-config-list">
          {resultActionOptions.map((opt) => {
            const checked = selectedActionIds.includes(opt.id);
            const order = checked ? selectedActionIds.indexOf(opt.id) + 1 : 0;
            const disableAdd = !checked && selectedActionIds.length >= 3;
            return (
              <div key={opt.id} className={`action-config-row ${checked ? "checked" : ""} ${disableAdd ? "disabled" : ""}`}>
                <label className="action-config-left">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disableAdd || !isMember}
                    onChange={() => toggleAction(opt.id)}
                  />
                  <span className="action-config-label">
                    {opt.label}
                    {opt.note ? <span className="action-config-note">{opt.note}</span> : null}
                  </span>
                </label>
                <div className="action-config-right">
                  {checked ? <span className="action-config-order">{order}</span> : null}
                  <button
                    type="button"
                    className="small-btn ghost"
                    disabled={!isMember || !checked || order <= 1}
                    onClick={() => moveAction(opt.id, "up")}
                    aria-label="上移"
                    title="上移"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small-btn ghost"
                    disabled={!isMember || !checked || order >= selectedActionIds.length}
                    onClick={() => moveAction(opt.id, "down")}
                    aria-label="下移"
                    title="下移"
                  >
                    ↓
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
    </div>
  );
}

