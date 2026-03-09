import { globalShortcut, dialog } from 'electron';

const HOTKEY_COOLDOWN_MS = 220;

export function registerShortcuts(input: {
	getSearchShortcut: () => string;
	getSettingsShortcut: () => string;
	openSearchWindow: () => void;
	showSettingsWindow: () => void;
}) {
	globalShortcut.unregisterAll();

	let lastSearchAt = 0;
	let lastSettingsAt = 0;

	const okSearch = globalShortcut.register(input.getSearchShortcut(), () => {
		const now = Date.now();
		if (now - lastSearchAt < HOTKEY_COOLDOWN_MS) return;
		lastSearchAt = now;
		input.openSearchWindow();
	});

	const okSettings = globalShortcut.register(input.getSettingsShortcut(), () => {
		const now = Date.now();
		if (now - lastSettingsAt < HOTKEY_COOLDOWN_MS) return;
		lastSettingsAt = now;
		input.showSettingsWindow();
	});

	if (!okSearch) dialog.showErrorBox('快捷键注册失败', `无法注册呼出搜索框快捷键：${input.getSearchShortcut()}`);
	if (!okSettings) dialog.showErrorBox('快捷键注册失败', `无法注册呼出设置界面快捷键：${input.getSettingsShortcut()}`);
}

