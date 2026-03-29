import { parentPort } from 'node:worker_threads';
import { FileIndex } from './fileIndex';

type WorkerResponse = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

type WorkerRequest = {
	id?: unknown;
	op?: unknown;
	payload?: unknown;
};

type WorkerRecord = Record<string, unknown>;

/** 判断值是否为普通对象，便于对运行期协议载荷做安全收窄。 */
const isRecord = (value: unknown): value is WorkerRecord => typeof value === 'object' && value !== null;

/** 获取请求中的回复编号，避免非法值污染响应结构。 */
const getResponseId = (value: WorkerRequest) => (typeof value.id === 'number' ? value.id : -1);

/** 获取请求中的操作名，非法值统一收敛为空串。 */
const getRequestOp = (value: WorkerRequest) => (typeof value.op === 'string' ? value.op : '');

/** 获取请求中的对象型载荷，便于后续按字段逐步收窄。 */
const getRequestPayload = (value: WorkerRequest) => (isRecord(value.payload) ? value.payload : undefined);

/** 将文件索引（Orama 建库/搜索/重建）放入 Worker 线程：避免主线程长任务导致拖拽/交互卡顿。 */
let fileIndex: FileIndex | null = null;

/** 统一回复入口，确保 IPC 响应结构稳定。 */
const reply = (resp: WorkerResponse) => {
	parentPort?.postMessage(resp);
};

/** 消息入口：仅按运行期协议读取字段，不改变现有分支与字符串值。 */
parentPort?.on('message', async (msg: unknown) => {
	const req = msg as WorkerRequest;
	try {
		const op = getRequestOp(req);
		const payload = getRequestPayload(req);

		/** 初始化索引实例。 */
		if (op === 'init') {
			fileIndex = new FileIndex({
				cachePath: payload?.cachePath as string,
				maxEntries: payload?.maxEntries as number | undefined,
			});
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 处理尚未初始化的兜底返回。 */
		if (!fileIndex) {
			reply({ id: getResponseId(req), ok: false, error: 'FileIndex 未初始化' });
			return;
		}

		/** 重置索引。 */
		if (op === 'reset') {
			fileIndex.reset();
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 查询状态。 */
		if (op === 'getStatus') {
			reply({ id: getResponseId(req), ok: true, result: await fileIndex.getStatus() });
			return;
		}

		/** 查询磁盘统计。 */
		if (op === 'getDriveStats') {
			reply({ id: getResponseId(req), ok: true, result: await fileIndex.getDriveStats() });
			return;
		}

		/** 同步搜索窗口可见性。 */
		if (op === 'setSearchWindowVisible') {
			fileIndex.setSearchWindowVisible(Boolean(payload?.visible));
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 更新忽略路径。 */
		if (op === 'setIgnoredPaths') {
			fileIndex.setIgnoredPaths(Array.isArray(payload?.paths) ? payload.paths : []);
			/** 常用扩展名优先：用于索引构建阶段“优先处理常用文档/代码等”，提升边建边搜体验。 */
			if (Array.isArray(payload?.preferredFileExtensions)) {
				fileIndex.setPreferredFileExtensions(payload.preferredFileExtensions);
			} else {
				fileIndex.setPreferredFileExtensions([]);
			}
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 暂停索引。 */
		if (op === 'pauseIndexingFor') {
			fileIndex.pauseIndexingFor(payload?.ms as number);
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 加载缓存。 */
		if (op === 'loadCache') {
			reply({ id: getResponseId(req), ok: true, result: await fileIndex.loadCache() });
			return;
		}

		/** 空索引时构建。 */
		if (op === 'buildIfEmpty') {
			await fileIndex.buildIfEmpty();
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 重建索引，兼容数组载荷与旧版 roots 载荷。 */
		if (op === 'rebuild') {
			const roots = Array.isArray(req.payload) ? req.payload : payload?.roots;
			await fileIndex.rebuild(roots as Array<string | { path: string; isSSD: boolean }> | undefined);
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 中止重建。 */
		if (op === 'abortRebuild') {
			fileIndex.abortRebuild();
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 写入单条路径。 */
		if (op === 'ingestPath') {
			await fileIndex.ingestPath(payload?.path as string, payload?.isDirectory as boolean, payload?.timeMs as number | undefined);
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 删除单条路径。 */
		if (op === 'removePath') {
			await fileIndex.removePath(payload?.path as string);
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 取消搜索会话。 */
		if (op === 'cancelSearchSession') {
			fileIndex.cancelSearchSession(payload?.sessionId as string);
			reply({ id: getResponseId(req), ok: true });
			return;
		}

		/** 执行搜索。 */
		if (op === 'search') {
			reply({
				id: getResponseId(req),
				ok: true,
				result: await fileIndex.search(payload?.query as string, payload?.limit as number, payload?.options as { where?: unknown; sessionId?: string } | undefined),
			});
			return;
		}

		reply({
			id: getResponseId(req),
			ok: false,
			error: `未知操作: ${String(op || '')}`,
		});
	} catch (error: unknown) {
		reply({
			id: getResponseId(req),
			ok: false,
			error: error instanceof Error ? error.message : 'worker 执行失败',
		});
	}
});

