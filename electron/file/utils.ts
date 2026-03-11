import { IMAGE_EXTENSIONS, SHORTCUT_EXTENSIONS, SKIP_DIR_NAMES, VIDEO_EXTENSIONS } from '../constants/initialValues';

// 文件扩展名集合已抽离：便于你统一调整“分类/是否索引”的策略
export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, SHORTCUT_EXTENSIONS };

/**
 * 根据文件类型分类
 * @param isDirectory 是否为目录
 * @param ext 文件扩展名
 * @returns 'folder' | 'image' | 'video' | 'file'
 */
export function classifyKind(isDirectory: boolean, ext: string) {
	if (isDirectory) return 'folder';
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (VIDEO_EXTENSIONS.has(ext)) return 'video';
	return 'file';
}

/**
 * 判断是否应该索引该文件
 * 策略：跳过快捷方式，避免搜索结果冗余
 */
export function shouldIndexFile(isDirectory: boolean, ext: string) {
	if (isDirectory) return true;
	return !SHORTCUT_EXTENSIONS.has(ext);
}

/**
 * 规范化盘符格式
 * 例如：'C:\Users' -> 'c'
 */
export function normalizeDrive(p: string) {
	const raw = typeof p === 'string' ? p.trim() : '';
	const m = raw.match(/^([a-zA-Z]):/);
	return m ? m[1].toLowerCase() : '';
}

/**
 * 判断目录名是否应该跳过
 * 过滤开发工具配置目录、回收站、系统卷信息等无关目录
 */
export function shouldSkipDirName(name: string) {
	const lower = name.toLowerCase();
	// 目录跳过规则已抽离：便于你集中增删“需要跳过的目录名”
	if (SKIP_DIR_NAMES.has(lower)) return true;

	// 保留 Program Files 和 ProgramData，因为用户可能需要搜索其中的应用或配置文件
	return false;
}
