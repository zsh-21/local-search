import type { MutableRefObject, RefObject } from "react";
import type { AppSettings } from "../appTypes";
import {
  DEFAULT_SETTINGS,
  SEARCH_ITEM_HEIGHT_COMPACT,
  SEARCH_ITEM_HEIGHT_NORMAL,
  SEARCH_LIST_MIN_HEIGHT,
  SEARCH_WINDOW_BOTTOM_BAR_HEIGHT,
  SEARCH_WINDOW_MIN_HEIGHT,
  SEARCH_WINDOW_TOP_BAR_HEIGHT,
  TYPE_MENU_MIN_LIST_SPACE,
} from "../constants/initialValues";
import { IPC_RESIZE_WINDOW } from "../../shared/ipc/channels";

type ResizePayload = { height: number; minHeight: number; maxHeight: number };
type ResizeSearchWindowOptions = { includeTypeMenu?: boolean };
type ResizeSearchWindowParams = {
  opts?: ResizeSearchWindowOptions;
  containerRef: RefObject<HTMLDivElement>;
  typeMenuOpen: boolean;
  typeMenuRef: RefObject<HTMLDivElement>;
  settings: AppSettings;
  resultsLength: number;
  lastResizePayloadRef: MutableRefObject<ResizePayload | null>;
};

export function resizeSearchWindowToContent(params: ResizeSearchWindowParams) {
  const c = params.containerRef.current as HTMLElement | null;
  if (!c) return;

  const htmlEl = document.documentElement;
  const bodyEl = document.body;
  const containerRect = c.getBoundingClientRect();
  const docHeight = Math.max(htmlEl?.scrollHeight ?? 0, bodyEl?.scrollHeight ?? 0);
  let contentHeight = Math.ceil(c.scrollHeight > 0 ? c.scrollHeight : docHeight);
  const shouldIncludeMenu = params.opts?.includeTypeMenu ?? params.typeMenuOpen;
  const menuEl = shouldIncludeMenu ? params.typeMenuRef.current : null;
  if (menuEl) {
    const menuRect = menuEl.getBoundingClientRect();
    const needed = Math.ceil(menuRect.bottom - containerRect.top + 10);
    contentHeight = Math.max(contentHeight, needed, TYPE_MENU_MIN_LIST_SPACE);
  }

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const itemHeight = params.settings.compactMode ? SEARCH_ITEM_HEIGHT_COMPACT : SEARCH_ITEM_HEIGHT_NORMAL;
  const deviceMaxHeight = Math.floor(window.screen?.availHeight || 0);
  const settingMaxHeight =
    typeof params.settings.searchWindowMaxHeight === "number"
      ? params.settings.searchWindowMaxHeight
      : DEFAULT_SETTINGS.searchWindowMaxHeight;
  const hardUpper = Math.max(
    SEARCH_WINDOW_MIN_HEIGHT,
    Math.round(
      Math.min(settingMaxHeight, deviceMaxHeight > 0 ? deviceMaxHeight : settingMaxHeight),
    ),
  );
  const maxListHeight = Math.max(
    SEARCH_LIST_MIN_HEIGHT,
    Math.round(hardUpper) - SEARCH_WINDOW_TOP_BAR_HEIGHT - SEARCH_WINDOW_BOTTOM_BAR_HEIGHT,
  );
  const hasResults = params.resultsLength > 0;
  const renderedListHeight = hasResults
    ? Math.max(itemHeight, Math.min(params.resultsLength * itemHeight, maxListHeight))
    : 0;

  const resultsEl = c.querySelector(".results") as HTMLElement | null;
  const searchBoxEl = c.querySelector(".search-box") as HTMLElement | null;
  const statusEl = c.querySelector(".status") as HTMLElement | null;
  const anchorEl = statusEl ?? searchBoxEl;

  let minHeightBySearchArea = SEARCH_WINDOW_MIN_HEIGHT;
  if (resultsEl) {
    const resultsRect = resultsEl.getBoundingClientRect();
    minHeightBySearchArea = Math.max(
      SEARCH_WINDOW_MIN_HEIGHT,
      Math.ceil(contentHeight - Math.max(0, resultsRect.height)),
    );
  } else if (anchorEl) {
    const anchorRect = anchorEl.getBoundingClientRect();
    minHeightBySearchArea = Math.max(
      SEARCH_WINDOW_MIN_HEIGHT,
      Math.ceil(anchorRect.bottom - containerRect.top),
    );
  }

  const minHeightByOneResult = hasResults
    ? Math.max(
        SEARCH_WINDOW_MIN_HEIGHT,
        Math.ceil(contentHeight - renderedListHeight + itemHeight),
      )
    : minHeightBySearchArea;

  let boundedMaxHeight = clamp(Math.ceil(contentHeight), SEARCH_WINDOW_MIN_HEIGHT, hardUpper);
  let boundedMinHeight = clamp(
    Math.ceil(minHeightByOneResult),
    SEARCH_WINDOW_MIN_HEIGHT,
    boundedMaxHeight,
  );

  if (menuEl) {
    const menuRect = menuEl.getBoundingClientRect();
    const menuNeeded = clamp(
      Math.ceil(menuRect.bottom - containerRect.top + 10),
      SEARCH_WINDOW_MIN_HEIGHT,
      hardUpper,
    );
    boundedMaxHeight = Math.max(boundedMaxHeight, menuNeeded);
    boundedMinHeight = Math.min(
      boundedMaxHeight,
      Math.max(boundedMinHeight, menuNeeded),
    );
  }

  const nextHeight = clamp(Math.ceil(contentHeight), boundedMinHeight, boundedMaxHeight);
  const nextPayload = {
    height: nextHeight,
    minHeight: boundedMinHeight,
    maxHeight: boundedMaxHeight,
  };
  const prevPayload = params.lastResizePayloadRef.current;
  if (
    prevPayload &&
    prevPayload.height === nextPayload.height &&
    prevPayload.minHeight === nextPayload.minHeight &&
    prevPayload.maxHeight === nextPayload.maxHeight
  ) {
    return;
  }
  params.lastResizePayloadRef.current = nextPayload;
  window.ipcRenderer?.invoke(IPC_RESIZE_WINDOW, nextHeight, undefined, {
    minHeight: boundedMinHeight,
    maxHeight: boundedMaxHeight,
  });
}
