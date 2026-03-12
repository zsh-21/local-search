import { parentPort } from 'node:worker_threads';
import { FileIndex } from './fileIndex';

type WorkerResponse = { id: number; ok: true; result?: any } | { id: number; ok: false; error: string };

// 将文件索引（Orama 建库/搜索/重建）放入 Worker 线程：避免主线程长任务导致拖拽/交互卡顿
let fileIndex: FileIndex | null = null;

const reply = (resp: WorkerResponse) => {
	parentPort?.postMessage(resp);
};

parentPort?.on('message', async (msg: any) => {
	// worker 与主线程通信属于运行期协议：这里用 any 接收，避免 TS 因“联合类型穷尽”导致 never 分支无法兜底
	const req: any = msg;
	try {
		if (req.op === 'init') {
			fileIndex = new FileIndex({ cachePath: req.payload.cachePath, maxEntries: req.payload.maxEntries });
			reply({ id: req.id, ok: true });
			return;
		}

		if (!fileIndex) {
			reply({ id: typeof req?.id === 'number' ? req.id : -1, ok: false, error: 'FileIndex 未初始化' });
			return;
		}

		if (req.op === 'reset') {
			fileIndex.reset();
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'getStatus') {
			reply({ id: req.id, ok: true, result: await fileIndex.getStatus() });
			return;
		}
		if (req.op === 'setSearchWindowVisible') {
			fileIndex.setSearchWindowVisible(Boolean(req.payload.visible));
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'setIgnoredPaths') {
			fileIndex.setIgnoredPaths(Array.isArray(req.payload.paths) ? req.payload.paths : []);
			// 常用扩展名优先：用于索引构建阶段“优先处理常用文档/代码等”，提升边建边搜体验
			if (typeof (fileIndex as any).setPreferredFileExtensions === 'function') {
				(fileIndex as any).setPreferredFileExtensions(
					Array.isArray(req.payload?.preferredFileExtensions) ? req.payload.preferredFileExtensions : []
				);
			}
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'pauseIndexingFor') {
			fileIndex.pauseIndexingFor(req.payload.ms);
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'loadCache') {
			reply({ id: req.id, ok: true, result: await fileIndex.loadCache() });
			return;
		}
		if (req.op === 'buildIfEmpty') {
			await fileIndex.buildIfEmpty();
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'rebuild') {
			// req.payload 可能是 RebuildRoot[] 数组，也可能是旧版的 { roots: string[] }
			const roots = Array.isArray(req.payload) ? req.payload : req.payload?.roots;
			await fileIndex.rebuild(roots);
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'abortRebuild') {
			fileIndex.abortRebuild();
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'ingestPath') {
			await fileIndex.ingestPath(req.payload.path, req.payload.isDirectory, req.payload.timeMs);
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'removePath') {
			await fileIndex.removePath(req.payload.path);
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'search') {
			reply({
				id: req.id,
				ok: true,
				result: await fileIndex.search(req.payload.query, req.payload.limit, req.payload.options),
			});
			return;
		}

		reply({
			id: typeof req?.id === 'number' ? req.id : -1,
			ok: false,
			error: `未知操作: ${String((req as any)?.op || '')}`,
		});
	} catch (e: any) {
		reply({ id: typeof req?.id === 'number' ? req.id : -1, ok: false, error: e?.message || 'worker 执行失败' });
	}
});
