import { IMAGE_EXTENSIONS, SHORTCUT_EXTENSIONS, SKIP_DIR_NAMES, VIDEO_EXTENSIONS } from '../constants/initialValues';

export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, SHORTCUT_EXTENSIONS };

const SKIP_FILE_NAMES = new Set([
	"desktop.ini",
	"thumbs.db",
	"pagefile.sys",
	"hiberfil.sys",
	"swapfile.sys",
	"ntuser.dat",
	"ntuser.dat.log",
	"ntuser.dat.log1",
	"ntuser.dat.log2",
	"bootmgr",
	"bootnxt",
]);

function isHiddenName(name: string) {
	return typeof name === 'string' && name.length > 1 && name.startsWith('.');
}

export function classifyKind(isDirectory: boolean, ext: string) {
	if (isDirectory) return 'folder';
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (VIDEO_EXTENSIONS.has(ext)) return 'video';
	return 'file';
}

export function shouldIndexFile(isDirectory: boolean, ext: string) {
	if (isDirectory) return true;
	return !SHORTCUT_EXTENSIONS.has(ext);
}

export function normalizeDrive(p: string) {
	const raw = typeof p === 'string' ? p.trim() : '';
	const m = raw.match(/^([a-zA-Z]):/);
	return m ? m[1].toLowerCase() : '';
}

export function shouldSkipDirName(name: string) {
	if (isHiddenName(name)) return true;
	const lower = name.toLowerCase();
	if (SKIP_DIR_NAMES.has(lower)) return true;
	return false;
}

export function shouldSkipFileName(name: string) {
	if (isHiddenName(name)) return true;
	const lower = String(name || '').toLowerCase();
	if (SKIP_FILE_NAMES.has(lower)) return true;
	return false;
}

export function shouldSkipHiddenOrSystemPath(targetPath: string) {
	const raw = typeof targetPath === 'string' ? targetPath.trim() : '';
	if (!raw) return false;
	const normalized = raw.replace(/\//g, '\\').replace(/\\+/g, '\\');
	const parts = normalized.split('\\').filter(Boolean);
	for (const part of parts) {
		if (!part) continue;
		if (isHiddenName(part)) return true;
		const lower = part.toLowerCase();
		if (SKIP_DIR_NAMES.has(lower)) return true;
	}
	const leaf = parts[parts.length - 1] || '';
	if (shouldSkipFileName(leaf)) return true;
	return false;
}
