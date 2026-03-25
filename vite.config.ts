import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
	const isServe = command === 'serve';

	return {
		server: {
			watch: {
				ignored: ['**/release-build/**', '**/dist-electron/**', '**/dist/**'],
			},
		},
		plugins: [
			react(),
			electron([
				{
					entry: 'electron/main.ts',
					onstart({ startup }) {
						if (isServe) startup();
					},
				},
				// FileIndex Worker：把索引构建/搜索等长任务放到 Worker 线程，避免主线程卡顿
				{
					entry: 'electron/fileIndex.worker.ts',
				},
				{
					entry: 'electron/search/searchMatch.worker.ts',
				},
				{
					entry: 'electron/preload.ts',
					onstart({ reload }) {
						if (isServe) reload();
					},
				},
			]),
		],
	};
});
