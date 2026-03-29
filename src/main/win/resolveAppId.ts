import path from 'node:path';

export function resolveAppId(appId: string): string {
	if (!appId) return '';
	let resolved = String(appId);
	resolved = resolved.replace(/\{([0-9a-fA-F-]{36})\)\s*/g, '{$1}');

	const sys32 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
	const replacements: Array<{ re: RegExp; val: string }> = [
		{ re: /\{6D809377-6AF0-444B-8957-A3773F02200E\}/gi, val: process.env.ProgramFiles || 'C:\\Program Files' },
		{ re: /\{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E\}/gi, val: process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)' },
		{ re: /\{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27\}/gi, val: sys32 },
		{ re: /\{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7\}/gi, val: sys32 },
	];

	for (const r of replacements) resolved = resolved.replace(r.re, r.val);
	return resolved;
}
