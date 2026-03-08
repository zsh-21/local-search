export function prefetchIconsInBackground(input: {
	event: Electron.IpcMainInvokeEvent;
	query: string;
	searchTypeId: string;
	searchSessionId: string;
	items: Array<{ name: string; path: string; type: string }>;
	iconDataCache: Map<string, string>;
	getFileIconData: (filePath: string) => Promise<string>;
	getAppIconDataStable: (appName: string, appId: string, maxAttempts?: number) => Promise<string>;
	getCurrentIconPrefetchToken: () => number;
	iconPrefetchToken: number;
}) {
	const {
		event,
		query,
		searchTypeId,
		searchSessionId,
		items,
		iconDataCache,
		getFileIconData,
		getAppIconDataStable,
		getCurrentIconPrefetchToken,
		iconPrefetchToken,
	} = input;

	(async () => {
		const batchSize = 32;
		for (let i = 0; i < items.length; i += batchSize) {
			if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;
			const batch = items.slice(i, i + batchSize);
			const updates: Array<{ name: string; path: string; type: string; icon: string }> = [];

			for (const it of batch) {
				if (iconPrefetchToken !== getCurrentIconPrefetchToken()) return;
				if (!it?.path) continue;
				if (it.type === 'file' || it.type === 'folder') {
					const key = `file:${it.path}`;
					const cached = iconDataCache.get(key) || '';
					if (cached) {
						updates.push({ ...it, icon: cached });
						continue;
					}
					const icon = await getFileIconData(it.path);
					if (typeof icon === 'string' && icon) updates.push({ ...it, icon });
					continue;
				}
				if (it.type === 'app') {
					const key = `app:${it.path}`;
					const cached = iconDataCache.get(key) || '';
					if (cached) {
						updates.push({ ...it, icon: cached });
						continue;
					}
					const icon = await getAppIconDataStable(it.name, it.path, 2);
					if (typeof icon === 'string' && icon) updates.push({ ...it, icon });
					continue;
				}
			}

			if (updates.length > 0) {
				event.sender.send('more-results', {
					query,
					searchTypeId,
					searchSessionId,
					results: updates,
				});
			}
			const sleepMs = i === 0 ? 0 : 8;
			if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
			else await new Promise((resolve) => setImmediate(resolve as any));
		}
	})();
}

