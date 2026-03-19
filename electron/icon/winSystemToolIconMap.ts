interface WinSystemToolIconRule {
	id: string;
	nameKeywords: string[];
	appIdKeywords: string[];
	targetKeywords: string[];
	iconSpec: string;
}

export interface WinSystemToolMatchInput {
	appName?: string;
	appId?: string;
	normalizedAppId?: string;
	targetPath?: string;
	arguments?: string;
	iconLocation?: string;
}

export interface WinSystemToolMatchResult {
	ruleId: string;
	iconSpec: string;
}

// \u5185\u7f6e\u7cfb\u7edf\u5de5\u5177\u6620\u5c04\uff1a\u4f18\u5148\u4fdd\u8bc1\u56fe\u6807\u7a33\u5b9a\u53ef\u5f97\uff0c\u5e76\u652f\u6301\u540e\u7eed\u6269\u5c55
const defaultRules: WinSystemToolIconRule[] = [
	{
		id: 'computer-management',
		nameKeywords: ['\u8ba1\u7b97\u673a\u7ba1\u7406', 'computer management'],
		appIdKeywords: ['compmgmt.msc', 'compmgmtlauncher'],
		targetKeywords: ['compmgmt.msc', 'compmgmtlauncher'],
		iconSpec: '%SystemRoot%\\System32\\CompMgmtLauncher.exe',
	},
	{
		id: 'performance-monitor',
		nameKeywords: ['\u6027\u80fd\u76d1\u89c6\u5668', 'performance monitor'],
		appIdKeywords: ['perfmon.msc', 'perfmon.exe'],
		targetKeywords: ['perfmon.msc', 'perfmon.exe'],
		iconSpec: '%SystemRoot%\\System32\\perfmon.exe',
	},
	{
		id: 'resource-monitor',
		nameKeywords: ['\u8d44\u6e90\u76d1\u89c6\u5668', 'resource monitor'],
		appIdKeywords: ['resmon.exe'],
		targetKeywords: ['resmon.exe'],
		iconSpec: '%SystemRoot%\\System32\\resmon.exe',
	},
	{
		id: 'device-manager',
		nameKeywords: ['\u8bbe\u5907\u7ba1\u7406\u5668', 'device manager'],
		appIdKeywords: ['devmgmt.msc', 'devmgmt'],
		targetKeywords: ['devmgmt.msc', 'devmgmt'],
		iconSpec: '%SystemRoot%\\System32\\mmc.exe',
	},
	{
		id: 'event-viewer',
		nameKeywords: ['\u4e8b\u4ef6\u67e5\u770b\u5668', 'event viewer'],
		appIdKeywords: ['eventvwr.msc', 'eventvwr.exe'],
		targetKeywords: ['eventvwr.msc', 'eventvwr.exe'],
		iconSpec: '%SystemRoot%\\System32\\eventvwr.exe',
	},
	{
		id: 'services',
		nameKeywords: ['\u670d\u52a1', 'services'],
		appIdKeywords: ['services.msc', 'services'],
		targetKeywords: ['services.msc', 'services'],
		iconSpec: '%SystemRoot%\\System32\\services.exe',
	},
	{
		id: 'task-scheduler',
		nameKeywords: ['\u4efb\u52a1\u8ba1\u5212\u7a0b\u5e8f', 'task scheduler'],
		appIdKeywords: ['taskschd.msc', 'taskschd'],
		targetKeywords: ['taskschd.msc', 'taskschd'],
		iconSpec: '%SystemRoot%\\System32\\mmc.exe',
	},
];

const extraRules: WinSystemToolIconRule[] = [];

function normalizeForMatch(input: string) {
	return String(input || '')
		.toLowerCase()
		.replace(/[\s._\-\\/[\](){},:;"'`~!@#$%^&*+=?|<>]+/g, '')
		.trim();
}

function scoreKeywordMatch(source: string, keywords: string[], weight: number) {
	if (!source || keywords.length === 0) return 0;
	let score = 0;
	for (const keyword of keywords) {
		const k = normalizeForMatch(keyword);
		if (!k) continue;
		if (source === k) score += weight * 3;
		else if (source.includes(k)) score += weight;
	}
	return score;
}

function buildMatchSources(input: WinSystemToolMatchInput) {
	const appName = normalizeForMatch(input.appName || '');
	const appId = normalizeForMatch(input.appId || '');
	const normalizedAppId = normalizeForMatch(input.normalizedAppId || '');
	const targetPath = normalizeForMatch(input.targetPath || '');
	const args = normalizeForMatch(input.arguments || '');
	const iconLocation = normalizeForMatch(input.iconLocation || '');
	return { appName, appId, normalizedAppId, targetPath, args, iconLocation };
}

// \u9884\u7559\u6269\u5c55\u5165\u53e3\uff1a\u540e\u7eed\u53ef\u5728\u4e0d\u6539\u4e3b\u6d41\u7a0b\u7684\u524d\u63d0\u4e0b\u8ffd\u52a0\u6620\u5c04\u89c4\u5219
export function registerWinSystemToolIconRules(rules: WinSystemToolIconRule[]) {
	if (!Array.isArray(rules) || rules.length === 0) return;
	for (const rule of rules) {
		if (!rule?.id || !rule?.iconSpec) continue;
		extraRules.push(rule);
	}
}

export function resolveWinSystemToolIconSpec(input: WinSystemToolMatchInput): WinSystemToolMatchResult | null {
	const sources = buildMatchSources(input);
	const allRules = [...extraRules, ...defaultRules];
	let bestRule: WinSystemToolIconRule | null = null;
	let bestScore = 0;

	for (const rule of allRules) {
		const score =
			scoreKeywordMatch(sources.appName, rule.nameKeywords, 10) +
			scoreKeywordMatch(sources.appId, rule.appIdKeywords, 9) +
			scoreKeywordMatch(sources.normalizedAppId, rule.appIdKeywords, 9) +
			scoreKeywordMatch(sources.targetPath, rule.targetKeywords, 8) +
			scoreKeywordMatch(sources.args, rule.targetKeywords, 6) +
			scoreKeywordMatch(sources.iconLocation, rule.targetKeywords, 6);
		if (score > bestScore) {
			bestScore = score;
			bestRule = rule;
		}
	}

	if (!bestRule || bestScore <= 0) return null;
	return { ruleId: bestRule.id, iconSpec: bestRule.iconSpec };
}