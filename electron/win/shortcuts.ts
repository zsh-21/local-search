import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveAppId } from './resolveAppId';

export function readUrlShortcut(filePath: string) {
	try {
		const raw = readFileSync(filePath, 'utf-8');
		const m = raw.match(/^\s*URL\s*=\s*(.+)\s*$/im);
		const url = m?.[1]?.trim();
		return url || '';
	} catch {
		return '';
	}
}

export function readUrlIconFile(filePath: string) {
	try {
		const raw = readFileSync(filePath, 'utf-8');
		const m = raw.match(/^\s*IconFile\s*=\s*(.+)\s*$/im);
		const iconFile = m?.[1]?.trim();
		return iconFile || '';
	} catch {
		return '';
	}
}

export function resolveLnkByPowerShell(lnkPath: string) {
	return new Promise<{ targetPath: string; arguments: string; workingDirectory: string; iconLocation: string } | null>((resolve) => {
		try {
			const escaped = lnkPath.replace(/'/g, "''");
			const cmd =
				`$w=New-Object -ComObject WScript.Shell;` +
				`$s=$w.CreateShortcut('${escaped}');` +
				`$o=@{targetPath=$s.TargetPath;arguments=$s.Arguments;workingDirectory=$s.WorkingDirectory;iconLocation=$s.IconLocation};` +
				`$o|ConvertTo-Json -Compress`;
			const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
			let out = '';
			ps.stdout.on('data', (c) => (out += c.toString()));
			ps.on('close', () => {
				try {
					const obj = JSON.parse(out || 'null');
					if (!obj || typeof obj !== 'object') return resolve(null);
					resolve({
						targetPath: typeof obj.targetPath === 'string' ? obj.targetPath : '',
						arguments: typeof obj.arguments === 'string' ? obj.arguments : '',
						workingDirectory: typeof obj.workingDirectory === 'string' ? obj.workingDirectory : '',
						iconLocation: typeof obj.iconLocation === 'string' ? obj.iconLocation : '',
					});
				} catch {
					resolve(null);
				}
			});
			ps.on('error', () => resolve(null));
		} catch {
			resolve(null);
		}
	});
}

export async function openLnkShortcut(lnkPath: string) {
	const info = await resolveLnkByPowerShell(lnkPath);
	if (!info?.targetPath) return false;
	return await new Promise<boolean>((resolve) => {
		try {
			const resolvedTarget = resolveAppId(info.targetPath);
			if (!resolvedTarget) return resolve(false);
			if ((resolvedTarget.includes('\\') || resolvedTarget.includes('/')) && !existsSync(resolvedTarget)) return resolve(false);
			const fp = resolvedTarget.replace(/'/g, "''");
			const al = (info.arguments || '').replace(/'/g, "''");
			const wdResolved = resolveAppId(info.workingDirectory || '');
			const wd = (wdResolved || '').replace(/'/g, "''");
			const cmd =
				`$fp='${fp}';` +
				`$al='${al}';` +
				`$wd='${wd}';` +
				`try { ` +
				`if ($wd) { Start-Process -FilePath $fp -ArgumentList $al -WorkingDirectory $wd -ErrorAction Stop } ` +
				`else { Start-Process -FilePath $fp -ArgumentList $al -ErrorAction Stop } ` +
				`} catch { exit 1 }`;
			const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
			ps.on('close', (code) => resolve(code === 0));
			ps.on('error', () => resolve(false));
		} catch {
			resolve(false);
		}
	});
}

