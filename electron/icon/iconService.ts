import { app, nativeImage } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveAppId } from '../win/resolveAppId';
import { normalizeShortcutFileSpec, readUrlIconFile, resolveLnkByPowerShell } from '../win/shortcuts';
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from '../win/startMenuShortcutIndex';
import { iconDataCache, isTooSmallAppIconDataUrl, setIconCache } from './iconCache';
import { resolveWinSystemToolIconSpec, type WinSystemToolMatchInput } from './winSystemToolIconMap';

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
// 单飞队列：相同 key 的并发图标请求只执行一次，其他请求复用结果
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
	// 统一复用 shortcuts 层的路径规格清洗，确保图标解析与快捷方式启动规则一致
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
	console.warn('[icon] app icon fallback used', {
		name: anonymizeForIconLog(payload.appName),
		appId: anonymizeForIconLog(payload.appId),
		normalizedSpec: anonymizeForIconLog(payload.normalizedSpec),
		fallbackStage: payload.fallbackStage,
		ruleId: payload.ruleId || '',
	});
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
					// 图标提取二级兜底：IconLocation 失败后改为目标路径提取，兼容系统快捷方式
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

const uwpIconPathCache = new Map<string, string>();
const uwpIconPathInFlight = new Map<string, Promise<string>>();

function resolveUwpIconPathByAumid(aumid: string): Promise<string> {
	const key = String(aumid || '').trim();
	if (!key || !key.includes('!')) return Promise.resolve('');
	const cached = uwpIconPathCache.get(key);
	if (typeof cached === 'string' && cached) return Promise.resolve(cached);
	const inflight = uwpIconPathInFlight.get(key);
	if (inflight) return inflight;

	const task = new Promise<string>((resolve) => {
		try {
			const escaped = key.replace(/'/g, "''");
			const cmd = [
				`$aumid='${escaped}';`,
				`$parts=$aumid -split '!',2;`,
				`$pfn=$parts[0];`,
				`$appId=if($parts.Length -gt 1){$parts[1]}else{''};`,
				`if(-not $pfn){ '' | Write-Output; exit 0 }`,
				`$pkg=$null;`,
				`try { $pkg=Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $pfn } | Select-Object -First 1 } catch { $pkg=$null }`,
				`if(-not $pkg){ try { $pkg=Get-AppxPackage -PackageFamilyName $pfn | Select-Object -First 1 } catch { $pkg=$null } }`,
				`if(-not $pkg){ try { $pkg=Get-AppxPackage -Name $pfn | Select-Object -First 1 } catch { $pkg=$null } }`,
				`if(-not $pkg -or -not $pkg.InstallLocation){ '' | Write-Output; exit 0 }`,
				`$root=$pkg.InstallLocation;`,
				`$mf=Join-Path $root 'AppxManifest.xml';`,
				`if(-not (Test-Path -LiteralPath $mf)){ '' | Write-Output; exit 0 }`,
				`try { [xml]$x=Get-Content -LiteralPath $mf -Encoding UTF8 } catch { '' | Write-Output; exit 0 }`,
				`$apps=@();`,
				`try { $apps=@($x.Package.Applications.Application) } catch { $apps=@() }`,
				`if(-not $apps -or $apps.Count -eq 0){ try { $apps=@($x.SelectNodes(\"//*[local-name()='Application']\")) } catch { $apps=@() } }`,
				`$appNode=$null;`,
				`if($apps){ foreach($a in $apps){`,
				`  $id=[string]$a.Id;`,
				`  if(-not $id){ try { $id=$a.GetAttribute('Id') } catch { $id='' } }`,
				`  if($id -eq $appId){ $appNode=$a; break }`,
				`} }`,
				`if(-not $appNode -and $apps -and $apps.Count -gt 0){ $appNode=$apps[0] }`,
				`$ve=$null;`,
				`if($appNode){`,
				`  foreach($c in $appNode.ChildNodes){ if($c -and $c.LocalName -eq 'VisualElements'){ $ve=$c; break } }`,
				`  if(-not $ve){ $ve=$appNode.SelectSingleNode(\".//*[local-name()='VisualElements']\") }`,
				`}`,
				`$rels=@();`,
				`if($ve){`,
				`  foreach($n in @('Square44x44Logo','Square150x150Logo','Logo','SmallLogo')){`,
				`    $v=$ve.GetAttribute($n); if($v){ $rels += $v }`,
				`  }`,
				`}`,
				`$cands=@();`,
				`foreach($rel in $rels){`,
				`  $base=Join-Path $root $rel;`,
				`  if(Test-Path -LiteralPath $base){ $cands += $base; continue }`,
				`  $dir=Split-Path -Parent $base;`,
				`  $bn=[System.IO.Path]::GetFileNameWithoutExtension($base);`,
				`  $ext=[System.IO.Path]::GetExtension($base);`,
				`  if(-not $ext){ $ext='.png' }`,
				`  if(Test-Path -LiteralPath $dir){`,
				`    $cands += Get-ChildItem -LiteralPath $dir -File | Where-Object { $_.Name -like ($bn + '*') -and $_.Extension -eq $ext } | Select-Object -ExpandProperty FullName`,
				`  }`,
				`}`,
				`if(-not $cands -or $cands.Count -eq 0){`,
				`  $assetDir=Join-Path $root 'Assets';`,
				`  if(Test-Path -LiteralPath $assetDir){`,
				`    $cands += Get-ChildItem -LiteralPath $assetDir -File -Recurse -ErrorAction SilentlyContinue |`,
				`      Where-Object { $_.Extension -match '^\\.(png|jpg|jpeg|ico)$' -and $_.Name -match '(square|applist|storelogo|logo|snip|screen|capture)' } |`,
				`      Select-Object -ExpandProperty FullName`,
				`  }`,
				`}`,
				`if(-not $cands -or $cands.Count -eq 0){ '' | Write-Output; exit 0 }`,
				`$best=$null; $bestScore=-1;`,
				`foreach($fp in $cands){`,
				`  $n=[System.IO.Path]::GetFileName($fp).ToLower();`,
				`  $s=0;`,
				`  if($n -match 'targetsize-(\\d+)'){ $s += [int]$matches[1]*50 }`,
				`  if($n -match 'scale-(\\d+)'){ $s += [int]$matches[1] }`,
				`  if($n -match 'square44|applist'){ $s += 2000 }`,
				`  if($n -match 'unplated'){ $s += 80 }`,
				`  if($s -gt $bestScore){ $bestScore=$s; $best=$fp }`,
				`}`,
				`if($best){ $best | Write-Output } else { '' | Write-Output }`,
			].join('');

			const ps = spawn('powershell', ['-NoProfile', '-NoLogo', '-Command', cmd], { windowsHide: true });
			let out = '';
			ps.stdout.setEncoding('utf8');
			ps.stdout.on('data', (c) => (out += String(c)));
			ps.on('close', () => resolve((out || '').trim()));
			ps.on('error', () => resolve(''));
		} catch {
			resolve('');
		}
	})
		.then((p) => {
			const v = typeof p === 'string' ? p.trim() : '';
			if (v) uwpIconPathCache.set(key, v);
			return v;
		})
		.finally(() => {
			uwpIconPathInFlight.delete(key);
		});

	uwpIconPathInFlight.set(key, task);
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

export async function prewarmInstalledAppIcons(
	items: Array<{ Name: string; AppID: string }>,
	options?: { maxCount?: number; concurrency?: number }
) {
	const maxCount = Math.max(0, Math.min(1200, Number(options?.maxCount) || 360));
	const concurrency = Math.max(1, Math.min(6, Number(options?.concurrency) || 3));
	if (!Array.isArray(items) || items.length === 0 || maxCount <= 0) return;
	const queue = items
		.filter((it) => typeof it?.Name === 'string' && typeof it?.AppID === 'string')
		.slice(0, maxCount);
	if (queue.length === 0) return;

	// 启动后异步预热应用图标缓存：把首次搜索抓图标的成本前移
	const worker = async () => {
		while (queue.length > 0) {
			const it = queue.shift();
			if (!it) return;
			const key = `app:${it.AppID}`;
			const cached = iconDataCache.get(key) || '';
			if (cached && !isTooSmallAppIconDataUrl(cached)) continue;
			try {
				await getAppIconDataStable(it.Name, it.AppID, 2);
			} catch {}
		}
	};

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

export async function clearIconCaches() {
	iconDataCache.clear();
	fileIconInFlight.clear();
	appIconInFlight.clear();
	uwpIconPathCache.clear();
	uwpIconPathInFlight.clear();
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
