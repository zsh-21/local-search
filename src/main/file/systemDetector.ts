import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';

/** 命令执行的异步封装。 */
const execAsync = promisify(exec);

/** 磁盘信息结构。 */
export interface DriveInfo {
  mountPoint: string;
  fileSystem: 'NTFS' | 'FAT32' | 'ExFAT' | 'Unknown';
  isSystemDrive: boolean;
  isSSD: boolean;
}

/** 系统信息结构。 */
export interface SystemInfo {
  osVersion: string;
  isAdmin: boolean;
  drives: DriveInfo[];
  hasNativeSupport: boolean;
}

/** PowerShell 卷信息的宽松结构。 */
type VolumeJsonItem = {
  DriveLetter?: unknown;
  FileSystem?: unknown;
  DriveType?: unknown;
  IsSSD?: unknown;
  Model?: unknown;
  BusType?: unknown;
};

/** 将未知 JSON 统一转换成卷数组。 */
function toVolumeList(raw: unknown) {
  if (Array.isArray(raw)) return raw as VolumeJsonItem[];
  if (raw && typeof raw === 'object') return [raw as VolumeJsonItem];
  return [];
}

/** 提取字符串值。 */
function readText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 系统探测器单例。 */
export class SystemDetector {
  private static instance: SystemDetector;
  private info: SystemInfo | null = null;
  private nativeSupport: boolean | null = null;

  private constructor() {}

  /** 获取单例实例。 */
  static getInstance(): SystemDetector {
    if (!SystemDetector.instance) {
      SystemDetector.instance = new SystemDetector();
    }
    return SystemDetector.instance;
  }

  /** 探测系统环境信息。 */
  async detect(): Promise<SystemInfo> {
    if (this.info) return this.info;

    const [isAdmin, drives] = await Promise.all([this.checkAdmin(), this.detectDrives()]);

    /** 原生支持默认走保守判断，后续可按需接入 ffi-napi。 */
    const hasNativeSupport = this.hasNativeSupport();

    this.info = {
      osVersion: release(),
      isAdmin,
      drives,
      hasNativeSupport,
    };

    return this.info;
  }

  /** 判断是否支持原生模块。 */
  hasNativeSupport(): boolean {
    if (typeof this.nativeSupport === 'boolean') return this.nativeSupport;
    this.nativeSupport = this.checkNativeSupport();
    return this.nativeSupport;
  }

  /** 判断当前是否为管理员权限。 */
  private async checkAdmin(): Promise<boolean> {
    if (platform() !== 'win32') return false;
    try {
      /** 通过 `net session` 判断管理员权限。 */
      await execAsync('net session');
      return true;
    } catch {
      return false;
    }
  }

  /** 探测磁盘分区信息。 */
  private async detectDrives(): Promise<DriveInfo[]> {
    if (platform() !== 'win32') return [];

    /** 兜底盘符信息，避免 PowerShell 解析失败时为空。 */
    const buildFallback = (roots: string[]): DriveInfo[] => {
      const items: DriveInfo[] = [];
      for (const raw of roots) {
        const trimmed = String(raw || '').trim();
        if (!trimmed) continue;
        const letter = trimmed.replace(/\\+$/, '').replace(/\/+$/, '');
        const driveLetter = letter.endsWith(':') ? letter : `${letter}:`;
        if (!/^[a-zA-Z]:$/.test(driveLetter)) continue;
        const upper = driveLetter.toUpperCase();
        items.push({
          mountPoint: driveLetter,
          fileSystem: 'Unknown',
          isSystemDrive: upper === 'C:',
          isSSD: false,
        });
      }
      if (items.length === 0) {
        return [{ mountPoint: 'C:', fileSystem: 'Unknown', isSystemDrive: true, isSSD: false }];
      }
      return items;
    };

    /** 通过 PSDrive 构造更稳妥的回退结果。 */
    const fallbackByPsDrive = async (): Promise<DriveInfo[]> => {
      try {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"'
        );
        const roots = stdout
          .split(/\r?\n/g)
          .map((s) => s.trim())
          .filter(Boolean);
        return buildFallback(roots);
      } catch {
        return buildFallback(['C:']);
      }
    };

    try {
      /** 先尝试一次性从 PowerShell 读取卷信息和 SSD 线索。 */
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-Volume | Where-Object DriveLetter -ne $null | ForEach-Object { $v = $_; $p = Get-Partition -DriveLetter $v.DriveLetter; $d = Get-Disk -Number $p.DiskNumber; [PSCustomObject]@{DriveLetter=$v.DriveLetter;FileSystem=$v.FileSystem;DriveType=$v.DriveType;IsSSD=($d.Model -match \'SSD\' -or $d.BusType -eq \'NVMe\')}} | ConvertTo-Json"'
      );

      const raw = String(stdout || '').trim();
      if (!raw) return await fallbackByPsDrive();
      let volumes: unknown;
      try {
        volumes = JSON.parse(raw);
      } catch {
        try {
          volumes = JSON.parse(raw.replace(/^\uFEFF/, ''));
        } catch {
          return await fallbackByPsDrive();
        }
      }

      const drives: DriveInfo[] = [];
      const list = toVolumeList(volumes);

      for (const vol of list) {
        const driveLetterRaw = readText(vol.DriveLetter);
        if (!driveLetterRaw) continue;

        /** 兼容 PowerShell 返回的数值和枚举字符串。 */
        const rawType = vol.DriveType;
        const typeNum =
          typeof rawType === 'number'
            ? rawType
            : typeof rawType === 'string' && /^\d+$/.test(rawType.trim())
              ? Number(rawType.trim())
              : NaN;
        const typeName = readText(rawType).toLowerCase();
        const isWritableLocal =
          typeNum === 2 ||
          typeNum === 3 ||
          typeName === 'removable' ||
          typeName === 'fixed';
        if (!isWritableLocal) continue;

        const driveLetter = `${driveLetterRaw}:`;
        const fileSystem = readText(vol.FileSystem) || 'Unknown';
        const isSsdFlag = typeof vol.IsSSD === 'boolean' ? vol.IsSSD : false;
        const isSsdByMetadata =
          readText(vol.Model).toLowerCase().includes('ssd') || readText(vol.BusType).toLowerCase() === 'nvme';
        drives.push({
          mountPoint: driveLetter,
          fileSystem: fileSystem === '' ? 'Unknown' : (fileSystem as DriveInfo['fileSystem']),
          isSystemDrive: driveLetter.toUpperCase() === 'C:',
          isSSD: Boolean(isSsdFlag || isSsdByMetadata),
        });
      }

      if (drives.length === 0) return await fallbackByPsDrive();

      /** 合并主结果和回退结果，保证根盘符不缺失。 */
      const fallback = await fallbackByPsDrive();
      const byMount = new Map<string, DriveInfo>();
      for (const d of drives) {
        const key = String(d.mountPoint || '').toUpperCase();
        if (!key) continue;
        byMount.set(key, d);
      }
      for (const d of fallback) {
        const key = String(d.mountPoint || '').toUpperCase();
        if (!key || byMount.has(key)) continue;
        byMount.set(key, d);
      }
      return Array.from(byMount.values());
    } catch {
      return await fallbackByPsDrive();
    }
  }

  /** 检查 USN 日志支持。 */
  async checkUsnSupport(drive: string): Promise<boolean> {
    if (platform() !== 'win32') return false;
    try {
      /** `fsutil usn queryjournal` 成功即表示可用。 */
      await execAsync(`fsutil usn queryjournal ${drive}`);
      return true;
    } catch {
      return false;
    }
  }

  /** 解析原生支持能力。 */
  private checkNativeSupport(): boolean {
    try {
      /** 这里暂时保守返回 false，避免引入未集成依赖。 */
      return false;
    } catch {
      return false;
    }
  }
}
