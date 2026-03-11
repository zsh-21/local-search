import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';

const execAsync = promisify(exec);

export interface DriveInfo {
  mountPoint: string; // 例如 'C:', 'D:'
  fileSystem: 'NTFS' | 'FAT32' | 'ExFAT' | 'Unknown';
  isSystemDrive: boolean;
  isSSD: boolean; // 是否为 SSD (固态硬盘)
}

export interface SystemInfo {
  osVersion: string; // 例如 '10.0.xxxxx'
  isAdmin: boolean;
  drives: DriveInfo[];
  hasNativeSupport: boolean; // 是否支持原生模块 (node-ffi-napi)
}

export class SystemDetector {
  private static instance: SystemDetector;
  private info: SystemInfo | null = null;

  private constructor() {}

  static getInstance(): SystemDetector {
    if (!SystemDetector.instance) {
      SystemDetector.instance = new SystemDetector();
    }
    return SystemDetector.instance;
  }

  /**
   * 检测系统环境信息
   * 包含：操作系统版本、管理员权限、磁盘分区信息、原生插件支持情况
   */
  async detect(): Promise<SystemInfo> {
    if (this.info) return this.info;

    const [isAdmin, drives] = await Promise.all([
      this.checkAdmin(),
      this.detectDrives(),
    ]);

    // 检测原生模块支持情况 (当前版本默认为 false，需集成 node-ffi-napi 后改为检测逻辑)
    const hasNativeSupport = this.checkNativeSupport();

    this.info = {
      osVersion: release(),
      isAdmin,
      drives,
      hasNativeSupport,
    };

    return this.info;
  }

  /**
   * 检测是否拥有管理员权限
   * 纯 JS 兜底方案：通过执行 net session 命令判断
   */
  private async checkAdmin(): Promise<boolean> {
    if (platform() !== 'win32') return false;
    try {
      // net session 命令仅管理员可执行成功
      await execAsync('net session');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检测磁盘分区信息
   * 优先使用 PowerShell (兼容性好)，失败则降级处理
   */
  private async detectDrives(): Promise<DriveInfo[]> {
    if (platform() !== 'win32') return [];
    
    try {
      // 使用 PowerShell 组合命令：
      // 1. Get-Volume 获取卷信息
      // 2. 映射到 PhysicalDisk 获取 MediaType (判断是否为 SSD)
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-Volume | Where-Object DriveLetter -ne $null | ForEach-Object { $v = $_; $p = Get-Partition -DriveLetter $v.DriveLetter; $d = Get-Disk -Number $p.DiskNumber; [PSCustomObject]@{DriveLetter=$v.DriveLetter;FileSystem=$v.FileSystem;DriveType=$v.DriveType;IsSSD=($d.Model -match \'SSD\' -or $d.BusType -eq \'NVMe\')}} | ConvertTo-Json"'
      );
      
      const volumes = JSON.parse(stdout);
      const drives: DriveInfo[] = [];
      
      const list = Array.isArray(volumes) ? volumes : [volumes];
      
      for (const vol of list) {
        if (!vol.DriveLetter) continue;
        // 兼容不同 PowerShell/系统返回格式：
        // - 可能是数字 2/3
        // - 也可能是字符串 "2"/"3"
        // - 或枚举名 "Removable"/"Fixed"
        // 这里放宽到“可读写本地盘”优先，排除光驱/内存盘等无意义卷
        const rawType = vol.DriveType;
        const typeNum =
          typeof rawType === 'number'
            ? rawType
            : typeof rawType === 'string' && /^\d+$/.test(rawType.trim())
              ? Number(rawType.trim())
              : NaN;
        const typeName = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
        const isWritableLocal =
          typeNum === 2 ||
          typeNum === 3 ||
          typeName === 'removable' ||
          typeName === 'fixed';
        if (!isWritableLocal) continue;

        const driveLetter = `${vol.DriveLetter}:`;
        drives.push({
          mountPoint: driveLetter,
          fileSystem: vol.FileSystem || 'Unknown',
          isSystemDrive: driveLetter.toUpperCase() === 'C:',
          isSSD: Boolean(vol.IsSSD),
        });
      }
      
      // 防御性兜底：解析成功但结果为空时，至少保留 C 盘，避免“索引秒结束但实际没扫描”
      if (drives.length === 0) {
        return [{ mountPoint: 'C:', fileSystem: 'Unknown', isSystemDrive: true, isSSD: false }];
      }
      return drives;
    } catch (e) {
      // 兜底：如果 PowerShell 失败，至少返回 C 盘（默认非 SSD 以保安全）
      return [{ mountPoint: 'C:', fileSystem: 'Unknown', isSystemDrive: true, isSSD: false }];
    }
  }

  /**
   * 检测是否支持 USN 日志 (针对特定盘符)
   * 通过 fsutil 命令查询
   */
  async checkUsnSupport(drive: string): Promise<boolean> {
    if (platform() !== 'win32') return false;
    try {
      // fsutil usn queryjournal <drive>
      // 成功则说明支持且已启用，失败或报错说明不支持或未启用
      await execAsync(`fsutil usn queryjournal ${drive}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检测原生模块支持情况
   * 目前项目未集成 node-ffi-napi，直接返回 false
   */
  private checkNativeSupport(): boolean {
    try {
      // 预留接口：后续如果集成了 ffi-napi，可以在这里 require 检测
      // require('ffi-napi');
      return false;
    } catch {
      return false;
    }
  }
}
