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

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);
const IMAGE_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;
const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none"><rect x="12" y="6" width="40" height="52" rx="6" stroke="#94a3b8" stroke-width="4"/><path d="M36 6v16h16" stroke="#94a3b8" stroke-width="4"/></svg>`;
const FALLBACK_SVG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(FALLBACK_SVG).toString('base64')}`;

const BUNDLED_ICON_DIR = (() => {
	const candidates: string[] = [];
	try {
		const cwd = process.cwd();
		if (cwd) candidates.push(path.join(cwd, 'public'));
	} catch {}
	try {
		const appPath = app.getAppPath();
		if (appPath) {
			candidates.push(path.join(appPath, 'public'));
			candidates.push(path.join(appPath, '..', 'public'));
		}
	} catch {}
	for (const dir of candidates) {
		const iconDir = path.join(dir, 'file-icons');
		if (existsSync(iconDir)) return iconDir;
	}
	return '';
})();

const bundledIconDataCache = new Map<string, string>();
// 鍗曢闃熷垪锛氱浉鍚?key 鐨勫苟鍙戝浘鏍囪姹傚彧鎵ц涓€娆★紝鍏朵粬璇锋眰澶嶇敤缁撴灉
const fileIconInFlight = new Map<string, Promise<string>>();
const appIconInFlight = new Map<string, Promise<string>>();
const IS_DEV_ICON_LOG = !app.isPackaged || process.env.NODE_ENV === 'development';

const EXT_ICON_MAP: Record<string, string> = {
	'.doc': 'file-text.svg',
	'.docx': 'file-text.svg',
	'.xls': 'file-spreadsheet.svg',
	'.xlsx': 'file-spreadsheet.svg',
	'.ppt': 'file-text.svg',
	'.pptx': 'file-text.svg',
	'.pdf': 'file-text.svg',
	'.txt': 'file-text.svg',
	'.md': 'file-text.svg',
	'.rtf': 'file-text.svg',
	'.jpg': 'file-image.svg',
	'.jpeg': 'file-image.svg',
	'.png': 'file-image.svg',
	'.gif': 'file-image.svg',
	'.bmp': 'file-image.svg',
	'.webp': 'file-image.svg',
	'.svg': 'file-image.svg',
	'.ico': 'file-image.svg',
	'.mp3': 'file.svg',
	'.mp4': 'file.svg',
	'.avi': 'file.svg',
	'.mkv': 'file.svg',
	'.zip': 'file-archive.svg',
	'.rar': 'file-archive.svg',
	'.7z': 'file-archive.svg',
	'.iso': 'file-archive.svg',
	'.exe': 'binary.svg',
	'.msi': 'package.svg',
	'.apk': 'package.svg',
	'.dmg': 'package.svg',
	'.html': 'file-code.svg',
	'.htm': 'file-code.svg',
	'.css': 'file-code.svg',
	'.js': 'file-code.svg',
	'.ts': 'file-code.svg',
	'.vue': 'file-code.svg',
	'.jsx': 'file-code.svg',
	'.tsx': 'file-code.svg',
	'.json': 'file-code.svg',
	'.py': 'file-code.svg',
	'.java': 'file-code.svg',
	'.c': 'file-code.svg',
	'.cpp': 'file-code.svg',
	'.go': 'file-code.svg',
	'.php': 'file-code.svg',
	'.rb': 'file-code.svg',
	'.sh': 'file-code.svg',
	'.bat': 'file-code.svg',
	'.sql': 'file-code.svg',
	'.xml': 'file-cog.svg',
	'.yml': 'file-cog.svg',
	'.yaml': 'file-cog.svg',
	'.ini': 'file-cog.svg',
	'.log': 'file-text.svg',
	'.dll': 'binary.svg',
	'.gitignore': 'file-cog.svg',
	'.msc': 'file-cog.svg',
};

function getBundledIconDataByName(name: string) {
	if (!name || !BUNDLED_ICON_DIR) return '';
	const key = name.toLowerCase();
	const cached = bundledIconDataCache.get(key);
	if (cached) return cached;
	const fullPath = path.join(BUNDLED_ICON_DIR, name);
	if (!existsSync(fullPath)) return '';
	try {
		const buf = readFileSync(fullPath);
		const dataUrl = `data:image/svg+xml;base64,${buf.toString('base64')}`;
		bundledIconDataCache.set(key, dataUrl);
		return dataUrl;
	} catch {
		return '';
	}
}

function getBundledIconForPath(filePath: string) {
	if (!filePath) return '';
	try {
		if (existsSync(filePath)) {
			const st = statSync(filePath);
			if (st.isDirectory()) return getBundledIconDataByName('folder.svg');
		}
	} catch {}
	const ext = path.extname(filePath).toLowerCase();
	const iconName = EXT_ICON_MAP[ext] || 'file.svg';
	return getBundledIconDataByName(iconName);
}

function getImageMimeByExt(ext: string) {
	switch (ext) {
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg';
		case '.png':
			return 'image/png';
		case '.gif':
			return 'image/gif';
		case '.bmp':
			return 'image/bmp';
		case '.webp':
			return 'image/webp';
		case '.ico':
			return 'image/x-icon';
		case '.svg':
			return 'image/svg+xml';
		default:
			return 'application/octet-stream';
	}
}

function buildImageDataUrl(filePath: string, ext: string) {
	try {
		const st = statSync(filePath);
		if (!Number.isFinite(st.size) || st.size <= 0) return '';
		if (st.size > IMAGE_FALLBACK_MAX_BYTES) return '';
		const buf = readFileSync(filePath);
		const mime = getImageMimeByExt(ext);
		return `data:${mime};base64,${buf.toString('base64')}`;
	} catch {
		return '';
	}
}

function normalizeIconFileSpec(spec: string) {
	// 缁熶竴澶嶇敤 shortcuts 灞傜殑璺緞瑙勬牸娓呮礂锛岀‘淇濆浘鏍囪В鏋愪笌蹇嵎鏂瑰紡鍚姩瑙勫垯涓€鑷?
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
	// 浠呭紑鍙戠幆澧冭緭鍑猴紝閬垮厤鐢熶骇鐜楂橀妫€绱㈤€犳垚鏃ュ織鍣煶
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
					// 鍥炬爣鎻愬彇浜岀骇鍏滃簳锛欼conLocation 澶辫触鍚庢敼涓虹洰鏍囪矾寰勬彁鍙栵紝鍏煎绯荤粺蹇嵎鏂瑰紡
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
			// .msc 甯歌浜庣郴缁熺鐞嗗伐鍏凤細甯歌鎻愬彇澶辫触鏃惰蛋绯荤粺宸ュ叿鏄犲皠鍏滃簳
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

		// 绗竴灞傦細鑻ユ潵婧愭槸蹇嵎鏂瑰紡锛屼紭鍏堟寜 IconLocation 鎻愬彇锛屽啀鍥為€€鍒板揩鎹锋柟寮忕洰鏍?
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

		// 绗簩灞傦細璇诲彇鐩爣鏂囦欢鏈韩鍥炬爣锛坋xe/dll/ico 绛夛級
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

		// 绗笁灞傦細绯荤粺宸ュ叿鏄犲皠鍏滃簳锛岃鐩?.msc 涓庡父瑙佺鐞嗗伐鍏峰埆鍚?
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
		// 鏈€鍚庝竴灞傦細淇濈暀榛樿鍥炬爣锛岀‘淇濆浘鏍囧け璐ヤ笉浼氶樆鏂悳绱㈠拰灞曠ず
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
			// 鍘嗗彶鍥炬爣鍚屾牱澶嶇敤缁熶竴娓呮礂锛岄伩鍏嶅揩鎹锋柟寮忓弬鏁版牸寮忓奖鍝嶅浘鏍囧懡涓?
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

