import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

/**
 * 获取硬件级唯一标识符
 * 在不同操作系统上尝试获取机器 UUID
 */
function getMachineId(): string {
  try {
    let id = '';
    if (process.platform === 'win32') {
      // Windows: 使用 wmic 获取系统 UUID
      id = execSync('wmic csproduct get uuid', { encoding: 'utf8' })
        .replace('UUID', '')
        .replace(/\r?\n|\r/g, '')
        .trim();
    } else if (process.platform === 'darwin') {
      // macOS: 使用 ioreg 获取 IOPlatformUUID
      id = execSync("ioreg -rd1 -c IOPlatformExpertDevice | grep -E 'IOPlatformUUID'", { encoding: 'utf8' })
        .split('=')[1]
        .replace(/[\\"\s\r\n]/g, '')
        .trim();
    } else if (process.platform === 'linux') {
      // Linux: 优先读取 /etc/machine-id
      if (existsSync('/etc/machine-id')) {
        id = readFileSync('/etc/machine-id', 'utf8').trim();
      } else if (existsSync('/var/lib/dbus/machine-id')) {
        id = readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
      }
    }

    // 如果获取到了硬件 ID，进行哈希处理以保护隐私，并返回固定长度的 ID
    if (id && id !== '00000000-0000-0000-0000-000000000000') {
      return createHash('sha256').update(id).digest('hex');
    }
  } catch (error) {
    // 捕获所有执行错误，防止主进程崩溃
    console.error('获取硬件 ID 失败:', error);
  }
  return '';
}

const DEVICE_ID_PATH = path.join(app.getPath('userData'), 'device-id.json');

/**
 * 获取设备 ID
 * 逻辑：
 * 1. 优先从 userData 缓存读取
 * 2. 如果没有缓存，尝试生成基于硬件的稳定 ID
 * 3. 如果硬件 ID 获取失败，回退到随机生成的 UUID（并持久化）
 */
export function getDeviceId() {
  // 1. 尝试从本地文件读取
  try {
    if (existsSync(DEVICE_ID_PATH)) {
      const raw = JSON.parse(readFileSync(DEVICE_ID_PATH, 'utf-8'));
      if (typeof raw?.deviceId === 'string' && raw.deviceId) return raw.deviceId;
    }
  } catch (err) {
    console.error('读取设备 ID 缓存失败:', err);
  }

  // 2. 尝试生成硬件级 ID
  const machineId = getMachineId();
  if (machineId) {
    // 将硬件生成的 ID 也写入文件，以便下次快速读取
    try {
      writeFileSync(DEVICE_ID_PATH, JSON.stringify({ deviceId: machineId }));
    } catch (err) {
      console.error('写入硬件设备 ID 失败:', err);
    }
    return machineId;
  }

  // 3. 兜底逻辑：随机生成并保存
  const newId = randomUUID();
  try {
    writeFileSync(DEVICE_ID_PATH, JSON.stringify({ deviceId: newId }));
  } catch (err) {
    console.error('生成随机设备 ID 失败:', err);
  }
  return newId;
}
