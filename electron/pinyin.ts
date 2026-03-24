import { pinyin } from 'pinyin-pro';

export function hasChineseChar(input: string) {
	return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(input);
}

export function toPinyinFull(input: string) {
	if (!input) return '';
	if (!hasChineseChar(input)) return '';
	const arr = pinyin(input, { toneType: 'none', type: 'array', nonZh: 'removed' }) as unknown as string[];
	if (!Array.isArray(arr) || arr.length === 0) return '';
	const normalized = arr
		.map((item) => String(item || '').trim().toLowerCase())
		.filter(Boolean);
	if (normalized.length === 0) return '';
	const compact = normalized.join('');
	if (normalized.length === 1) return compact;
	// 同时保存“连写”和“按音节空格分隔”两种形式，兼容 zhongwen / zhong wen 两类输入。
	return `${compact} ${normalized.join(' ')}`;
}

export function toPinyinInitials(input: string) {
	if (!input) return '';
	if (!hasChineseChar(input)) return '';
	const arr = pinyin(input, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'removed' }) as unknown as string[];
	if (!Array.isArray(arr) || arr.length === 0) return '';
	return arr.join('').toLowerCase();
}

