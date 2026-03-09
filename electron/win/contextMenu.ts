import { app } from 'electron';
import { spawn } from 'node:child_process';

const WIN_CONTEXT_MENU_VERB_KEY = 'FileSearchAddToQuickList';
const WIN_CONTEXT_MENU_LABEL = '添加到FileSearch的快捷列表';

function regAddString(key: string, valueName: string | null, data: string) {
  return new Promise<void>((resolve) => {
    try {
      const args = ['add', key];
      if (valueName) args.push('/v', valueName);
      else args.push('/ve');
      args.push('/t', 'REG_SZ', '/d', data, '/f');
      const ps = spawn('reg', args, { windowsHide: true });
      ps.on('close', () => resolve());
      ps.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

export async function ensureWindowsAppContextMenu() {
  if (process.platform !== 'win32') return;
  if (!app.isPackaged) return;

  const exe = process.execPath;
  if (!exe) return;
  const command = `"${exe}" --add-to-quick-list "%1"`;

  const classes = ['lnkfile', 'exefile'];
  for (const cls of classes) {
    const baseKey = `HKCU\\Software\\Classes\\${cls}\\shell\\${WIN_CONTEXT_MENU_VERB_KEY}`;
    await regAddString(baseKey, null, WIN_CONTEXT_MENU_LABEL);
    await regAddString(baseKey, 'Icon', exe);
    await regAddString(`${baseKey}\\command`, null, command);
  }
}
