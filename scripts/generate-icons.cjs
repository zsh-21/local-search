const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function crc32(buf) {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i];
		for (let j = 0; j < 8; j++) {
			const mask = -(crc & 1);
			crc = (crc >>> 1) ^ (0xedb88320 & mask);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const typeBuf = Buffer.from(type, 'ascii');
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(data.length, 0);
	const crcBuf = Buffer.alloc(4);
	const crcVal = crc32(Buffer.concat([typeBuf, data]));
	crcBuf.writeUInt32BE(crcVal, 0);
	return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function pngFromRgba(width, height, rgba) {
	const rowSize = width * 4;
	const raw = Buffer.alloc((rowSize + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[(rowSize + 1) * y] = 0;
		rgba.copy(raw, (rowSize + 1) * y + 1, y * rowSize, y * rowSize + rowSize);
	}

	const compressed = zlib.deflateSync(raw, { level: 9 });

	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	return Buffer.concat([
		signature,
		chunk('IHDR', ihdr),
		chunk('IDAT', compressed),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function makeCanvas(width, height) {
	const rgba = Buffer.alloc(width * height * 4);
	return {
		width,
		height,
		rgba,
		setPixel(x, y, r, g, b, a = 255) {
			if (x < 0 || y < 0 || x >= width || y >= height) return;
			const i = (y * width + x) * 4;
			rgba[i] = r;
			rgba[i + 1] = g;
			rgba[i + 2] = b;
			rgba[i + 3] = a;
		},
		fillRect(x, y, w, h, r, g, b, a = 255) {
			for (let yy = y; yy < y + h; yy++) {
				for (let xx = x; xx < x + w; xx++) this.setPixel(xx, yy, r, g, b, a);
			}
		},
		fillCircle(cx, cy, radius, r, g, b, a = 255) {
			const r2 = radius * radius;
			for (let y = cy - radius; y <= cy + radius; y++) {
				for (let x = cx - radius; x <= cx + radius; x++) {
					const dx = x - cx;
					const dy = y - cy;
					if (dx * dx + dy * dy <= r2) this.setPixel(x, y, r, g, b, a);
				}
			}
		},
		strokeCircle(cx, cy, radius, thickness, r, g, b, a = 255) {
			const rOuter = radius + thickness / 2;
			const rInner = Math.max(0, radius - thickness / 2);
			const rOuter2 = rOuter * rOuter;
			const rInner2 = rInner * rInner;
			for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y++) {
				for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x++) {
					const dx = x - cx;
					const dy = y - cy;
					const d2 = dx * dx + dy * dy;
					if (d2 <= rOuter2 && d2 >= rInner2) this.setPixel(x, y, r, g, b, a);
				}
			}
		},
		strokeLine(x1, y1, x2, y2, thickness, r, g, b, a = 255) {
			const dx = x2 - x1;
			const dy = y2 - y1;
			const steps = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
			for (let i = 0; i <= steps; i++) {
				const t = i / steps;
				const x = Math.round(x1 + dx * t);
				const y = Math.round(y1 + dy * t);
				this.fillCircle(x, y, Math.max(1, Math.round(thickness / 2)), r, g, b, a);
			}
		},
	};
}

function drawWarehouseSearchIcon(size) {
	const c = makeCanvas(size, size);
	const u = size / 32;
	const px = (n) => Math.round(n * u);

	const bg = [30, 30, 30, 0];
	c.fillRect(0, 0, size, size, bg[0], bg[1], bg[2], bg[3]);

	const shelf = [110, 110, 110, 255];
	const shelfDark = [80, 80, 80, 255];
	const box1 = [150, 150, 150, 255];
	const box2 = [170, 170, 170, 255];

	c.fillRect(px(4), px(6), px(24), px(2), shelf[0], shelf[1], shelf[2], shelf[3]);
	c.fillRect(px(4), px(14), px(24), px(2), shelf[0], shelf[1], shelf[2], shelf[3]);
	c.fillRect(px(4), px(22), px(24), px(2), shelf[0], shelf[1], shelf[2], shelf[3]);

	c.fillRect(px(4), px(4), px(2), px(24), shelfDark[0], shelfDark[1], shelfDark[2], shelfDark[3]);
	c.fillRect(px(26), px(4), px(2), px(24), shelfDark[0], shelfDark[1], shelfDark[2], shelfDark[3]);

	const drawBox = (x, y, tone) => {
		const col = tone === 1 ? box1 : box2;
		c.fillRect(px(x), px(y), px(4), px(6), col[0], col[1], col[2], col[3]);
	};
	drawBox(8, 8, 1);
	drawBox(14, 8, 2);
	drawBox(20, 8, 1);
	drawBox(8, 16, 2);
	drawBox(20, 16, 2);

	const person = [74, 144, 226, 255];
	const personStroke = [30, 30, 30, 255];
	c.fillCircle(px(16), px(18), px(4), person[0], person[1], person[2], person[3]);
	c.strokeCircle(px(16), px(18), px(4), Math.max(1, px(1.5)), personStroke[0], personStroke[1], personStroke[2], personStroke[3]);
	c.strokeLine(px(16), px(22), px(16), px(28), Math.max(2, px(2)), person[0], person[1], person[2], person[3]);
	c.strokeLine(px(12), px(24), px(16), px(22), Math.max(2, px(2)), person[0], person[1], person[2], person[3]);
	c.strokeLine(px(20), px(24), px(16), px(22), Math.max(2, px(2)), person[0], person[1], person[2], person[3]);

	const gold = [255, 215, 0, 255];
	const goldFill = [255, 215, 0, 40];
	c.fillCircle(px(20), px(12), px(5), goldFill[0], goldFill[1], goldFill[2], goldFill[3]);
	c.strokeCircle(px(20), px(12), px(5), Math.max(2, px(2)), gold[0], gold[1], gold[2], gold[3]);
	c.strokeLine(px(24), px(16), px(28), px(20), Math.max(2, px(2)), gold[0], gold[1], gold[2], gold[3]);

	return pngFromRgba(size, size, c.rgba);
}

function writeFileSafe(filePath, content) {
	ensureDir(path.dirname(filePath));
	fs.writeFileSync(filePath, content);
}

function main() {
	const iconPng = drawWarehouseSearchIcon(256);
	const trayPng = drawWarehouseSearchIcon(64);

	writeFileSafe(path.join(ROOT, 'build', 'icon.png'), iconPng);
	writeFileSafe(path.join(ROOT, 'public', 'tray.png'), trayPng);
}

main();
