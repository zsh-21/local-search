import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveAppId } from '../win/resolveAppId';
import { ensureStartMenuShortcutIndex } from '../win/startMenuShortcutIndex';

const INSTALLED_APPS_CACHE_PATH = path.join(app.getPath('userData'), 'installed-apps.json');
const INSTALLED_APPS_CACHE_VERSION = 1;

export interface InstalledApp {
  Name: string;
  AppID: string;
}

let installedAppsCache: InstalledApp[] = [];

export function getInstalledAppsCache() {
  return installedAppsCache;
}

export function loadInstalledApps() {
  // 启动速度优先：应用列表先从本地缓存读出可用数据，随后在后台刷新（Get-StartApps + 注册表）并落盘
  // 同时异步初始化开始菜单快捷方式索引：用于图标与“打开目录”兜底，不作为应用列表来源
  setTimeout(() => void ensureStartMenuShortcutIndex(), 0);

  const readCache = () => {
    try {
      if (!existsSync(INSTALLED_APPS_CACHE_PATH)) return;
      const raw = JSON.parse(readFileSync(INSTALLED_APPS_CACHE_PATH, 'utf-8'));
      if (raw?.version !== INSTALLED_APPS_CACHE_VERSION) return;
      const list = Array.isArray(raw?.items) ? raw.items : [];
      const merged = new Map<string, InstalledApp>();
      for (const it of list) {
        const name = typeof (it as any)?.Name === 'string' ? (it as any).Name.trim() : '';
        const appId = typeof (it as any)?.AppID === 'string' ? (it as any).AppID.trim() : '';
        if (!name || !appId) continue;
        merged.set(appId.toLowerCase(), { Name: name, AppID: appId });
      }
      if (merged.size > 0) installedAppsCache = Array.from(merged.values());
    } catch {}
  };

  const normalizeExeSpec = (raw: string) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';
    const noQuotes = s.startsWith('"') && s.includes('"') ? s.replace(/^"+|"+$/g, '') : s;
    const beforeComma = noQuotes.split(',')[0]?.trim() || '';
    const lower = beforeComma.toLowerCase();
    const exeIdx = lower.indexOf('.exe');
    if (exeIdx >= 0) return beforeComma.slice(0, exeIdx + 4);
    return beforeComma;
  };

  const saveCache = (items: InstalledApp[]) => {
    try {
      const stable = items
        .slice()
        .filter((x) => x && typeof x.Name === 'string' && typeof x.AppID === 'string')
        .map((x) => ({ Name: x.Name.trim(), AppID: x.AppID.trim() }))
        .filter((x) => x.Name && x.AppID);
      stable.sort((a, b) => a.AppID.toLowerCase().localeCompare(b.AppID.toLowerCase()));
      writeFileSync(
        INSTALLED_APPS_CACHE_PATH,
        JSON.stringify({ version: INSTALLED_APPS_CACHE_VERSION, updatedAt: Date.now(), items: stable })
      );
    } catch {}
  };

  readCache();

  // Get-StartApps + 注册表合并：放到后台延后执行，避免与冷启动/首搜抢资源
  setTimeout(() => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-NoLogo',
      '-Command',
      [
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
        "$items=@();",
        "try {",
        "  $sa=Get-StartApps | Select-Object Name, AppID;",
        "  foreach($x in $sa){ if($x.Name -and $x.AppID){ $items += [pscustomobject]@{Name=[string]$x.Name;AppID=[string]$x.AppID} } }",
        "} catch {}",
        "$roots=@(",
        "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',",
        "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',",
        "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths'",
        ");",
        "foreach($r in $roots){",
        "  try {",
        "    if(Test-Path $r){",
        "      Get-ChildItem -LiteralPath $r | ForEach-Object {",
        "        $k=$_; $n=[string]$k.PSChildName; $def='';",
        "        try { $def=(Get-Item -LiteralPath $k.PSPath).GetValue('') } catch {}",
        "        if(-not $def){ try { $def=(Get-ItemProperty -LiteralPath $k.PSPath).Path } catch {} }",
        "        if($def){ $items += [pscustomobject]@{Name=($n -replace '\\.exe$','');AppID=[string]$def} }",
        "      }",
        "    }",
        "  } catch {}",
        "}",
        "$unroots=@(",
        "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
        "  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
        "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
        ");",
        "foreach($r in $unroots){",
        "  try {",
        "    if(Test-Path $r){",
        "      Get-ChildItem -LiteralPath $r | ForEach-Object {",
        "        try {",
        "          $p=$_.PSPath;",
        "          $dn=(Get-ItemProperty -LiteralPath $p).DisplayName;",
        "          if(-not $dn){ return }",
        "          $di=(Get-ItemProperty -LiteralPath $p).DisplayIcon;",
        "          if($di){ $items += [pscustomobject]@{Name=[string]$dn;AppID=[string]$di} }",
        "        } catch {}",
        "      }",
        "    }",
        "  } catch {}",
        "}",
        "$items | ConvertTo-Json -Compress",
      ].join(' '),
    ]);
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    let data = '';
    let err = '';
    ps.stdout.on('data', (chunk) => (data += String(chunk)));
    ps.stderr.on('data', (chunk) => (err += String(chunk)));
    ps.on('close', (code) => {
      if (code !== 0) {
        if (err) console.warn('loadInstalledApps failed:', err);
        return;
      }
      try {
        const apps = JSON.parse(data);
        const list: InstalledApp[] = Array.isArray(apps) ? apps : apps ? [apps] : [];
        const merged = new Map<string, InstalledApp>();
        const nameSeen = new Set<string>();

        // 去重策略：优先保留 Get-StartApps 的 AppID（通常更“官方”），注册表项作为补齐；同名项避免重复出现
        for (const it of list) {
          const name = typeof (it as any)?.Name === 'string' ? (it as any).Name.trim() : '';
          const rawId = typeof (it as any)?.AppID === 'string' ? (it as any).AppID.trim() : '';
          if (!name || !rawId) continue;

          const idLooksLikePath = rawId.includes('\\') || rawId.includes('/') || rawId.toLowerCase().includes('.exe');
          const normalizedId = idLooksLikePath ? normalizeExeSpec(rawId) : rawId;
          if (!normalizedId) continue;

          // 注册表来源的 DisplayIcon 可能是 .ico：不可启动，直接跳过
          if (idLooksLikePath && !normalizedId.toLowerCase().endsWith('.exe')) continue;
          if (idLooksLikePath && (normalizedId.includes('\\') || normalizedId.includes('/')) && !existsSync(resolveAppId(normalizedId))) continue;

          const key = normalizedId.toLowerCase();
          const nameKey = name.toLowerCase();
          if (nameSeen.has(nameKey) && !merged.has(key)) continue;

          if (!merged.has(key)) merged.set(key, { Name: name, AppID: normalizedId });
          nameSeen.add(nameKey);
        }

        const next = Array.from(merged.values());
        if (next.length > 0) {
          installedAppsCache = next;
          saveCache(next);
        }
      } catch (e: any) {
        // JSON 解析失败时保持原缓存：避免“应用全部搜不到”
        if (err) console.warn('loadInstalledApps parse failed:', err);
        else console.warn('loadInstalledApps parse failed:', e?.message || 'unknown');
      }
    });
  }, 1400);
}
