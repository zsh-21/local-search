import { app, nativeImage } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveAppId } from '../win/resolveAppId';
import { resolveLnkByPowerShell, readUrlIconFile } from '../win/shortcuts';
import { ensureStartMenuShortcutIndex, findStartMenuShortcutByName } from '../win/startMenuShortcutIndex';
import { iconDataCache, isTooSmallAppIconDataUrl, setIconCache } from './iconCache';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);

function normalizeIconFileSpec(spec: string) {
	const raw = String(spec || '').trim();
	if (!raw) return '';
	const expandEnvVars = (s: string) => s.replace(/%([^%]+)%/g, (_m, k) => process.env[String(k)] || `%${k}%`);

	let s = raw;
	if (s.startsWith('@')) s = s.slice(1).trim();
	let picked = '';
	if (s.startsWith('"')) {
		const end = s.indexOf('"', 1);
		picked = end > 1 ? s.slice(1, end).trim() : s.replace(/^"+|"+$/g, '').trim();
	} else {
		picked = s.split(',')[0]?.trim() || '';
	}

	let out = picked || s;
	const m = out.match(/^(.*?\.(?:exe|dll|ico|cpl))/i);
	if (m?.[1]) out = m[1].trim();
	out = expandEnvVars(out.trim());
	return out;
}

export async function getFileIconData(filePath: string) {
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
					const targetResolved = resolveAppId(info?.targetPath || '');
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

		if (IMAGE_EXTENSIONS.has(ext) && existsSync(filePath)) {
			try {
				const img = nativeImage.createFromPath(filePath);
				if (!img.isEmpty()) {
					iconData = img.resize({ width: 64, height: 64, quality: 'better' }).toDataURL();
				}
			} catch (err) {
				console.error('Failed to generate image thumbnail:', err);
			}
		}

		if (!iconData) {
			const icon = await app.getFileIcon(filePath, { size: 'large' });
			if (!icon.isEmpty()) iconData = icon.toDataURL();
		}
	} catch {}
	if (iconData) setIconCache(key, iconData);
	return iconData;
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

async function getAppIconData(appName: string, appId: string) {
	const key = `app:${appId}`;
	const cached = iconDataCache.get(key);
	if (typeof cached === 'string' && cached) {
		if (!isTooSmallAppIconDataUrl(cached)) return cached;
		iconDataCache.delete(key);
	}
	let iconData = '';
	try {
		const rawId = typeof appId === 'string' ? appId.trim() : '';
		const resolved = resolveAppId(rawId);
		const normalizedResolved = normalizeIconFileSpec(resolved);

		if ((normalizedResolved.includes('\\') || normalizedResolved.includes('/')) && existsSync(normalizedResolved)) {
			iconData = await getFileIconData(normalizedResolved);
		}

		if (!iconData && rawId.includes('!')) {
			try {
				const icon = await app.getFileIcon(`shell:AppsFolder\\${rawId}`, { size: 'large' });
				if (!icon.isEmpty()) {
					const d = icon.toDataURL();
					if (d && d.length >= 900) iconData = d;
				}
			} catch {}
		}

		if (!iconData) {
			await ensureStartMenuShortcutIndex();
			const shortcut = findStartMenuShortcutByName(appName);
			if (shortcut && existsSync(shortcut)) iconData = await getFileIconData(shortcut);
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
				} catch {}
			}
		}
	} catch {}
	if (iconData) setIconCache(key, iconData);
	return iconData;
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

export async function clearIconCaches() {
	iconDataCache.clear();
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
			const targetResolved = resolveAppId(info?.targetPath || '');
			if (targetResolved && existsSync(targetResolved)) {
				return await getFileIconData(targetResolved);
			}
		}
		if (lower.endsWith('.url')) {
			const iconFile = readUrlIconFile(resolved);
			const iconResolved = resolveAppId(iconFile);
			if (iconResolved && existsSync(iconResolved)) {
				return await getFileIconData(iconResolved);
			}
		}
		if (existsSync(resolved)) return await getFileIconData(resolved);
	} catch {}
	return '';
}
