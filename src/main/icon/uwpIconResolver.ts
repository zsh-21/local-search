import { spawn } from "node:child_process";

const uwpIconPathCache = new Map<string, string>();
const uwpIconPathInFlight = new Map<string, Promise<string>>();

export function resolveUwpIconPathByAumid(aumid: string): Promise<string> {
  const key = String(aumid || "").trim();
  if (!key || !key.includes("!")) return Promise.resolve("");
  const cached = uwpIconPathCache.get(key);
  if (typeof cached === "string" && cached) return Promise.resolve(cached);
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
      ].join("");

      const ps = spawn("powershell", ["-NoProfile", "-NoLogo", "-Command", cmd], { windowsHide: true });
      let out = "";
      ps.stdout.setEncoding("utf8");
      ps.stdout.on("data", (c) => (out += String(c)));
      ps.on("close", () => resolve((out || "").trim()));
      ps.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  })
    .then((p) => {
      const v = typeof p === "string" ? p.trim() : "";
      if (v) uwpIconPathCache.set(key, v);
      return v;
    })
    .finally(() => {
      uwpIconPathInFlight.delete(key);
    });

  uwpIconPathInFlight.set(key, task);
  return task;
}

export function clearUwpIconPathCache() {
  uwpIconPathCache.clear();
  uwpIconPathInFlight.clear();
}
