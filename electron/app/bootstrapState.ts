import { AppSettings, loadSettings } from '../config/settings';
import { loadHistory, isExistingTarget } from '../history/history';
import { getHistoryIconForPath } from '../icon/iconService';

export type BootstrapHistoryItem = {
  name: string;
  path: string;
  type: string;
  icon?: string;
};

export type BootstrapIndexStatus = {
  isIndexing: boolean;
  hasCache: boolean;
};

type BootstrapState = {
  settings: AppSettings;
  history: BootstrapHistoryItem[];
  indexStatus: BootstrapIndexStatus;
};

const bootstrapState: BootstrapState = {
  settings: loadSettings(),
  history: [],
  indexStatus: {
    isIndexing: false,
    hasCache: false,
  },
};

// 启动快照缓存：主进程启动后先把设置/历史准备进内存，后续窗口直接读这份状态。
export async function refreshBootstrapHistory(settings = bootstrapState.settings) {
  const history =
    settings.historyLimit > 0 ? loadHistory().filter((item) => isExistingTarget(item)).slice(0, settings.historyLimit) : [];

  const results = await Promise.all(
    history.map(async (item) => {
      const iconData = await getHistoryIconForPath({ type: item.type, name: item.name, path: item.path });
      return {
        name: item.name,
        path: item.path,
        type: item.type,
        icon: iconData,
      };
    }),
  );

  bootstrapState.history = results;
  return results;
}

export async function primeBootstrapState(initialSettings?: AppSettings) {
  bootstrapState.settings = initialSettings ?? loadSettings();
  await refreshBootstrapHistory(bootstrapState.settings);
  return getBootstrapState();
}

export function setBootstrapSettings(settings: AppSettings) {
  bootstrapState.settings = settings;
}

export function setBootstrapIndexStatus(next: Partial<BootstrapIndexStatus>) {
  bootstrapState.indexStatus = {
    ...bootstrapState.indexStatus,
    ...next,
  };
}

export function getBootstrapState() {
  return {
    settings: bootstrapState.settings,
    history: [...bootstrapState.history],
    indexStatus: { ...bootstrapState.indexStatus },
  };
}
