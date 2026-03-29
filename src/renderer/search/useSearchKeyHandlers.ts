import { useCallback, useMemo, type MutableRefObject, type RefObject } from "react";
import { AppItem, AppSettings, SearchTypeOption } from "../appTypes";
import {
  createHandleKeyDownCapture,
  createHandleKeyDownCore,
  isShortcutPressed,
  type SearchKeyboardCaptureParams,
  type SearchKeyboardCoreParams,
} from "./searchKeyboardHandlers";

type Params = {
  inputValue: string;
  ghostInputValue: string;
  inputRef: RefObject<HTMLInputElement>;
  preserveGhostSuggestionRef: MutableRefObject<boolean>;
  setQuery: (v: string) => void;
  setInputValue: (v: string) => void;
  setSelectedActionIndex: (v: number | ((prev: number) => number)) => void;
  clearSearchInput: () => void;
  hideWindow: () => void;
  togglePanelPinned: () => void;
  enabledSearchTypeOptions: SearchTypeOption[];
  searchTypeId: string;
  typeSwitchRequestedRef: MutableRefObject<boolean>;
  setGhostInputValue: (v: string) => void;
  setSearchTypeId: (v: string) => void;
  setTypeMenuOpen: (v: boolean) => void;
  results: AppItem[];
  settings: AppSettings;
  acceptSelectedResultToInput: () => boolean;
  setLastSelectedBy: (v: "keyboard" | "mouse") => void;
  setSelectedIndex: (v: number | ((prev: number) => number)) => void;
  resolveGhostCandidateByInput: (rawInput: string, candidateName: string) => string;
  selectedIndex: number;
  copyCalcResult: (item: AppItem | undefined) => void;
  openFolder: (item: AppItem) => void;
  launchApp: (item: AppItem) => void;
  selectedActionIndex: number;
  getVisibleActionIdsForItem: (item: AppItem | undefined) => AppSettings["resultActionButtons"];
  copyPath: (item: AppItem) => void;
  runAsAdmin: (item: AppItem) => void;
  deleteResultItem: (item: AppItem | undefined) => Promise<void>;
};

export function useSearchKeyHandlers(params: Params) {
  // 统一键盘处理逻辑，避免控制器中重复堆叠依赖
  const captureParams: SearchKeyboardCaptureParams = {
    inputValue: params.inputValue,
    ghostInputValue: params.ghostInputValue,
    inputRef: params.inputRef,
    preserveGhostSuggestionRef: params.preserveGhostSuggestionRef,
    setQuery: params.setQuery,
    setInputValue: params.setInputValue,
    setSelectedActionIndex: params.setSelectedActionIndex,
    clearSearchInput: params.clearSearchInput,
    hideWindow: params.hideWindow,
    togglePanelPinned: params.togglePanelPinned,
    enabledSearchTypeOptions: params.enabledSearchTypeOptions,
    searchTypeId: params.searchTypeId,
    typeSwitchRequestedRef: params.typeSwitchRequestedRef,
    setGhostInputValue: params.setGhostInputValue,
    setSearchTypeId: params.setSearchTypeId,
    setTypeMenuOpen: params.setTypeMenuOpen,
    results: params.results,
    settings: params.settings,
    isShortcutPressed,
    acceptSelectedResultToInput: params.acceptSelectedResultToInput,
    setLastSelectedBy: params.setLastSelectedBy,
    setSelectedIndex: params.setSelectedIndex,
    resolveGhostCandidateByInput: params.resolveGhostCandidateByInput,
    selectedIndex: params.selectedIndex,
    copyCalcResult: params.copyCalcResult,
    openFolder: params.openFolder,
    launchApp: params.launchApp,
  };
  const handleKeyDownCapture = createHandleKeyDownCapture(captureParams);

  const handleKeyDownCore = useMemo(
    () => {
      const coreParams: SearchKeyboardCoreParams = {
        selectedActionIndex: params.selectedActionIndex,
        setSelectedActionIndex: params.setSelectedActionIndex,
        results: params.results,
        selectedIndex: params.selectedIndex,
        getVisibleActionIdsForItem: params.getVisibleActionIdsForItem,
        setLastSelectedBy: params.setLastSelectedBy,
        openFolder: params.openFolder,
        copyPath: params.copyPath,
        runAsAdmin: params.runAsAdmin,
        deleteResultItem: params.deleteResultItem,
        togglePanelPinned: params.togglePanelPinned,
        handleKeyDownCapture,
      };
      return createHandleKeyDownCore(coreParams);
    },
    [
      params.selectedActionIndex,
      params.setSelectedActionIndex,
      params.results,
      params.selectedIndex,
      params.getVisibleActionIdsForItem,
      params.setLastSelectedBy,
      params.openFolder,
      params.copyPath,
      params.runAsAdmin,
      params.deleteResultItem,
      params.togglePanelPinned,
      handleKeyDownCapture,
    ],
  );

  const handleWindowKeyDownCapture = useCallback(
    (e: KeyboardEvent) => {
      handleKeyDownCore(e);
    },
    [handleKeyDownCore],
  );

  const handleReactKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      handleKeyDownCore(e);
    },
    [handleKeyDownCore],
  );

  return { handleKeyDownCapture: handleReactKeyDownCapture, handleWindowKeyDownCapture };
}
