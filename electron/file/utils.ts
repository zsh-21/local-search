import path from 'node:path';

// 图片文件扩展名集合
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg']);
// 视频文件扩展名集合
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v']);
// 快捷方式扩展名集合
export const SHORTCUT_EXTENSIONS = new Set(['.lnk', '.url']);

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
	// 过滤开发依赖与版本控制目录
	if (lower === 'node_modules') return true;
	if (lower === '.git') return true;
	if (lower === '.svn') return true;
	if (lower === '.idea') return true;
	// 过滤系统回收站与卷信息
	if (lower === '$recycle.bin') return true;
	if (lower === 'system volume information') return true;
	
	// 保留 Program Files 和 ProgramData，因为用户可能需要搜索其中的应用或配置文件
	return false;
}
