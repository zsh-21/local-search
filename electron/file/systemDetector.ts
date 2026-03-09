import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';

const execAsync = promisify(exec);

export interface DriveInfo {
  mountPoint: string; // 例如 'C:', 'D:'
  fileSystem: 'NTFS' | 'FAT32' | 'ExFAT' | 'Unknown';
  isSystemDrive: boolean;
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
      // 使用 PowerShell 获取磁盘信息，一次性获取盘符、文件系统类型
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-Volume | Select-Object DriveLetter,FileSystem,DriveType | ConvertTo-Json"'
      );
      
      const volumes = JSON.parse(stdout);
      const drives: DriveInfo[] = [];
      
      const list = Array.isArray(volumes) ? volumes : [volumes];
      
      for (const vol of list) {
        if (!vol.DriveLetter) continue;
        // DriveType 3 = Fixed (本地硬盘), 4 = Remote (网络驱动器)
        // 我们主要关注本地固定磁盘
        if (vol.DriveType !== 3) continue;

        const driveLetter = `${vol.DriveLetter}:`;
        drives.push({
          mountPoint: driveLetter,
          fileSystem: vol.FileSystem || 'Unknown',
          isSystemDrive: driveLetter.toUpperCase() === 'C:',
        });
      }
      
      return drives;
    } catch (e) {
      // 兜底：如果 PowerShell 失败，至少返回 C 盘
      return [{ mountPoint: 'C:', fileSystem: 'Unknown', isSystemDrive: true }];
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
