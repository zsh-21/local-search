import { parentPort } from 'node:worker_threads';
import { FileIndex } from './fileIndex';

type WorkerRequest =
	| { id: number; op: 'init'; payload: { cachePath: string; maxEntries?: number } }
	| { id: number; op: 'reset' }
	| { id: number; op: 'getStatus' }
	| { id: number; op: 'setSearchWindowVisible'; payload: { visible: boolean } }
	| { id: number; op: 'setIgnoredPaths'; payload: { paths: string[] } }
	| { id: number; op: 'pauseIndexingFor'; payload: { ms: number } }
	| { id: number; op: 'loadCache' }
	| { id: number; op: 'buildIfEmpty' }
	| { id: number; op: 'rebuild' }
	| { id: number; op: 'ingestPath'; payload: { path: string; isDirectory: boolean } }
	| { id: number; op: 'removePath'; payload: { path: string } }
	| { id: number; op: 'search'; payload: { query: string; limit: number; options?: { where?: any } } };

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
			await fileIndex.rebuild();
			reply({ id: req.id, ok: true });
			return;
		}
		if (req.op === 'ingestPath') {
			await fileIndex.ingestPath(req.payload.path, req.payload.isDirectory);
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
