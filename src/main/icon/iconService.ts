import { app, nativeImage } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolveAppId } from '../win/resolveAppId';
import { normalizeShortcutFileSpec, readUrlIconFile, resolveLnkByPowerShell } from '../win/shortcuts';
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from '../win/startMenuShortcutIndex';
import { iconDataCache, isTooSmallAppIconDataUrl, setIconCache } from './iconCache';
import { resolveWinSystemToolIconSpec, type WinSystemToolMatchInput } from './winSystemToolIconMap';
import { resolveUwpIconPathByAumid, clearUwpIconPathCache } from './uwpIconResolver';
import { prewarmInstalledAppIconsCore } from './iconPrewarm';
import {
  IMAGE_EXTENSIONS,
  FALLBACK_SVG_DATA_URL,
  getBundledIconDataByName,
  getBundledIconForPath,
  buildImageDataUrl,
} from './iconStaticAssets';

export {
  getBundledIconDataByName,
  getBundledIconForExtension,
  getDefaultCommandIconData,
  getDefaultFolderIconData,
  getDefaultSettingsIconData,
} from './iconStaticAssets';
// 单飞队列：相同 key 的并发图标请求只执行一次，其余请求复用结果
const fileIconInFlight = new Map<string, Promise<string>>();
const appIconInFlight = new Map<string, Promise<string>>();
const IS_DEV_ICON_LOG = !app.isPackaged || process.env.NODE_ENV === 'development';

function normalizeIconFileSpec(spec: string) {
	// 统一复用 shortcuts 层的路径规范清洗，保证图标解析与快捷方式启动规则一致
	return normalizeShortcutFileSpec(spec);
}

function anonymizeForIconLog(raw: string) {
	const value = String(raw || '').trim();
	if (!value) return '';
	const normalized = value.replace(/\//g, '\\');
	if (normalized.includes('\\')) {
		const parts = normalized.split('\\').filter(Boolean);
		const tail = parts.slice(-2).join('\\');
		return tail ? `...\\${tail}` : '...';
	}
	return value.length > 80 ? `${value.slice(0, 80)}...` : value;
}

function logAppIconFallbackFailure(payload: {
	appName: string;
	appId: string;
	normalizedSpec: string;
	fallbackStage: string;
	ruleId?: string;
}) {
	// 仅开发环境输出，避免生产环境高频检索造成日志噪音
	if (!IS_DEV_ICON_LOG) return;
	// console.warn('[icon] app icon fallback used', {
	// 	name: anonymizeForIconLog(payload.appName),
	// 	appId: anonymizeForIconLog(payload.appId),
	// 	normalizedSpec: anonymizeForIconLog(payload.normalizedSpec),
	// 	fallbackStage: payload.fallbackStage,
	// 	ruleId: payload.ruleId || '',
	// });
}

async function tryResolveSystemToolMappedIcon(input: WinSystemToolMatchInput) {
	const match = resolveWinSystemToolIconSpec(input);
	if (!match) return { iconData: '', ruleId: '', spec: '' };
	const normalizedSpec = normalizeIconFileSpec(match.iconSpec);
	const resolvedSpec = resolveAppId(normalizedSpec);
	if (resolvedSpec && existsSync(resolvedSpec)) {
		const iconData = await getFileIconData(resolvedSpec);
		return { iconData, ruleId: match.ruleId, spec: resolvedSpec };
	}
	return { iconData: '', ruleId: match.ruleId, spec: normalizedSpec };
}

async function tryResolveIconFromShortcutInfo(info: {
	targetPath?: string;
	arguments?: string;
	iconLocation?: string;
}) {
	let iconData = '';
	const normalizedIconSpec = normalizeIconFileSpec(info?.iconLocation || '');
	const resolvedIconSpec = resolveAppId(normalizedIconSpec);
	if (resolvedIconSpec && existsSync(resolvedIconSpec)) {
		const icon = await app.getFileIcon(resolvedIconSpec, { size: 'large' });
		if (!icon.isEmpty()) iconData = icon.toDataURL();
	}
	if (!iconData) {
		const normalizedTarget = normalizeIconFileSpec(info?.targetPath || '');
		const resolvedTarget = resolveAppId(normalizedTarget);
		if (resolvedTarget && existsSync(resolvedTarget)) {
			iconData = await getFileIconData(resolvedTarget);
		}
	}
	return { iconData, normalizedIconSpec };
}

async function getFileIconDataInternal(filePath: string) {
	const key = `file:${filePath}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string') return cached;
	let iconData = '';
	try {
		const normalizedSpecPath = resolveAppId(normalizeIconFileSpec(filePath));
		if (normalizedSpecPath && normalizedSpecPath.toLowerCase() !== filePath.toLowerCase() && existsSync(normalizedSpecPath)) {
			iconData = await getFileIconData(normalizedSpecPath);
		}
		if (iconData) {
			setIconCache(key, iconData);
			return iconData;
		}

		const ext = path.extname(filePath).toLowerCase();
		if ((ext === '.lnk' || ext === '.url') && existsSync(filePath)) {
			if (ext === '.lnk') {
				const info = await resolveLnkByPowerShell(filePath);
				const iconSpec = normalizeIconFileSpec(info?.iconLocation || '');
				const iconResolved = resolveAppId(iconSpec);
				if (iconResolved && existsSync(iconResolved)) {
					const icon = await app.getFileIcon(iconResolved, { size: 'large' });
					if (!icon.isEmpty()) iconData = icon.toDataURL();
				}
				if (!iconData) {
					// 图标提取二级兜底：IconLocation 失败后改用目标路径提取，兼容系统快捷方式
					const targetResolved = resolveAppId(normalizeIconFileSpec(info?.targetPath || ''));
					const sameTarget = targetResolved && targetResolved.toLowerCase() === resolveAppId(filePath).toLowerCase();
					if (targetResolved && !sameTarget && existsSync(targetResolved)) {
						iconData = await getFileIconData(targetResolved);
					}
				}
			} else if (ext === '.url') {
				const iconFile = normalizeIconFileSpec(readUrlIconFile(filePath));
				const iconResolved = resolveAppId(iconFile);
				if (iconResolved && existsSync(iconResolved)) {
					iconData = await getFileIconData(iconResolved);
				}
			}
		}

		if (!iconData && ext === '.msc') {
			// .msc 常见于系统管理工具：常规提取失败时走系统工具映射兜底
			const mapped = await tryResolveSystemToolMappedIcon({
				appId: filePath,
				normalizedAppId: normalizedSpecPath || filePath,
				targetPath: filePath,
			});
			if (mapped.iconData) iconData = mapped.iconData;
		}

		if (IMAGE_EXTENSIONS.has(ext) && existsSync(filePath)) {
			try {
				const img = nativeImage.createFromPath(filePath);
				if (!img.isEmpty()) {
					iconData = img.resize({ width: 64, height: 64, quality: 'better' }).toDataURL();
				}
			} catch (err) {
				console.error('Failed to generate image thumbnail:', err);
			}
			if (!iconData) {
				const dataUrl = buildImageDataUrl(filePath, ext);
				if (dataUrl) iconData = dataUrl;
			}
		}

		if (!iconData) {
			const icon = await app.getFileIcon(filePath, { size: 'large' });
			if (!icon.isEmpty()) iconData = icon.toDataURL();
		}
	} catch {}
	if (!iconData) {
		const bundled = getBundledIconForPath(filePath);
		if (bundled) iconData = bundled;
	}
	if (!iconData) iconData = FALLBACK_SVG_DATA_URL;
	if (iconData) setIconCache(key, iconData);
	return iconData;
}

export async function getFileIconData(filePath: string) {
	const key = `file:${filePath}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string') return cached;
	const inFlight = fileIconInFlight.get(key);
	if (inFlight) return inFlight;
	const task = getFileIconDataInternal(filePath).finally(() => {
		fileIconInFlight.delete(key);
	});
	fileIconInFlight.set(key, task);
	return task;
}

async function getAppIconDataInternal(appName: string, appId: string) {
	const key = `app:${appId}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string' && cached) {
		if (!isTooSmallAppIconDataUrl(cached)) return cached;
		iconDataCache.delete(key);
	}
	let iconData = '';
	let fallbackStage = 'unresolved';
	let mappedRuleId = '';
	let normalizedSpecForLog = '';
	let shortcutTargetForMap = '';
	let shortcutArgsForMap = '';
	let shortcutIconLocationForMap = '';
	try {
		const rawId = typeof appId === 'string' ? appId.trim() : '';
		const resolved = resolveAppId(rawId);
		const normalizedResolved = normalizeIconFileSpec(resolved);
		normalizedSpecForLog = normalizedResolved || rawId;
		const lowerResolved = normalizedResolved.toLowerCase();
		const isShortcutPath = lowerResolved.endsWith('.lnk') || lowerResolved.endsWith('.url');

		// 第一层：若来源是快捷方式，优先按 IconLocation 提取，再回退到快捷方式目标
		if (isShortcutPath && existsSync(normalizedResolved)) {
			if (lowerResolved.endsWith('.lnk')) {
				const shortcutInfo = await resolveLnkByPowerShell(normalizedResolved);
				if (shortcutInfo) {
					shortcutTargetForMap = shortcutInfo.targetPath || '';
					shortcutArgsForMap = shortcutInfo.arguments || '';
					shortcutIconLocationForMap = shortcutInfo.iconLocation || '';
					const fromShortcut = await tryResolveIconFromShortcutInfo(shortcutInfo);
					iconData = fromShortcut.iconData;
					if (fromShortcut.normalizedIconSpec) normalizedSpecForLog = fromShortcut.normalizedIconSpec;
				}
			} else if (lowerResolved.endsWith('.url')) {
				const iconFile = normalizeIconFileSpec(readUrlIconFile(normalizedResolved));
				const iconResolved = resolveAppId(iconFile);
				if (iconResolved && existsSync(iconResolved)) {
					iconData = await getFileIconData(iconResolved);
					normalizedSpecForLog = iconResolved;
				}
			}
		}

		// 第二层：读取目标文件本身图标（exe/dll/ico 等）
		if (!iconData && (normalizedResolved.includes('\\') || normalizedResolved.includes('/')) && existsSync(normalizedResolved)) {
			iconData = await getFileIconData(normalizedResolved);
			if (iconData) fallbackStage = 'resolved-path';
		}

		if (!iconData && rawId.includes('!')) {
			try {
				const icon = await app.getFileIcon(`shell:AppsFolder\\${rawId}`, { size: 'large' });
				if (!icon.isEmpty()) {
					const d = icon.toDataURL();
					if (d && d.length >= 900) iconData = d;
					if (iconData) fallbackStage = 'apps-folder';
				}
			} catch {}
		}

		if (!iconData) {
			await ensureStartMenuShortcutIndex();
			const shortcut = findStartMenuShortcutByName(appName);
			if (shortcut && existsSync(shortcut)) {
				const shortcutInfo = await resolveLnkByPowerShell(shortcut);
				if (shortcutInfo) {
					shortcutTargetForMap = shortcutInfo.targetPath || shortcutTargetForMap;
					shortcutArgsForMap = shortcutInfo.arguments || shortcutArgsForMap;
					shortcutIconLocationForMap = shortcutInfo.iconLocation || shortcutIconLocationForMap;
					const fromShortcut = await tryResolveIconFromShortcutInfo(shortcutInfo);
					iconData = fromShortcut.iconData;
					if (fromShortcut.normalizedIconSpec) normalizedSpecForLog = fromShortcut.normalizedIconSpec;
				}
				if (!iconData) iconData = await getFileIconData(shortcut);
				if (iconData) fallbackStage = 'start-menu-shortcut';
			}
		}

		// 第三层：系统工具映射兜底，覆盖 .msc 与常见管理工具别名
		if (!iconData) {
			const mapped = await tryResolveSystemToolMappedIcon({
				appName,
				appId: rawId,
				normalizedAppId: normalizedResolved,
				targetPath: shortcutTargetForMap || normalizedResolved,
				arguments: shortcutArgsForMap,
				iconLocation: shortcutIconLocationForMap,
			});
			if (mapped.iconData) {
				iconData = mapped.iconData;
				mappedRuleId = mapped.ruleId;
				normalizedSpecForLog = mapped.spec || normalizedSpecForLog;
				fallbackStage = 'system-tool-map';
			}
		}

		if (!iconData && rawId.includes('!')) {
			const iconPath = await resolveUwpIconPathByAumid(rawId);
			if (iconPath && existsSync(iconPath)) {
				try {
					const buf = readFileSync(iconPath);
					const img = nativeImage.createFromBuffer(buf);
					if (!img.isEmpty()) iconData = img.resize({ width: 64, height: 64, quality: 'better' }).toDataURL();
					if (!iconData) {
						const ext = path.extname(iconPath).toLowerCase();
						const mime =
							ext === '.jpg' || ext === '.jpeg'
								? 'image/jpeg'
								: ext === '.ico'
									? 'image/x-icon'
									: 'image/png';
						iconData = `data:${mime};base64,${buf.toString('base64')}`;
					}
					if (iconData) {
						normalizedSpecForLog = iconPath;
						fallbackStage = 'uwp-manifest';
					}
				} catch {}
			}
		}
	} catch {}
	if (!iconData) {
		logAppIconFallbackFailure({
			appName,
			appId,
			normalizedSpec: normalizedSpecForLog,
			fallbackStage,
			ruleId: mappedRuleId,
		});
		// 最后一层：保留默认图标，确保图标失败不会阻断搜索和展示
		iconData = getBundledIconDataByName('app-window.svg') || getBundledIconDataByName('file.svg') || '';
	}
	if (iconData) setIconCache(key, iconData);
	return iconData;
}

async function getAppIconData(appName: string, appId: string) {
	const key = `app:${appId}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string' && cached && !isTooSmallAppIconDataUrl(cached)) return cached;
	const inFlight = appIconInFlight.get(key);
	if (inFlight) return inFlight;
	const task = getAppIconDataInternal(appName, appId).finally(() => {
		appIconInFlight.delete(key);
	});
	appIconInFlight.set(key, task);
	return task;
}

export async function getAppIconDataStable(appName: string, appId: string, maxAttempts = 3) {
	const attempts = Math.max(1, Math.min(4, Number(maxAttempts) || 1));
	const waits = [0, 140, 320, 560];
	for (let i = 0; i < attempts; i++) {
		const waitMs = waits[i] || 0;
		if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
		const icon = await getAppIconData(appName, appId);
		if (icon) return icon;
	}
	return '';
}

export async function prewarmInstalledAppIcons(items: Array<{ Name: string; AppID: string }>, options?: { maxCount?: number; concurrency?: number }) {
	await prewarmInstalledAppIconsCore(items, options, { iconDataCache, isTooSmallAppIconDataUrl, getAppIconDataStable });
}

export async function clearIconCaches() {
	iconDataCache.clear(); fileIconInFlight.clear(); appIconInFlight.clear(); clearUwpIconPathCache();
}

export async function getHistoryIconForPath(input: { type: string; name: string; path: string }) {
	try {
		if (input.type === 'app') {
			return await getAppIconData(input.name, input.path);
		}
		const resolved = resolveAppId(input.path);
		const lower = resolved.toLowerCase();
		if (lower.endsWith('.lnk')) {
			const info = await resolveLnkByPowerShell(resolved);
			// 历史图标同样复用统一清洗，避免快捷方式参数格式影响图标命中
			const targetResolved = resolveAppId(normalizeIconFileSpec(info?.targetPath || ''));
			if (targetResolved && existsSync(targetResolved)) {
				return await getFileIconData(targetResolved);
			}
		}
		if (lower.endsWith('.url')) {
			const iconFile = normalizeIconFileSpec(readUrlIconFile(resolved));
			const iconResolved = resolveAppId(iconFile);
			if (iconResolved && existsSync(iconResolved)) {
				return await getFileIconData(iconResolved);
			}
		}
		if (existsSync(resolved)) return await getFileIconData(resolved);
	} catch {}
	return '';
}

