export function getWindowsSettingsItems() {
	if (process.platform !== 'win32') return [] as Array<{ name: string; uri: string }>;
	return [
		{ name: '系统设置', uri: 'ms-settings:' },
		{ name: '网络和 Internet', uri: 'ms-settings:network' },
		{ name: 'Wi‑Fi', uri: 'ms-settings:network-wifi' },
		{ name: '以太网', uri: 'ms-settings:network-ethernet' },
		{ name: 'VPN', uri: 'ms-settings:network-vpn' },
		{ name: '代理', uri: 'ms-settings:network-proxy' },
		{ name: '蓝牙和设备', uri: 'ms-settings:bluetooth' },
		{ name: '显示', uri: 'ms-settings:display' },
		{ name: '夜间模式', uri: 'ms-settings:nightlight' },
		{ name: '声音', uri: 'ms-settings:sound' },
		{ name: '通知', uri: 'ms-settings:notifications' },
		{ name: '电源和电池', uri: 'ms-settings:batterysaver' },
		{ name: '存储', uri: 'ms-settings:storagesense' },
		{ name: '应用', uri: 'ms-settings:appsfeatures' },
		{ name: '默认应用', uri: 'ms-settings:defaultapps' },
		{ name: '启动', uri: 'ms-settings:startupapps' },
		{ name: '时间和语言', uri: 'ms-settings:dateandtime' },
		{ name: '语言', uri: 'ms-settings:regionlanguage' },
		{ name: '键盘', uri: 'ms-settings:keyboard' },
		{ name: '鼠标', uri: 'ms-settings:mousetouchpad' },
		{ name: '个性化', uri: 'ms-settings:personalization' },
		{ name: '任务栏', uri: 'ms-settings:taskbar' },
		{ name: '主题', uri: 'ms-settings:themes' },
		{ name: '账户', uri: 'ms-settings:yourinfo' },
		{ name: '登录选项', uri: 'ms-settings:signinoptions' },
		{ name: 'Windows 更新', uri: 'ms-settings:windowsupdate' },
		{ name: '隐私和安全', uri: 'ms-settings:privacy' },
		{ name: '开发者选项', uri: 'ms-settings:developers' },
		{ name: '关于', uri: 'ms-settings:about' },
	];
}

export function searchSettingsItems(input: {
	searchTypeId: string;
	settingsItems: Array<{ name: string; uri: string }>;
	computeWeightedNameMatch: (name: string) => { weightedScore: number; matchIndex: number };
	computeCombinedScore: (baseScore: number, type: string, rawPath: string, timeMs: number) => number;
	getLastUsedMs: (rawPath: string) => number;
}) {
	const { searchTypeId, settingsItems, computeWeightedNameMatch, computeCombinedScore, getLastUsedMs } = input;
	if (searchTypeId !== 'all' && searchTypeId !== 'settings') return { settingsResults: [], settingsOnly: null as any };

	const run = () => {
		const out: Array<{ name: string; path: string; type: string; score: number }> = [];
		for (const it of settingsItems) {
			const weighted = computeWeightedNameMatch(it.name);
			if (weighted.weightedScore <= 0) continue;
			const baseScore = weighted.weightedScore * 400 + (weighted.matchIndex <= 2 ? 1500 : 0);
			const score = computeCombinedScore(baseScore, 'settings', it.uri, getLastUsedMs(it.uri));
			out.push({ name: it.name, path: it.uri, type: 'settings', score });
		}
		return out;
	};

	if (searchTypeId === 'settings') {
		const out = run();
		const merged = out
			.sort((a, b) => (b.score || 0) - (a.score || 0))
			.slice(0, 100)
			.map(({ score, ...rest }) => rest);
		return { settingsResults: [], settingsOnly: { results: merged, totalCount: out.length } };
	}

	return { settingsResults: run(), settingsOnly: null };
}

