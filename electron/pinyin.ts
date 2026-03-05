import { pinyin } from 'pinyin-pro';

export function hasChineseChar(input: string) {
	return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(input);
}

export function toPinyinFull(input: string) {
	if (!input) return '';
	if (!hasChineseChar(input)) return '';
	const arr = pinyin(input, { toneType: 'none', type: 'array', nonZh: 'removed' }) as unknown as string[];
	if (!Array.isArray(arr) || arr.length === 0) return '';
	return arr.join('').toLowerCase();
}

export function toPinyinInitials(input: string) {
	if (!input) return '';
	if (!hasChineseChar(input)) return '';
	const arr = pinyin(input, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'removed' }) as unknown as string[];
	if (!Array.isArray(arr) || arr.length === 0) return '';
	return arr.join('').toLowerCase();
}

