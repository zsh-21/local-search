import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import react from '@vitejs/plugin-react';
import renderer from 'vite-plugin-electron-renderer';

export default defineConfig(({ command }) => {
	const isServe = command === 'serve';

	return {
		plugins: [
			react(),
			renderer(),
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
