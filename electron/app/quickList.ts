import path from 'node:path';
import { recordHistoryItem } from '../history/history';
import { getSearchWindow } from '../window/windowManager';

export function addToQuickListFromPath(targetPath: string) {
  try {
    if (!targetPath || typeof targetPath !== 'string') return;
    const trimmed = targetPath.trim();
    if (!trimmed) return;
    const ext = path.extname(trimmed);
    const base = ext ? path.basename(trimmed, ext) : path.basename(trimmed);
    const name = base || path.basename(trimmed) || '快捷项';
    recordHistoryItem({ name, path: trimmed, type: 'file' });
    getSearchWindow()?.webContents.send('reset-search');
  } catch {}
}

export function handleAddToQuickListArgv(argv: string[]) {
  const idx = argv.indexOf('--add-to-quick-list');
  if (idx < 0) return false;
  const p = argv[idx + 1];
  if (!p) return true;
  addToQuickListFromPath(p);
  return true;
}
