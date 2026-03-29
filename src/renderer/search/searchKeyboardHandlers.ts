import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject, RefObject } from "react";
import type { AppItem, AppSettings, SearchTypeOption } from "../appTypes";
import { DEFAULT_SETTINGS } from "../constants/initialValues";

/** 快捷键事件最小字段约束 */
export type ShortcutTriggerEvent = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

/** 搜索键盘处理可接收的事件类型（原生 + React） */
export type SearchKeyboardEvent = KeyboardEvent | ReactKeyboardEvent<Element>;

/** 数值状态设置函数 */
type NumberStateSetter = (value: number | ((prev: number) => number)) => void;

/** 搜索结果动作 ID */
type ResultActionId = AppSettings["resultActionButtons"][number];

/** 键盘捕获处理参数 */
export type SearchKeyboardCaptureParams = {
  inputValue: string;
  ghostInputValue: string;
  inputRef: RefObject<HTMLInputElement>;
  preserveGhostSuggestionRef: MutableRefObject<boolean>;
  setQuery: (value: string) => void;
  setInputValue: (value: string) => void;
  setSelectedActionIndex: NumberStateSetter;
  clearSearchInput: () => void;
  hideWindow: () => void;
  togglePanelPinned: () => void;
  enabledSearchTypeOptions: SearchTypeOption[];
  searchTypeId: string;
  typeSwitchRequestedRef: MutableRefObject<boolean>;
  setGhostInputValue: (value: string) => void;
  setSearchTypeId: (value: string) => void;
  setTypeMenuOpen: (value: boolean) => void;
  results: AppItem[];
  settings: AppSettings;
  isShortcutPressed: (event: ShortcutTriggerEvent, shortcut: string) => boolean;
  acceptSelectedResultToInput: () => boolean;
  setLastSelectedBy: (value: "keyboard" | "mouse") => void;
  setSelectedIndex: NumberStateSetter;
  resolveGhostCandidateByInput: (rawInput: string, candidateName: string) => string;
  selectedIndex: number;
  copyCalcResult: (item: AppItem | undefined) => void;
  openFolder: (item: AppItem) => void;
  launchApp: (item: AppItem) => void;
};

/** 键盘核心处理参数 */
export type SearchKeyboardCoreParams = {
  selectedActionIndex: number;
  setSelectedActionIndex: NumberStateSetter;
  results: AppItem[];
  selectedIndex: number;
  getVisibleActionIdsForItem: (item: AppItem | undefined) => ResultActionId[];
  setLastSelectedBy: (value: "keyboard" | "mouse") => void;
  openFolder: (item: AppItem) => void;
  copyPath: (item: AppItem) => void;
  runAsAdmin: (item: AppItem) => void;
  deleteResultItem: (item: AppItem | undefined) => Promise<void>;
  togglePanelPinned: () => void;
  handleKeyDownCapture: (event: SearchKeyboardEvent) => void;
};

/** 标准化快捷键主键名称 */
export function normalizeShortcutMainKey(raw: string) {
  const key = String(raw || "").trim();
  if (!key) return "";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  return key;
}

/** 解析快捷键字符串 */
export function parseShortcut(shortcut: string) {
  const parts = String(shortcut || "")
    .split("+")
    .map((x) => x.trim())
    .filter(Boolean);
  const parsed = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "commandorcontrol") {
      parsed.ctrl = true;
      continue;
    }
    if (lower === "alt" || lower === "option") {
      parsed.alt = true;
      continue;
    }
    if (lower === "shift") {
      parsed.shift = true;
      continue;
    }
    if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") {
      parsed.meta = true;
      continue;
    }
    parsed.key = normalizeShortcutMainKey(part);
  }
  return parsed;
}

/** 判断按键事件是否命中目标快捷键 */
export function isShortcutPressed(event: ShortcutTriggerEvent, shortcut: string) {
  const parsed = parseShortcut(shortcut);
  if (!parsed.key) return false;
  if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  if (Boolean(event.metaKey) !== parsed.meta) return false;
  return normalizeShortcutMainKey(event.key) === parsed.key;
}

/** 构建捕获阶段键盘处理函数 */
export function createHandleKeyDownCapture(params: SearchKeyboardCaptureParams) {
  /** 以词边界方式接收幽灵补全文本 */
  const acceptGhostSuggestionByToken = () => {
    if (!params.inputValue || !params.ghostInputValue) return false;
    if (params.ghostInputValue.length <= params.inputValue.length) return false;
    const inputEl = params.inputRef.current;
    if (
      inputEl &&
      inputEl.selectionStart != null &&
      inputEl.selectionEnd != null &&
      (inputEl.selectionStart !== params.inputValue.length || inputEl.selectionEnd !== params.inputValue.length)
    ) {
      return false;
    }
    const inputLower = params.inputValue.toLocaleLowerCase();
    const ghostLower = params.ghostInputValue.toLocaleLowerCase();
    if (!ghostLower.startsWith(inputLower)) return false;

    const isBoundary = (ch: string) => /[\s._\-\\/]/.test(ch);
    let cursor = params.inputValue.length;
    if (isBoundary(params.ghostInputValue[cursor])) {
      while (cursor < params.ghostInputValue.length && isBoundary(params.ghostInputValue[cursor])) {
        cursor += 1;
      }
    }
    while (cursor < params.ghostInputValue.length && !isBoundary(params.ghostInputValue[cursor])) {
      cursor += 1;
    }
    if (cursor <= params.inputValue.length) return false;

    const nextValue = params.ghostInputValue.slice(0, cursor);
    params.preserveGhostSuggestionRef.current = true;
    params.setQuery(nextValue);
    params.setInputValue(nextValue);
    params.setSelectedActionIndex((prev: number) => (prev >= 0 ? -1 : prev));
    return true;
  };

  return (event: SearchKeyboardEvent) => {
    const e = event;
    const lowerKey = e.key.toLowerCase();
    if (e.ctrlKey && lowerKey === "l") {
      e.preventDefault();
      e.stopPropagation();
      params.clearSearchInput();
      return;
    }

    if (e.ctrlKey && lowerKey === "k") {
      e.preventDefault();
      e.stopPropagation();
      params.inputRef.current?.focus();
      return;
    }

    if (e.key === "Escape") {
      params.hideWindow();
      return;
    }

    if (e.altKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      e.stopPropagation();
      params.togglePanelPinned();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const idx = Math.max(
        0,
        params.enabledSearchTypeOptions.findIndex((t) => t.id === params.searchTypeId),
      );
      const delta = e.shiftKey ? -1 : 1;
      const nextIdx =
        (idx + delta + params.enabledSearchTypeOptions.length) % params.enabledSearchTypeOptions.length;
      const next = params.enabledSearchTypeOptions[nextIdx];
      params.typeSwitchRequestedRef.current = true;
      params.setGhostInputValue("");
      params.setSelectedActionIndex(-1);
      if (next) params.setSearchTypeId(next.id);
      params.setTypeMenuOpen(false);
      return;
    }

    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === "ArrowRight") {
      if (acceptGhostSuggestionByToken()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    if (params.results.length === 0) return;

    const acceptShortcut =
      params.settings.acceptSelectedResultShortcut || DEFAULT_SETTINGS.acceptSelectedResultShortcut;
    if (params.isShortcutPressed(e, acceptShortcut)) {
      if (params.acceptSelectedResultToInput()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      params.setLastSelectedBy("keyboard");
      params.setSelectedIndex((prev: number) => {
        const next = (prev + 1) % params.results.length;
        params.setGhostInputValue(
          params.resolveGhostCandidateByInput(params.inputValue, params.results[next]?.name || ""),
        );
        return next;
      });
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      params.setLastSelectedBy("keyboard");
      params.setSelectedIndex((prev: number) => {
        const next = (prev - 1 + params.results.length) % params.results.length;
        params.setGhostInputValue(
          params.resolveGhostCandidateByInput(params.inputValue, params.results[next]?.name || ""),
        );
        return next;
      });
      e.preventDefault();
    } else if (e.key === "Home") {
      params.setLastSelectedBy("keyboard");
      params.setGhostInputValue(
        params.resolveGhostCandidateByInput(params.inputValue, params.results[0]?.name || ""),
      );
      params.setSelectedIndex(0);
      e.preventDefault();
    } else if (e.key === "End") {
      params.setLastSelectedBy("keyboard");
      const next = Math.max(0, params.results.length - 1);
      params.setGhostInputValue(
        params.resolveGhostCandidateByInput(params.inputValue, params.results[next]?.name || ""),
      );
      params.setSelectedIndex(next);
      e.preventDefault();
    } else if (e.key === "PageDown") {
      params.setLastSelectedBy("keyboard");
      params.setSelectedIndex((prev: number) => {
        const next = Math.min(params.results.length - 1, prev + 10);
        params.setGhostInputValue(
          params.resolveGhostCandidateByInput(params.inputValue, params.results[next]?.name || ""),
        );
        return next;
      });
      e.preventDefault();
    } else if (e.key === "PageUp") {
      params.setLastSelectedBy("keyboard");
      params.setSelectedIndex((prev: number) => {
        const next = Math.max(0, prev - 10);
        params.setGhostInputValue(
          params.resolveGhostCandidateByInput(params.inputValue, params.results[next]?.name || ""),
        );
        return next;
      });
      e.preventDefault();
    } else if (e.key === "Enter") {
      const selected = params.results[params.selectedIndex];
      if (!selected) return;
      if (selected.type === "calc") {
        e.preventDefault();
        e.stopPropagation();
        params.copyCalcResult(selected);
        return;
      }
      if (e.ctrlKey) params.openFolder(selected);
      else params.launchApp(selected);
    }
  };
}

/** 构建核心键盘处理函数 */
export function createHandleKeyDownCore(params: SearchKeyboardCoreParams) {
  return (event: SearchKeyboardEvent) => {
    const e = event;
    const isComposing =
      "isComposing" in e ? Boolean((e as { isComposing?: boolean }).isComposing) : Boolean(e.nativeEvent?.isComposing);
    if (isComposing) return;

    const keyLower = String(e.key || "").toLowerCase();
    const isTogglePinShortcut = e.altKey && (keyLower === "t" || String(e.code || "") === "KeyT");
    if (isTogglePinShortcut) {
      e.preventDefault();
      e.stopPropagation();
      params.togglePanelPinned();
      return;
    }

    if (params.selectedActionIndex >= 0 && e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
      params.setSelectedActionIndex(-1);
    }

    if (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (params.results.length === 0) return;
      const item = params.results[params.selectedIndex];
      const ids = params.getVisibleActionIdsForItem(item);
      if (ids.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      params.setLastSelectedBy("keyboard");
      params.setSelectedActionIndex((prev: number) => {
        const nextPrev = typeof prev === "number" ? prev : -1;
        if (nextPrev < 0) return 0;
        const delta = e.key === "ArrowRight" ? 1 : -1;
        return (nextPrev + delta + ids.length) % ids.length;
      });
      return;
    } else {
      params.setSelectedActionIndex(-1);
    }

    if (e.key === "Enter" && params.selectedActionIndex >= 0) {
      if (params.results.length === 0) return;
      const item = params.results[params.selectedIndex];
      const ids = params.getVisibleActionIdsForItem(item);
      const id =
        params.selectedActionIndex >= 0 && params.selectedActionIndex < ids.length
          ? ids[params.selectedActionIndex]
          : "";
      if (!id) return;

      e.preventDefault();
      e.stopPropagation();
      params.setSelectedActionIndex(-1);

      if (id === "openFolder") params.openFolder(item);
      else if (id === "copyPath") params.copyPath(item);
      else if (id === "runAsAdmin") params.runAsAdmin(item);
      else if (id === "deleteHistory") void params.deleteResultItem(item);
      return;
    }

    if (e.key === "ArrowDown") {
      if (params.selectedActionIndex >= 0) params.setSelectedActionIndex(-1);
    } else if (e.key === "ArrowUp") {
      if (params.selectedActionIndex >= 0) params.setSelectedActionIndex(-1);
    }

    params.handleKeyDownCapture(e);
  };
}
