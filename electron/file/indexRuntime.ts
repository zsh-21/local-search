import { cpus, freemem } from "node:os";
import {
  FILE_INDEX_WORKER_CPU_RESERVE,
  FILE_INDEX_WORKER_MEMORY_HEADROOM_MB,
  FILE_INDEX_WORKER_MIN,
  FILE_INDEX_WORKER_MIN_FREE_MB_PER_WORKER,
} from "../constants/initialValues";

// 索引并发计算需要的运行期上下文：统一收敛 CPU/内存与配置项
type WorkerRuntimeContext = {
  // CPU 核心数：用于计算并发上限
  cpuCount: number;
  // 当前可用内存（MB）：用于估算允许的 Worker 数量
  freeMemMb: number;
  // Worker 最小数量：兜底值
  workerMin: number;
  // 需要保留给主进程/系统的 CPU 核数
  cpuReserve: number;
  // 需要保留给主进程/系统的内存（MB）
  memoryHeadroomMb: number;
  // 每个 Worker 的最小可用内存预算（MB）
  minFreeMbPerWorker: number;
};

// 统一的数值夹取：保证并发数处于合理范围
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// 读取当前运行期环境（CPU/内存）与配置项，供并发计算使用
export function resolveIndexWorkerRuntimeContext(): WorkerRuntimeContext {
  return {
    // 运行期从系统读取 CPU/空闲内存，避免把并发写死在常量里。
    cpuCount: Math.max(1, cpus().length || 1),
    freeMemMb: Math.max(0, Math.floor(freemem() / 1024 / 1024)),
    workerMin: FILE_INDEX_WORKER_MIN,
    cpuReserve: FILE_INDEX_WORKER_CPU_RESERVE,
    memoryHeadroomMb: FILE_INDEX_WORKER_MEMORY_HEADROOM_MB,
    minFreeMbPerWorker: FILE_INDEX_WORKER_MIN_FREE_MB_PER_WORKER,
  };
}

// 根据运行期上下文计算索引 Worker 并发数
export function resolveIndexWorkerCount(ctx: WorkerRuntimeContext) {
  const minWorkers = Math.max(1, Math.floor(ctx.workerMin || 1));
  // CPU 上限：至少保留 cpuReserve 个核心给 UI/主线程。
  const cpuCap = Math.max(1, Math.floor(ctx.cpuCount || 1) - Math.max(0, Math.floor(ctx.cpuReserve || 0)));
  const maxWorkers = Math.max(minWorkers, cpuCap);
  // 内存上限：先扣除保底预留，再按“每 Worker 最低可用内存”估算并发。
  const availableMemMb = Math.max(0, Math.floor(ctx.freeMemMb || 0) - Math.max(0, Math.floor(ctx.memoryHeadroomMb || 0)));
  const perWorkerMb = Math.max(1, Math.floor(ctx.minFreeMbPerWorker || 1));
  const memCap = Math.max(1, Math.floor(availableMemMb / perWorkerMb));
  return clamp(Math.min(cpuCap, memCap), minWorkers, maxWorkers);
}
