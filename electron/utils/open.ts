import { spawn } from 'node:child_process';
import { shell } from 'electron';

export async function openResolvedTarget(resolved: string) {
  if (!resolved) return false;
  const raw = String(resolved || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const tryExplorer = (target: string) => {
    try {
      const p = spawn('explorer.exe', [target], { windowsHide: true, detached: true });
      p.unref();
      return true;
    } catch {
      return false;
    }
  };
  const tryStartProcess = (target: string) =>
    new Promise<boolean>((resolve) => {
      try {
        const escaped = target.replace(/'/g, "''");
        const cmd = `try { Start-Process '${escaped}' -ErrorAction Stop } catch { exit 1 }`;
        const ps = spawn('powershell', ['-NoProfile', '-Command', cmd], { windowsHide: true });
        ps.on('close', (code) => resolve(code === 0));
        ps.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  if (lower.startsWith('shell:') || lower.startsWith('ms-settings:')) {
    try {
      await shell.openExternal(raw);
      return true;
    } catch {}
    if (tryExplorer(raw)) return true;
    return await tryStartProcess(raw);
  }
  const isFsPath =
    process.platform === 'win32'
      ? /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw)
      : raw.startsWith('/');
  if (isFsPath) {
    const msg = await shell.openPath(raw);
    return !msg;
  }
  const url = `shell:AppsFolder\\${raw}`;
  try {
    await shell.openExternal(url);
    return true;
  } catch {}
  if (tryExplorer(url)) return true;
  return await tryStartProcess(url);
}
