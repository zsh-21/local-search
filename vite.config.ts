import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
	const isServe = command === 'serve';

	return {
		plugins: [
			react(),
			electron([
				{
					entry: 'electron/main.ts',
					onstart({ startup }) {
						if (isServe) startup();
					},
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
