import { app, Tray, Menu, dialog } from 'electron';
import path from 'node:path';

export function ensureTray(input: {
	getIconPath: () => string;
	toggleSearchWindow: () => void;
	showSettingsWindow: () => void;
	onAddQuickItemPath: (filePath: string) => void | Promise<void>;
}) {
	try {
		const tray = new Tray(input.getIconPath());
		const contextMenu = Menu.buildFromTemplate([
			{
				label: '显示搜索框',
				click: () => input.toggleSearchWindow(),
			},
			{
				label: '新增文件到FileSearch的快捷列表',
				click: () => void addQuickItemFromDialog(input.onAddQuickItemPath),
			},
			{
				label: '设置',
				click: () => input.showSettingsWindow(),
			},
			{ type: 'separator' },
			{ label: '退出', click: () => app.quit() },
		]);
		tray.setToolTip('File Search');
		tray.setContextMenu(contextMenu);
		tray.on('click', () => {
			input.toggleSearchWindow();
		});
		return tray;
	} catch {
		return null;
	}
}

async function addQuickItemFromDialog(onPicked: (filePath: string) => void | Promise<void>) {
	try {
		const result = await dialog.showOpenDialog({
			title: '添加到 File Search 快捷列表',
			buttonLabel: '添加',
			properties: ['openFile'],
			filters: [{ name: '应用/快捷方式', extensions: ['exe', 'lnk', 'url'] }],
		});
		if (result.canceled) return;
		const targetPath = result.filePaths?.[0];
		if (!targetPath) return;
		await onPicked(targetPath);
	} catch {}
}

export function getDefaultTrayIconPath() {
	return path.join(process.env.VITE_PUBLIC || '', 'tray.png');
}

