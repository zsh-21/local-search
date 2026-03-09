import { app } from 'electron';
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEVICE_ID_PATH = path.join(app.getPath('userData'), 'device-id.json');

export function getDeviceId() {
  try {
    if (existsSync(DEVICE_ID_PATH)) {
      const raw = JSON.parse(readFileSync(DEVICE_ID_PATH, 'utf-8'));
      if (typeof raw?.deviceId === 'string' && raw.deviceId) return raw.deviceId;
    }
  } catch {}
  const newId = randomUUID();
  try {
    writeFileSync(DEVICE_ID_PATH, JSON.stringify({ deviceId: newId }));
  } catch {}
  return newId;
}
